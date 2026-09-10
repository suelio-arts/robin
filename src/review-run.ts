import * as core from "@actions/core";
import { GitHubReviewer, PostedReview, ReviewVerdict } from "./github-reviewer";
import { validateExpectedHeadSha } from "./events";
import { LOCAL_AGENT_CALLERS, LocalAgentCaller } from "./llm-client";
import { OutcomeCounts, ReviewOutcome, ZERO_COUNTS } from "./outcome";

/**
 * Terminal-outcome orchestration, extracted from `src/main.ts` because that
 * module calls `run()` at import time and cannot be unit tested. Everything
 * here is about the receipt a consumer reads: which head was covered, whether
 * anything was posted, and what the action outputs say.
 */

/**
 * Which harness is spending the subscription quota, from `ROBIN_AGENT_CALLER`.
 *
 * Defaults to `github` so an Actions run is attributed correctly with no
 * configuration. An unrecognised value falls back to the default rather than
 * failing the review: caller attribution is bookkeeping, not policy, and a
 * typo in a local invocation must not cost a review.
 */
export function resolveAgentCaller(value: string | undefined): LocalAgentCaller {
  const caller = (value || "").trim() as LocalAgentCaller;
  return LOCAL_AGENT_CALLERS.includes(caller) ? caller : "github";
}

/** A pull request that has been fetched AND confirmed to still be at the expected head. */
export interface ReviewTarget {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
}

export type TerminalOutcome = ReviewOutcome | "stale-head";

export interface TerminalReceipt {
  outcome: TerminalOutcome;
  head: string;
  reviewId?: number;
  reviewUrl?: string;
  verdict?: ReviewVerdict;
  counts?: OutcomeCounts | null;
}

/**
 * Emit the action outputs for a terminal path.
 *
 * Every field is always written, empty when unknown, so a consumer reading
 * `GITHUB_OUTPUT` never has to distinguish "absent" from "zero". Counts are
 * left empty rather than zeroed when they are unknown — a zero would read as
 * "clean".
 */
export function setTerminalOutputs(receipt: TerminalReceipt): void {
  core.setOutput("outcome", receipt.outcome);
  core.setOutput("head", receipt.head);
  core.setOutput("review-id", receipt.reviewId === undefined ? "" : String(receipt.reviewId));
  core.setOutput("review-url", receipt.reviewUrl || "");
  core.setOutput("verdict", receipt.verdict || "");
  const counts = receipt.counts;
  core.setOutput("high", counts ? String(counts.high) : "");
  core.setOutput("medium", counts ? String(counts.medium) : "");
  core.setOutput("low", counts ? String(counts.low) : "");
  core.setOutput("suggestions", counts ? String(counts.suggestions) : "");
}

export function setPostedOutputs(
  outcome: ReviewOutcome,
  headSha: string,
  posted: PostedReview
): void {
  setTerminalOutputs({
    outcome,
    head: headSha,
    reviewId: posted.id,
    reviewUrl: posted.url,
    verdict: posted.verdict,
    counts: posted.counts,
  });
}

/**
 * Fetch the pull request and refuse to hand back anything postable when the
 * head has advanced.
 *
 * The caller only learns the pull number through the returned target, so a
 * stale head structurally cannot reach any posting path — the documented
 * "fails before posting anything" is enforced by the shape of this function,
 * not by remembering to check a flag before each write.
 */
export async function resolveReviewTarget(
  octokit: any,
  owner: string,
  repo: string,
  prNumber: number,
  expectedHeadSha: string
): Promise<ReviewTarget> {
  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  try {
    validateExpectedHeadSha(expectedHeadSha, pullRequest.head.sha);
  } catch (error) {
    setTerminalOutputs({outcome: "stale-head", head: pullRequest.head.sha});
    throw error;
  }

  return {
    owner,
    repo,
    pullNumber: prNumber,
    headSha: pullRequest.head.sha,
    baseSha: pullRequest.base.sha,
  };
}

export interface ReviewFailure {
  gatekeeper: boolean;
  octokit: any;
  /** Undefined when no pull request was resolved and validated — then nothing is posted. */
  target: ReviewTarget | undefined;
  message: string;
  command: "review" | "summary";
}

/**
 * Post the head-bound incomplete receipt and then apply the mode's exit rule.
 *
 * The receipt is posted in BOTH modes: an advisory run that dies mid-review
 * used to post nothing head-bound and exit 0, which a consumer cannot tell from
 * "not started". Exit semantics are unchanged — advisory still warns, only a
 * gatekeeper fails the job.
 */
export async function handleReviewFailure(failure: ReviewFailure): Promise<void> {
  const {gatekeeper, octokit, target, message, command} = failure;

  if (octokit && target && command === "review") {
    try {
      const posted = await new GitHubReviewer(octokit).postFailureReview(
        target.owner,
        target.repo,
        target.pullNumber,
        message,
        target.headSha
      );
      setPostedOutputs("incomplete", target.headSha, posted);
      core.warning(`Incomplete review posted after execution failure: ${message}`);
    } catch (reviewError) {
      core.error(`Could not post incomplete review: ${reviewError}`);
      setTerminalOutputs({outcome: "incomplete", head: target.headSha, counts: ZERO_COUNTS});
    }
  }

  if (gatekeeper) core.setFailed(message);
  else core.warning(`Informational Robin review did not complete: ${message}`);
}

/**
 * Post the head-bound receipt for a head with nothing reviewable, and emit the
 * outputs. Best-effort: a failed receipt must not turn a skip into a failure,
 * but the outputs still name the skipped head.
 */
export async function postSkippedReceipt(
  octokit: any,
  target: ReviewTarget,
  reason: string
): Promise<void> {
  try {
    const posted = await new GitHubReviewer(octokit).postSkippedReview(
      target.owner,
      target.repo,
      target.pullNumber,
      target.headSha,
      reason
    );
    setPostedOutputs("skipped", target.headSha, posted);
  } catch (error) {
    core.warning(`Could not post skipped receipt: ${error}`);
    setTerminalOutputs({outcome: "skipped", head: target.headSha, counts: ZERO_COUNTS});
  }
}
