import { ROBIN_SIGNATURE } from "./github-reviewer";
import { hasFixPassMarker, parseOutcomeMarker } from "./outcome";

/** After this many reviewed heads Robin stops reviewing; one fix-only pass may still confirm the fix for its last High findings. */
export const MAX_REVIEW_ROUNDS = 3;

type Review = { id: number; body?: string | null; user?: { login?: string; type?: string } | null };
type Comment = { pull_request_review_id?: number | null; path?: string; line?: number | null; original_line?: number | null; body?: string };

export type ReviewPass =
  | { kind: "full" }
  | { kind: "fix"; since: string; highs: string[]; diff: string }
  | { kind: "capped"; reason: string };

const isRobin = (review: Review): boolean =>
  review.user?.login === "github-actions[bot]" && review.user?.type === "Bot" && (review.body || "").includes(ROBIN_SIGNATURE);

function bodyOnlyHighs(body: string): string[] {
  const section = body.split("### :page_facing_up: Findings Not Posted Inline", 2)[1]?.split("\n---", 1)[0] ?? "";
  return section.split("\n\n").map((entry) => entry.trim()).filter((entry) => entry.startsWith(":rotating_light:"));
}

/**
 * The one decision on how far Robin reviews this head. Below the round cap it
 * reviews the whole change. At the cap it allows a single fix-only pass over
 * the author's own commits since its last reviewed head, and only when merges
 * among them are clean automatic merges and its last review raised a High
 * finding to fix. Anything else is capped: Robin posts nothing and a
 * maintainer approves.
 */
export async function reviewPass(
  reviews: Review[],
  head: string,
  authorDiff: (since: string, head: string) => Promise<string | undefined>,
  loadComments: () => Promise<Comment[]>
): Promise<ReviewPass> {
  const reviewed = reviews.filter(isRobin).flatMap((review) => {
    const marker = parseOutcomeMarker(review.body || "");
    return marker?.outcome === "reviewed" ? [{ review, head: marker.head }] : [];
  });
  if (new Set(reviewed.map((entry) => entry.head)).size < MAX_REVIEW_ROUNDS) return { kind: "full" };
  if (reviews.some((review) => isRobin(review) && hasFixPassMarker(review.body || "")))
    return { kind: "capped", reason: "Robin already ran its fix-only pass on this pull request." };
  const last = reviewed[reviewed.length - 1];
  if (last.head === head) return { kind: "capped", reason: "Nothing changed since Robin's last review." };
  const diff = await authorDiff(last.head, head);
  if (diff === undefined)
    return { kind: "capped", reason: `The change since ${last.head.slice(0, 7)} rewrites history or resolves a merge by hand, so it is more than a fix.` };
  if (!diff.trim()) return { kind: "capped", reason: "Only merges changed since Robin's last review." };
  const threads = (await loadComments())
    .filter((comment) => comment.pull_request_review_id === last.review.id && /^\*\*Robin\*\*[^\n]*:rotating_light: HIGH/.test(comment.body || ""))
    .map((comment) => `${comment.path}:${comment.line ?? comment.original_line ?? 0}: ${comment.body}`);
  const highs = [...threads, ...bodyOnlyHighs(last.review.body || "")];
  if (highs.length === 0) return { kind: "capped", reason: "Robin's last review raised no High finding to fix." };
  return { kind: "fix", since: last.head, highs, diff };
}

export function fixPassInstructions(pass: { since: string; highs: string[] }): string {
  return [
    `FIX-ONLY SECOND PASS. You have reviewed this pull request ${MAX_REVIEW_ROUNDS} times. The diff is only the author's commits since your last reviewed head ${pass.since}; clean merges of other branches are left out.`,
    "Your last review raised these High findings:",
    ...pass.highs.map((high, index) => `${index + 1}. ${high}`),
    "Confirm or reject the fix. Report one HIGH finding, anchored to a changed line, for each listed finding this diff does not fix, and for each change in this diff that is not needed to fix them. Report nothing else.",
  ].join("\n");
}
