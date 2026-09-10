/**
 * Machine-readable outcome marker stamped on every terminal Robin review body.
 *
 * A consumer asking "did Robin finish on this exact head?" cannot answer it from
 * a review's prose, its state, or the status comment (which has no head
 * binding). The marker binds a coverage value and the finding counts to a
 * specific 40-hex head, so "incomplete" and "skipped" are distinguishable from
 * "not posted yet" without inferring anything from the review verdict.
 *
 * The regex is duplicated verbatim in `bin/robin-pr.js`; keep the two identical.
 */

export type ReviewOutcome = "reviewed" | "reused" | "skipped" | "incomplete";

export interface OutcomeCounts {
  high: number;
  medium: number;
  low: number;
  suggestions: number;
}

export interface OutcomeMarker {
  outcome: ReviewOutcome;
  head: string;
  /** null when the marker carries no counts (a pre-marker body reused at a new head). */
  counts: OutcomeCounts | null;
}

export const ZERO_COUNTS: OutcomeCounts = {high: 0, medium: 0, low: 0, suggestions: 0};

/** Shared with `bin/robin-pr.js`. Global: a body may carry several markers. */
export const OUTCOME_MARKER_PATTERN =
  /<!--\s*robin-outcome:\s*v1\s+(reviewed|reused|skipped|incomplete)\s+head=([0-9a-f]{40})(?:\s+high=(\d+)\s+medium=(\d+)\s+low=(\d+)\s+suggestions=(\d+))?\s*-->/g;

export function buildOutcomeMarker(
  outcome: ReviewOutcome,
  head: string,
  counts?: OutcomeCounts | null
): string {
  const tail = counts
    ? ` high=${counts.high} medium=${counts.medium} low=${counts.low} suggestions=${counts.suggestions}`
    : "";
  return `<!-- robin-outcome: v1 ${outcome} head=${head}${tail} -->`;
}

/** Append a marker to a body. The last marker in a body wins, so re-stamping a reused body is safe. */
export function appendOutcomeMarker(
  body: string,
  outcome: ReviewOutcome,
  head: string,
  counts?: OutcomeCounts | null
): string {
  return `${body}\n\n${buildOutcomeMarker(outcome, head, counts)}`;
}

/** The last marker in the body, or null when there is none. */
export function parseOutcomeMarker(body: string): OutcomeMarker | null {
  const pattern = new RegExp(OUTCOME_MARKER_PATTERN.source, "g");
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body || "")) !== null) {
    last = match;
  }
  if (!last) return null;
  const counts = last[3] === undefined
    ? null
    : {
      high: Number(last[3]),
      medium: Number(last[4]),
      low: Number(last[5]),
      suggestions: Number(last[6]),
    };
  return {outcome: last[1] as ReviewOutcome, head: last[2], counts};
}
