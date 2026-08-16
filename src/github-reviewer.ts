import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { StructuredReview, ReviewFinding } from "./review-parser";

/** Marker present in every Robin review body; used to recognize Robin's own reviews. */
export const ROBIN_SIGNATURE = ":bow_and_arrow: Robin";

/** HTML-comment marker carrying the content address of the reviewed diff. */
const REVIEW_KEY_MARKER = "robin-review-key";
const REVIEW_KEY_PATTERN = new RegExp(
  `<!--\\s*${REVIEW_KEY_MARKER}:\\s*([0-9a-f]{64})\\s+(APPROVE|REQUEST_CHANGES|COMMENT)\\s*-->`
);

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * Content address of everything that determines a verdict.
 *
 * A rebase onto a moved main dismisses Robin's approval but usually leaves the
 * reviewed diff byte-identical, so the model would be asked to re-derive a
 * verdict from inputs it has already seen. Hashing the prompts and model
 * alongside the diff means any prompt, model, or repo-instruction edit
 * invalidates the key automatically — there is no cache version to remember to
 * bump.
 */
export function reviewKey(parts: {
  model: string;
  systemPrompt: string;
  precisionPrompt: string;
  gatekeeper: boolean;
  diff: string;
}): string {
  return createHash("sha256")
    .update(
      [
        parts.model,
        parts.systemPrompt,
        parts.precisionPrompt,
        String(parts.gatekeeper),
        parts.diff,
      ].join("\0")
    )
    .digest("hex");
}

export function cacheMarker(key: string, event: ReviewEvent): string {
  return `<!-- ${REVIEW_KEY_MARKER}: ${key} ${event} -->`;
}

export interface CachedVerdict {
  event: ReviewEvent;
  body: string;
}

/**
 * Find a previous Robin review of this exact content.
 *
 * Deliberately does NOT filter on review state: `dismiss_stale_reviews` marks
 * the reviews we most want to reuse as DISMISSED. The author check is a trust
 * boundary, not a nicety — without it a collaborator could paste a marker into
 * their own review body and have Robin post a genuine bot APPROVE, defeating
 * `require_last_push_approval`.
 */
