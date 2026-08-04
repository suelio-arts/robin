import { ReviewFinding, StructuredReview } from "./review-parser";

const SEVERITIES = ["high", "medium", "low", "suggestions"] as const;
type Severity = typeof SEVERITIES[number];

export type PrecisionCandidate = {
  id: string;
  severity: Severity;
  finding: ReviewFinding;
};

export function buildPrecisionCandidates(reviews: StructuredReview[]): PrecisionCandidate[] {
  const candidates: PrecisionCandidate[] = [];
  const seen = new Set<string>();

  for (const review of reviews) {
    for (const severity of SEVERITIES) {
      for (const finding of review[severity]) {
        const root = finding.description.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const key = `${finding.file}:${finding.line ?? 0}:${severity}:${root}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ id: `c${candidates.length + 1}`, severity, finding });
      }
    }
  }
  return candidates;
}

export function selectApprovedCandidates(
  candidates: PrecisionCandidate[],
  response: string
): StructuredReview {
  const json = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(json) as { approved?: unknown };
  if (!Array.isArray(parsed.approved) || !parsed.approved.every((id) => typeof id === "string")) {
    throw new Error("Precision gate response must contain an approved string array");
  }

  const approved = new Set(parsed.approved);
  const result: StructuredReview = {
    summary: "Evidence-verified review findings.",
    high: [],
    medium: [],
    low: [],
    suggestions: [],
    rawResponse: response,
  };
  for (const candidate of candidates) {
    if (approved.has(candidate.id)) result[candidate.severity].push(candidate.finding);
  }
  return result;
}
