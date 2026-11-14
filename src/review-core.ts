import * as core from "@actions/core";
import type { LLMClient } from "./llm-client";
import { SubscriptionLimitError } from "./subscription-limit";
import { type CouncilSeat, onCouncilSeat } from "./council";
import type { GitUtils } from "./git-utils";
import { ReviewFinding, ReviewParser, StructuredReview } from "./review-parser";
import { shouldRetryStructuredReview } from "./review-retry";
import { chunkDiffByFile, splitDiffIntoFiles } from "./diff-filter";
import { annotateDiffWithLineNumbers } from "./diff-annotate";
import { PRECISION_INSTRUCTIONS, getReviewPrompt } from "./prompts/review-prompts";
import { buildFileContext } from "./review-context";
import { buildPrecisionCandidates, mergeCouncilVerdicts, retainAllCandidates, selectApprovedCandidates } from "./precision-gate";
import { buildContractSearchEvidence, changedHeadPaths, extractChangedContractQueries, wrapContractSearchEvidence } from "./contract-discovery";
import { ReviewBudget, runDiscovery } from "./discovery";
import { executeEvidenceRequests } from "./evidence-loop";
import { type CallSpan, ReviewTimings } from "./review-timing";

/** Pieces reviewed at once. Each piece holds one call per seat in flight. */
export const PIECE_CONCURRENCY = 8;

export interface ReviewCoreInput {
  git: Pick<GitUtils, "getFileContent" | "getTreePaths" | "searchPaths">;
  owner: string;
  repo: string;
  baseRef: string;
  headRef: string;
  reviewDiff: string;
  maxDiffSize: number;
  reviewInstructions: string;
  jsonResponseMode: boolean;
  llm: LLMClient;
  council?: CouncilSeat;
  loadPriorFindings: () => Promise<string>;
  timings: ReviewTimings;
}

export interface ReviewCoreResult {
  findings: StructuredReview;
  pieces: number;
  evidenceRequests: number;
  usedFollowups: number;
}

/** Diff pieces: one per file, oversized files split on hunk boundaries. */
export function reviewPieces(reviewDiff: string, maxDiffSize: number): string[] {
  return splitDiffIntoFiles(reviewDiff).flatMap(({ content }) => chunkDiffByFile(content, maxDiffSize));
}

/** Discovery on every piece, then one precision gate over all candidates. Posts nothing. */
export async function runReviewCore(input: ReviewCoreInput): Promise<ReviewCoreResult> {
  const {git, owner, repo, baseRef, headRef, reviewDiff, reviewInstructions, jsonResponseMode, llm, council, timings} = input;
  const pieces = reviewPieces(reviewDiff, input.maxDiffSize);
  const reviewedPaths = changedHeadPaths(reviewDiff);
  const reviewBudget = new ReviewBudget(Math.min(4, Math.max(1, Math.ceil(pieces.length / 2))), Date.now() + 205_000);
  const candidateReviews: StructuredReview[] = [];
  let evidenceRequests = 0;
  for (let start = 0; start < pieces.length; start += PIECE_CONCURRENCY) {
    const batch = pieces.slice(start, start + PIECE_CONCURRENCY);
    const reviews = await Promise.all(batch.map(async (piece, offset) => {
      const number = start + offset + 1;
      core.info(`Reviewing chunk ${number}/${pieces.length}...`);
      const context = await timings.time("context", () => buildFileContext(git, owner, repo, piece, baseRef, headRef), number);
      const result = await discoverPiece(llm, piece, context, reviewInstructions, jsonResponseMode,
        (requests) => timings.time("evidence", () => executeEvidenceRequests(git, owner, repo, headRef, requests), number),
        reviewBudget, timings, number, council);
      core.info(timings.pieceLine(number, pieces.length));
      return result;
    }));
    candidateReviews.push(...reviews.map(({review}) => review));
    evidenceRequests += reviews.reduce((total, review) => total + review.evidenceRequests, 0);
  }
  const priorRobinFindings = await timings.time("prior-findings", input.loadPriorFindings);
  const contractEvidence = await timings.time("contract-evidence", () => buildContractSearchEvidence(
    git, owner, repo, headRef, extractChangedContractQueries(reviewDiff), reviewedPaths,
    {counterevidence: true, reviewedPaths}
  ));
  const findings = await timings.time("final-gate", () => runFinalGate(
    llm, candidateReviews, reviewDiff, contractEvidence, priorRobinFindings, reviewInstructions, council
  ));
  return {findings, pieces: pieces.length, evidenceRequests, usedFollowups: reviewBudget.usedFollowups};
}