export function findCachedVerdict(
  reviews: Array<{
    body?: string | null;
    user?: { login?: string; type?: string } | null;
  }>,
  key: string
): CachedVerdict | null {
  for (let i = reviews.length - 1; i >= 0; i--) {
    const review = reviews[i];
    if (review.user?.type !== "Bot") continue;
    if (review.user?.login !== "github-actions[bot]") continue;
    const body = review.body || "";
    if (!body.includes(ROBIN_SIGNATURE)) continue;
    const match = REVIEW_KEY_PATTERN.exec(body);
    if (!match || match[1] !== key) continue;
    return { event: match[2] as ReviewEvent, body };
  }
  return null;
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
    message: string
  ): Promise<void> {
    const { data: review } = await this.octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: "REQUEST_CHANGES",
      body: [
        "## " + ROBIN_SIGNATURE,
        "",
        "Robin could not complete this review, so this head is blocked fail-closed.",
        "",
        `\`${message}\``,
        "",
        "Re-run Robin after the transient failure is resolved.",
      ].join("\n"),
    });
    await this.dismissStaleRobinReviews(owner, repo, pullNumber, review.id);
  }

  /** Gatekeeper mode blocks only High findings; lower severities stay advisory. */
  static resolveReviewEvent(hasHigh: boolean, requestChanges: boolean): "REQUEST_CHANGES" | "APPROVE" | "COMMENT" {
    if (!requestChanges) return "COMMENT";
    if (hasHigh) return "REQUEST_CHANGES";
    return "APPROVE";
  }

  /** A prior Robin CHANGES_REQUESTED review that a newly posted review supersedes. */
  static isStaleRobinReview(
    review: { id: number; state?: string; body?: string | null; user?: { type?: string } | null },
    newReviewId: number
  ): boolean {
    return (
      review.id !== newReviewId &&
      review.state === "CHANGES_REQUESTED" &&
      review.user?.type === "Bot" &&
      (review.body || "").includes(ROBIN_SIGNATURE) &&
      !GitHubReviewer.hasUnpostedHighFinding(review.body || "")
    );
  }

  static hasUnpostedHighFinding(body: string): boolean {
    const section = body.split("### :page_facing_up: Findings Not Posted Inline", 2)[1];
    return section?.includes(":rotating_light:") ?? false;
  }

  /**
   * Dismiss superseded Robin CHANGES_REQUESTED reviews, except reviews with a
   * body-only High that has no resolvable thread and must remain fail-closed.
   */
  private async dismissStaleRobinReviews(
    owner: string,
    repo: string,
    pullNumber: number,
    newReviewId: number
  ): Promise<void> {
    try {
      const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });

      for (const review of reviews) {
        if (!GitHubReviewer.isStaleRobinReview(review, newReviewId)) continue;
        try {
          await this.octokit.rest.pulls.dismissReview({
            owner,
            repo,
            pull_number: pullNumber,
            review_id: review.id,
            message: "Superseded by a newer Robin review.",
          });
          core.info("Dismissed stale Robin review #" + review.id);
        } catch (error) {
          core.warning("Could not dismiss stale Robin review #" + review.id + ": " + error);
        }
      }
    } catch (error) {
      core.warning("Could not check for stale Robin reviews: " + error);
    }
  }

  /**
   * Re-post a verdict already derived from byte-identical inputs.
   *
   * Body-only, with ZERO inline comments, and that constraint is the safety
   * argument rather than a caveat on it. Re-mapping the original findings onto
   * the new head would duplicate every thread on each rebase and un-resolve
   * findings the author already fixed, so it is deliberately not done. Nothing
   * here touches `required_conversation_resolution`.
   *
   * The prior body is reused verbatim so the `Findings Not Posted Inline`
   * section survives — `isStaleRobinReview` keys on it to stay fail-closed on a
   * body-only High — and so the marker and ROBIN_SIGNATURE come along for free.
   */
  async postCachedReview(
    owner: string,
    repo: string,
    pullNumber: number,
    cached: CachedVerdict
  ): Promise<void> {
    const body = [
      "> Reused a prior review: this head's diff is byte-identical to one already",
      "> reviewed on this pull request, so no model call was made. Edit or delete",
      "> that review's body to force a full re-review.",
      "",
      cached.body,
    ].join("\n");

    const { data: review } = await this.octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      body,
      event: cached.event,
    });

    core.info(
      "Reused cached " + cached.event + " verdict as review #" + review.id + " (0 model calls)"
    );

    await this.dismissStaleRobinReviews(owner, repo, pullNumber, review.id);
  }

  async postReview(
    owner: string,
    repo: string,
    pullNumber: number,
    findings: StructuredReview,
    requestChanges = true,
    cacheKey?: string
  ): Promise<void> {
    try {
      core.info("Posting review to PR #" + pullNumber + "...");

      // Fetch file patches to map line positions
      const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });

      // Build line-level comments from findings
      const { comments, postedFindings } = this.buildReviewComments(findings, files);

      // Determine review event type
      const event = GitHubReviewer.resolveReviewEvent(
        findings.high.length > 0,
        requestChanges
      );

      // Build the review summary body (high-level). The cache marker must be
      // stamped on BOTH createReview calls below; missing the fallback would
      // silently make those reviews unreusable.
      const stamp = cacheKey ? "\n\n" + cacheMarker(cacheKey, event) : "";
      const body = this.buildReviewBody(findings, postedFindings) + stamp;
      
      let review;
      let postedInlineComments = comments.length;
      try {
        const response = await this.octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          body,
          event,
          comments,
        });
        review = response.data;
      } catch (error) {
        if (!this.shouldRetryWithoutInlineComments(error) || comments.length === 0) {
          throw error;
        }

        core.warning(
          "GitHub rejected one or more inline comments; posting summary review without inline comments."
        );
        const response = await this.octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          // The failed review is not created, so include every finding in the fallback body.
          body: this.buildReviewBody(findings, new Set()) + stamp,
          event,
        });
        review = response.data;
        postedInlineComments = 0;
      }

      core.info(
        "Posted review #" + review.id + " with " + postedInlineComments + " individual line comments"
      );

      await this.dismissStaleRobinReviews(owner, repo, pullNumber, review.id);

    } catch (error) {
      core.error("Failed to post review: " + error);
      throw error;
    }
  }

  /**
   * Build separate line-level comments for each finding that can be mapped to a line.
   * Each comment appears as an individual thread the repo owner can reply to and resolve.
   */
  private buildReviewComments(
    findings: StructuredReview,
    files: any[]
  ): { comments: any[]; postedFindings: Set<ReviewFinding> } {
    const comments: any[] = [];
    const postedFindings = new Set<ReviewFinding>();

    // Combine all findings
    const allFindings = [
      ...findings.high,
      ...findings.medium,
      ...findings.low,
      ...findings.suggestions,
    ];

    for (const finding of allFindings) {
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
