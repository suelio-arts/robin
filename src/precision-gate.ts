import { ReviewFinding, StructuredReview } from "./review-parser";

const SEVERITIES = ["high", "medium", "low", "suggestions"] as const;
type Severity = typeof SEVERITIES[number];

export type PrecisionCandidate = {
  id: string;
  severity: Severity;
  finding: ReviewFinding;
};

export function buildPrecisionCandidates(reviews: Partial<StructuredReview>[]): PrecisionCandidate[] {
  const candidates: PrecisionCandidate[] = [];
  const seen = new Set<string>();

  for (const review of reviews) {
    for (const severity of SEVERITIES) {
      const findings = review[severity];
      if (!Array.isArray(findings)) continue;
      for (const finding of findings) {
        if (!finding || typeof finding !== "object" || typeof finding.description !== "string") continue;
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
  response: string,
  summary = ""
): StructuredReview {
  const json = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(json) as { approved?: unknown; rejected?: unknown };
  if (!Array.isArray(parsed.approved) || !parsed.approved.every((id) => typeof id === "string")) {
    throw new Error("Precision gate response must contain an approved string array");
  }
  if (!parsed.rejected || typeof parsed.rejected !== "object" || Array.isArray(parsed.rejected)
    || !Object.values(parsed.rejected).every((reason) => typeof reason === "string")) {
    throw new Error("Precision gate response must contain a rejected reason object");
  }

  const approved = new Set(parsed.approved);
  const rejected = Object.keys(parsed.rejected);
  const dispositions = [...parsed.approved, ...rejected];
  const candidateIds = new Set(candidates.map(({ id }) => id));
  if (new Set(dispositions).size !== dispositions.length
    || dispositions.some((id) => !candidateIds.has(id))
    || dispositions.length !== candidateIds.size) {
    throw new Error("Precision gate must disposition every candidate ID exactly once");
  }
  const result: StructuredReview = {
    summary,
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