async function runReview(
  llm: LLMClient,
  diff: string,
  reviewInstructions: string,
  jsonResponseMode: boolean,
  context = "",
  focusInstructions = ""
) {
  const systemPrompt = getReviewPrompt(reviewInstructions);
  const userContent = [
    buildReviewInput(diff, context),
    focusInstructions && `REVIEW FOCUS:\n${focusInstructions}`,
  ].filter(Boolean).join("\n\n");
  core.info("Getting full code review...");
  return await llm.chatCompletion(systemPrompt, userContent, jsonResponseMode);
}

async function discoverPiece(
  llm: LLMClient,
  diff: string,
  context: string,
  reviewInstructions: string,
  jsonResponseMode: boolean,
  loadEvidence: Parameters<typeof runDiscovery>[1],
  budget: ReviewBudget,
  timings: ReviewTimings,
  piece: number,
  council?: CouncilSeat
): Promise<{review: StructuredReview; evidenceRequests: number; followedUp: boolean}> {
  const completeWith = (seat: LLMClient) => async (instructions: string) => {
    const response = await runReview(seat, diff, reviewInstructions, jsonResponseMode, context, instructions);
    const parsed = ReviewParser.parseDetailed(response.content);
    if (!shouldRetryStructuredReview(parsed.findings, parsed.usedJson)) return parsed.findings;
    return ReviewParser.parse((await runReview(
      seat, diff, reviewInstructions, true, context, `${instructions}\n\nReturn ONLY a single valid JSON object.`
    )).content);
  };
  const complete = completeWith(llm);
  // A lost council seat must not cost the pass: the primary seat runs it instead.
  const councilComplete = council && (async (instructions: string) => {
    try {
      return await onCouncilSeat(council, (seat) => completeWith(seat)(instructions));
    } catch (error) {
      if (error instanceof SubscriptionLimitError) throw error;
      council.discoveryFallbacks += 1;
      core.warning(`Council seat ${council.model} failed discovery; primary seat ran the pass: ${error}`);
      return complete(instructions);
    }
  });
  return runDiscovery(complete, loadEvidence, budget, councilComplete, (stage, run) => timings.time(stage, run, piece));
}

