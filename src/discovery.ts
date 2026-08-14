import { ADVERSARIAL_INSTRUCTIONS, DISCOVERY_INSTRUCTIONS } from "./prompts/review-prompts";
import { buildPrecisionCandidates } from "./precision-gate";
import { EvidenceRequest } from "./evidence-loop";
import { StructuredReview } from "./review-parser";

export class ReviewBudget {
  private followups = 0;

  constructor(private readonly maxFollowups: number, private readonly lastStartAt: number) {}

  claimFollowup(now = Date.now()): boolean {
    if (this.followups >= this.maxFollowups || now >= this.lastStartAt) return false;
    this.followups += 1;
    return true;
  }

  get usedFollowups(): number {
    return this.followups;
  }
}

export async function runDiscovery(
  complete: (instructions: string) => Promise<StructuredReview>,
  loadEvidence: (requests: EvidenceRequest[]) => Promise<string>,
  budget: ReviewBudget
): Promise<{review: StructuredReview; evidenceRequests: number; followedUp: boolean}> {
  // Serial order is deliberate: the adversarial call reuses the broad call's stable prompt cache prefix.
  const broad = await complete(DISCOVERY_INSTRUCTIONS);
  const adversarial = await complete(ADVERSARIAL_INSTRUCTIONS);
  const initial = combine([broad, adversarial]);
  const requests = [...(broad.evidenceRequests || []), ...(adversarial.evidenceRequests || [])].slice(0, 4);
  if (requests.length === 0) {
    return {review: initial, evidenceRequests: requests.length, followedUp: false};
  }
  const evidence = await loadEvidence(requests);
  if (!evidence || !budget.claimFollowup()) return {review: initial, evidenceRequests: requests.length, followedUp: false};
  const followup = await complete([
    "EVIDENCE FOLLOW-UP: Re-evaluate the initial candidates against the exact-head evidence below.",
    "Keep every still-proven root cause, reject disproven candidates, and add newly proven roots. Request no further evidence.",
    `INITIAL CANDIDATES:\n${JSON.stringify(buildPrecisionCandidates([initial]))}`,
    evidence,
  ].join("\n\n"));
  return {review: combine([initial, followup]), evidenceRequests: requests.length, followedUp: true};
}

function combine(reviews: StructuredReview[]): StructuredReview {
  const candidates = buildPrecisionCandidates(reviews);
  const combined: StructuredReview = {
    summary: reviews.map(({summary}) => summary).filter(Boolean).join("\n"),
    high: [], medium: [], low: [], suggestions: [], evidenceRequests: [], rawResponse: "",
  };
  for (const {severity, finding} of candidates) combined[severity].push(finding);
  return combined;
}
