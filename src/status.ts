import * as core from "@actions/core";
import { ROBIN_SIGNATURE } from "./github-reviewer";
import { OutcomeCounts } from "./outcome";

export const STATUS_START = "<!-- robin-status -->";
export const STATUS_END = "<!-- /robin-status -->";

const short = (head: string) => `\`${head.slice(0, 7)}\``;
const oneLine = (text: string) => text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
const prefix = `**${ROBIN_SIGNATURE}:**`;

export const statusLine = {
  running: (head: string, detail = "") => `${prefix} :hourglass_flowing_sand: reviewing ${short(head)}${detail ? ` · ${oneLine(detail)}` : ""}`,
  reviewed: (head: string, counts: OutcomeCounts, url: string) =>
    `${prefix} :white_check_mark: reviewed ${short(head)}: ${counts.high} High, ${counts.medium} Medium, ${counts.low} Low · [review](${url}). Advisory; comment \`/robin\` to review again.`,
  skipped: (head: string, reason: string) => `${prefix} :white_check_mark: nothing to review at ${short(head)}: ${oneLine(reason)}`,
  failed: (head: string, reason: string) => `${prefix} :warning: could not finish ${short(head)}: ${oneLine(reason).replace(/\.$/, "")}. Comment \`/robin\` to retry.`,
  interrupted: (head: string) => `${prefix} :warning: interrupted at ${short(head)} (cancelled or timed out). Comment \`/robin\` to retry.`,
  summarizing: (head: string) => `${prefix} :hourglass_flowing_sand: summarizing ${short(head)}`,
  summarized: (head: string) => `${prefix} :white_check_mark: summary of ${short(head)} posted below.`,
};

/** Replace Robin's region in a shared status comment body, or start a body with it. */
export function withStatus(body: string | undefined, line: string): string {
  const region = `${STATUS_START}\n${line}\n${STATUS_END}`;
  if (body === undefined) return region;
  return body.slice(0, body.indexOf(STATUS_START)) + region + body.slice(body.indexOf(STATUS_END) + STATUS_END.length);
}

const ownsStatus = (comment: { body?: string | null; user?: { type?: string } | null }) =>
  comment.user?.type === "Bot" && (comment.body || "").includes(STATUS_START) && (comment.body || "").includes(STATUS_END);

/** One status comment per pull request: Robin rewrites only its region, so other tools may share the comment. */
export function statusComment(octokit: any, owner: string, repo: string, issueNumber: number) {
  return async (line: string): Promise<void> => {
    try {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: issueNumber, per_page: 100 });
      const existing = comments.find(ownsStatus);
      if (existing) await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: withStatus(existing.body, line) });
      else await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: withStatus(undefined, line) });
    } catch (error) {
      core.warning(`Could not update the Robin status comment: ${error}`);
    }
  };
}