async function runFinalGate(
  llm: LLMClient,
  reviews: StructuredReview[],
  diff: string,
  contractEvidence: string,
  priorRobinFindings: string,
  reviewInstructions: string,
  council?: CouncilSeat
): Promise<StructuredReview> {
  const candidates = buildPrecisionCandidates(reviews);
  const summary = "";
  if (candidates.length === 0) {
    if (council) council.gateVoted = true;
    return {summary, high: [], medium: [], low: [], suggestions: [], rawResponse: ""};
  }
  const precisionPrompt = [reviewInstructions, PRECISION_INSTRUCTIONS].filter(Boolean).join("\n\n");
  const precisionInput = [
    "CANDIDATES:",
    JSON.stringify(candidates),
    contractEvidence && `EXACT-HEAD REPOSITORY EVIDENCE:\n${wrapContractSearchEvidence(contractEvidence)}`,
    priorRobinFindings && `PRIOR ROBIN FINDINGS (keep only if still present):\n${priorRobinFindings}`,
    `CANDIDATE DIFF EVIDENCE:\n${buildCandidateDiffEvidence(diff, candidates.map(({finding}) => finding))}`,
  ].filter(Boolean).join("\n\n");
  // A council seat that cannot vote leaves the primary verdict standing.
  const councilVote = council && (async () => {
    try {
      const vote = await onCouncilSeat(council, (seat) => seat.chatCompletion(precisionPrompt, precisionInput, true));
      return selectApprovedCandidates(candidates, vote.content, summary);
    } catch (error) {
      if (error instanceof SubscriptionLimitError) throw error;
      core.warning(`Council seat ${council.model} could not vote: ${error}`);
      return undefined;
    }
  })();
  // Attach both rejection handlers immediately: a quota refusal from one seat
  // must not become an unhandled rejection while the other is still working.
  const [firstVerdict, vote] = await Promise.all([
    llm.chatCompletion(precisionPrompt, precisionInput, true), councilVote,
  ]);
  let verdict = firstVerdict;
  let precise: StructuredReview;
  try {
    precise = selectApprovedCandidates(candidates, verdict.content, summary);
  } catch {
    try {
      verdict = await llm.chatCompletion(`${precisionPrompt}\n\nYour prior response was invalid. Return only the required JSON object.`, precisionInput, true);
      precise = selectApprovedCandidates(candidates, verdict.content, summary);
    } catch (error) {
      if (error instanceof SubscriptionLimitError) throw error;
      core.warning(`Precision gate failed twice; retaining every candidate: ${error}`);
      precise = retainAllCandidates(candidates, summary, verdict.content);
    }
  }
  if (council && vote) {
    const merged = mergeCouncilVerdicts(precise, vote);
    precise = merged.review;
    council.splitVerdicts = merged.splitVerdicts;
    council.gateVoted = true;
  }

  deduplicateFindings(precise);
  return precise;
}

function buildCandidateDiffEvidence(diff: string, findings: ReviewFinding[]): string {
  if (diff.length <= 120000) return diff;
  const paths = new Set(findings.map(({file}) => file).filter((path): path is string => Boolean(path)));
  const chunks = splitDiffIntoFiles(diff)
    .filter(({path}) => paths.has(path))
    .map(({content}) => content.length > 20000 ? `${content.slice(0, 20000)}\n[... truncated ...]` : content);
  return chunks.join("\n").slice(0, 120000);
}

function deduplicateFindings(review: StructuredReview): void {
  const seen = new Set<string>();
  for (const severity of ["high", "medium", "low", "suggestions"] as const) {
    review[severity] = review[severity].filter((finding: ReviewFinding) => {
      const key = `${finding.file || ""}:${finding.line || 0}:${finding.description.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").slice(0, 12).join(" ")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

function buildReviewInput(diff: string, context = ""): string {
  const annotated = annotateDiffWithLineNumbers(diff);
  const input = [
    "Review the following code diff and return only the strict JSON object described in the system prompt.",
    "Each line is prefixed with its line number in the NEW file (blank for removed lines and headers).",
    "For any line-specific finding, copy that exact number into the `line` field. Do not guess or recount.",
    "---",
    "CODE DIFF:",
    "```diff",
    annotated,
    "```",
  ];
  if (context) {
    input.push(
      "UNCHANGED BASE/HEAD FILE CONTEXT (evidence only; anchor comments to changed lines):",
      "```",
      context,
      "```"
    );
  }
  return input.join("\n");
}

/** Every seat that took calls, including a council seat replaced by its fallback. */
export function seatCalls(llm: LLMClient, model: string, council?: CouncilSeat): Array<{model: string; calls: CallSpan[]}> {
  return [
    {model, calls: llm.calls},
    ...(council?.substitutedFor ? [{model: council.substitutedFor.model, calls: council.substitutedFor.llm.calls}] : []),
    ...(council ? [{model: council.model, calls: council.llm.calls}] : []),
  ];
}
