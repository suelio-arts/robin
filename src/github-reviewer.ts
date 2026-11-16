import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import { StructuredReview, ReviewFinding } from "./review-parser";
import { OutcomeCounts, ZERO_COUNTS, appendOutcomeMarker, buildOutcomeMarker } from "./outcome";

/** Marker present in every Robin review body; used to recognize Robin's own reviews. */
export const ROBIN_SIGNATURE = ":bow_and_arrow: Robin";

/** What a terminal post returns so the caller can emit a receipt. */
export interface PostedReview {
  id: number;
  url: string;
  counts: OutcomeCounts;
}

export class GitHubReviewer {
  private octokit: Octokit;
  private maxComments: number;

  constructor(octokit: Octokit, maxComments = 25) {
    this.octokit = octokit;
    this.maxComments = Number.isFinite(maxComments) ? Math.max(0, maxComments) : 25;
  }

  async postFailureReview(
    owner: string,
    repo: string,
    pullNumber: number,
    message: string,
    headSha: string
  ): Promise<PostedReview> {
    const { data: review } = await this.octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: "COMMENT",
      commit_id: headSha,
      body: appendOutcomeMarker(
        [
          "## " + ROBIN_SIGNATURE,
          "",
          "Robin could not complete this review. This head was not reviewed.",
          "",
          `\`${message}\``,
          "",
          "Comment `/robin` to retry.",
        ].join("\n"),
        "incomplete",
        headSha,
        ZERO_COUNTS
      ),
    });
    return {id: review.id, url: review.html_url, counts: ZERO_COUNTS};
  }

  /**
   * Receipt for a head with nothing reviewable (whitespace-only, every path
   * filtered, or an empty diff).
   *
   * The status comment already says this, but a status comment is an issue
   * comment with no head binding: a consumer polling for coverage of head H
   * cannot tell "skipped" from "not posted yet" and waits to its timeout.
   */
  async postSkippedReview(
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
    reason: string
  ): Promise<PostedReview> {
    const { data: review } = await this.octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: "COMMENT",
      commit_id: headSha,
      body: appendOutcomeMarker(
        [
          "## " + ROBIN_SIGNATURE,
          "",
          "Nothing to review at this head.",
          "",
          `Reason: ${reason}`,
        ].join("\n"),
        "skipped",
        headSha,
        ZERO_COUNTS
      ),
    });
    return {id: review.id, url: review.html_url, counts: ZERO_COUNTS};
  }

  async postReview(
    owner: string,
    repo: string,
    pullNumber: number,
    findings: StructuredReview,
    headSha: string
  ): Promise<PostedReview> {
    core.info("Posting review to PR #" + pullNumber + "...");
    const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    const counts: OutcomeCounts = {
      high: findings.high.length,
      medium: findings.medium.length,
      low: findings.low.length,
      suggestions: findings.suggestions.length,
    };
    const submit = async (comments: any[], postedFindings: Set<ReviewFinding>) => {
      const body = this.buildReviewBody(findings, postedFindings) + "\n\n" + buildOutcomeMarker("reviewed", headSha, counts);
      const { data } = await this.octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        body,
        event: "COMMENT",
        commit_id: headSha,
        comments,
      });
      return { review: data, inline: comments.length };
    };

    const { comments, postedFindings } = this.buildReviewComments(findings, files);
    let posted;
    try {
      posted = await submit(comments, postedFindings);
    } catch (error) {
      if (!this.shouldRetryWithoutInlineComments(error) || comments.length === 0) throw error;
      core.warning("GitHub rejected one or more inline comments; posting summary review without inline comments.");
      posted = await submit([], new Set());
    }
    core.info("Posted review #" + posted.review.id + " with " + posted.inline + " inline High findings");
    return {id: posted.review.id, url: posted.review.html_url, counts};
  }

  /**
   * Build one line-level comment per High finding that maps to a diff line.
   * Each High becomes a thread; Medium, Low and suggestions stay in the
   * review body.
   */
  private buildReviewComments(
    findings: StructuredReview,
    files: any[]
  ): { comments: any[]; postedFindings: Set<ReviewFinding> } {
    const comments: any[] = [];
    const postedFindings = new Set<ReviewFinding>();

    for (const finding of findings.high) {
      if (comments.length >= this.maxComments) {
        core.info(`Reached max-comments limit (${this.maxComments}); remaining findings will stay in the review body.`);
        break;
      }

      // Need both file and line to post a line comment
      if (!finding.file || !finding.line) continue;

      const diffFile = files.find((f: any) => f.filename === finding.file);
      if (!diffFile) {
        core.warning("Could not find diff for file: " + finding.file);
        continue;
      }

      if (!this.isLineInNewDiff(diffFile.patch || "", finding.line)) {
        core.warning(
          "Could not find line " + finding.line + " in diff for file: " + finding.file
        );
        continue;
      }

      const commentBody = this.formatCommentBody(finding);

      comments.push({
        path: finding.file,
        line: finding.line,
        side: "RIGHT",
        body: commentBody,
      });
      postedFindings.add(finding);
    }

    return { comments, postedFindings };
  }

  private formatCommentBody(finding: ReviewFinding): string {
    const severityEmoji =
      finding.severity === "high"
        ? ":rotating_light: HIGH"
        : finding.severity === "medium"
        ? ":warning: MEDIUM"
        : finding.severity === "low"
        ? ":large_blue_circle: LOW"
        : ":bulb: SUGGESTION";

    const confidence = finding.confidence ? " · confidence: " + finding.confidence : "";
    let body = "**Robin** — " + severityEmoji + confidence + "\n\n" + finding.description;

    if (finding.recommendation) {
      body += "\n\n**Recommendation:** " + finding.recommendation;
    }

    if (finding.codeSnippet) {
      body += "\n\n```\n" + finding.codeSnippet + "\n```";
    }

    return body;
  }

  private shouldRetryWithoutInlineComments(error: unknown): boolean {
    const candidate = error as {
      status?: number;
      message?: string;
      response?: {
        data?: {
          message?: string;
          errors?: Array<{ message?: string; code?: string; field?: string }>;
        };
      };
    };

    if (candidate.status !== 422) return false;

    const details = [
      candidate.message,
      candidate.response?.data?.message,
      ...(candidate.response?.data?.errors || []).flatMap((item) => [
        item.message,
        item.code,
        item.field,
      ]),
    ].filter(Boolean).join(" ");

    return /position|line|side|diff/i.test(details);
  }

  /**
   * Build a concise summary body. Findings are shown here ONLY if they
   * could not be mapped to individual line comments.
   */
  private buildReviewBody(findings: StructuredReview, postedFindings: Set<ReviewFinding>): string {
    const parts: string[] = [];

    parts.push("## " + ROBIN_SIGNATURE);
    parts.push("");
    parts.push(
      "> **Heads up:** this is a point-in-time review. Push fixes freely, then comment `/robin` whenever you want another pass."
    );
    parts.push("");

    // Stats summary
    const statBlocks: string[] = [];
    if (findings.high.length > 0) {
      statBlocks.push(":rotating_light: **" + findings.high.length + " High**");
    }
    if (findings.medium.length > 0) {
      statBlocks.push(":warning: **" + findings.medium.length + " Medium**");
    }
    if (findings.low.length > 0) {
      statBlocks.push(":large_blue_circle: **" + findings.low.length + " Low**");
    }
    if (findings.suggestions.length > 0) {
      statBlocks.push(":bulb: **" + findings.suggestions.length + " Suggestions**");
    }
    if (statBlocks.length === 0) {
      statBlocks.push(":white_check_mark: **No issues found**");
    }
    parts.push(statBlocks.join(" | "));

    // Overall summary from the model
    if (findings.summary) {
      parts.push("");
      parts.push("### Summary");
      parts.push(findings.summary);
    }

    // Add findings that were not posted inline because they had no line, mapping failed,
    // or the max-comments limit was reached.
    const unpostedFindings = [
      ...findings.high,
      ...findings.medium,
      ...findings.low,
      ...findings.suggestions,
    ].filter((f) => !postedFindings.has(f));

    if (unpostedFindings.length > 0) {
      parts.push("");
      parts.push("---");
      parts.push("### :page_facing_up: Findings Not Posted Inline");
      for (let i = 0; i < unpostedFindings.length; i++) {
        parts.push("");
        parts.push(this.formatUnpostedFinding(i + 1, unpostedFindings[i]));
      }
    }

    parts.push("");
    parts.push("---");
    parts.push(
      "*[Robin](https://robinreview.dev) — the Robin Hood of code review. Free for every PR.*"
    );

    return parts.join("\n");
  }

  private formatUnpostedFinding(index: number, finding: ReviewFinding): string {
    const line = finding.line ? ":" + finding.line : "";
    const location = finding.file ? " (`" + finding.file + line + "`)" : "";
    let result =
      finding.severity === "high"
        ? ":rotating_light:"
        : finding.severity === "medium"
        ? ":warning:"
        : finding.severity === "low"
        ? ":large_blue_circle:"
        : ":bulb:";
    result += " **" + index + location + "** — " + finding.description;

    if (finding.recommendation) {
      result += "\n> " + finding.recommendation;
    }
    return result;
  }

  /**
   * Check whether a new-file line number is present in the diff.
   * GitHub only accepts review comments on lines included in the PR diff.
   */
  private isLineInNewDiff(patch: string, targetLine: number): boolean {
    if (!patch) return false;

    let currentLine = 0;
    let inHunk = false;

    for (const line of patch.split("\n")) {
      // Hunk header: parse the starting line number in the NEW file
      if (line.startsWith("@@")) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          // +N is the first line of this hunk in the new file
          currentLine = parseInt(match[1], 10);
        }
        inHunk = true;
        continue;
      }

      if (!inHunk) {
        // Lines before the first hunk (shouldn't happen in patch)
        continue;
      }

      if (line.startsWith("\\")) {
        continue;
      }

      if (line.startsWith("+")) {
        // Added line exists in the new file
        if (currentLine === targetLine) {
          return true;
        }
        currentLine++;
      } else if (line.startsWith("-")) {
        // Removed line — does not exist in new file, keep position but don't count line
      } else {
        // Context line — exists in both old and new file
        if (currentLine === targetLine) {
          return true;
        }
        currentLine++;
      }
    }

    return false;
  }
}

/** Prior Robin findings, minus any whose thread a human has resolved. */
export function formatPriorFindings(
  comments: Array<{id: number; path?: string; line?: number | null; body?: string; pull_request_review_id?: number | null}>,
  robinReviewIds: Set<number>,
  resolvedCommentIds: Set<number>
): string {
  return comments
    .filter(({pull_request_review_id: id}) => id !== null && id !== undefined && robinReviewIds.has(id))
    .filter(({id}) => !resolvedCommentIds.has(id))
    .map(({path, line, body}) => `${path}:${line || 0}: ${body}`)
    .join("\n\n")
    .slice(-30000);
}
