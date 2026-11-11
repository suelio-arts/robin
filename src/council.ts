import * as core from "@actions/core";
import type { LLMClient } from "./llm-client";
import { SubscriptionLimitError } from "./subscription-limit";

type Seat = {llm: LLMClient; model: string};

/** The second reviewer: its live seat, an optional quota fallback, and the receipt counters. */
export type CouncilSeat = Seat & {
  fallback?: Seat;
  substitutedFor?: Seat;
  discoveryFallbacks: number;
  gateVoted: boolean;
  splitVerdicts: number;
};

export function createCouncilSeat(seat: Seat, fallback?: Seat): CouncilSeat {
  return {...seat, fallback, discoveryFallbacks: 0, gateVoted: false, splitVerdicts: 0};
}

/**
 * Runs one council call. A subscription limit hands the seat to the fallback
 * for this call and the rest of the review; without one it stays fatal. A
 * limit on the fallback is an ordinary seat failure, so it cannot block.
 */
export async function onCouncilSeat<T>(council: CouncilSeat, run: (llm: LLMClient) => Promise<T>): Promise<T> {
  const seat = council.llm;
  try {
    return await run(seat);
  } catch (error) {
    const {fallback} = council;
    if (!(error instanceof SubscriptionLimitError) || !fallback) throw error;
    if (seat === fallback.llm) throw new Error(`Fallback council seat ${fallback.model} failed: ${error.message}`);
    if (council.llm !== fallback.llm) {
      core.warning(`Council seat ${council.model} hit its subscription limit; ${fallback.model} takes the seat: ${error.message}`);
      council.substitutedFor = {llm: council.llm, model: council.model};
      council.llm = fallback.llm;
      council.model = fallback.model;
    }
    return onCouncilSeat(council, run);
  }
}

export function councilReceipt(model: string, council: CouncilSeat): string {
  const degraded = council.discoveryFallbacks > 0 || !council.gateVoted;
  const {substitutedFor} = council;
  const metrics = council.llm.getMetrics();
  const calls = metrics.calls + (substitutedFor?.llm.getMetrics().calls ?? 0);
  return `Robin council: ${model} + ${council.model} (${calls} calls) · ${council.splitVerdicts} split verdicts`
    + (substitutedFor ? ` · SUBSTITUTED: ${substitutedFor.model} hit its subscription limit;`
      + ` ${council.model} used ${metrics.inputTokens} input and ${metrics.outputTokens} output tokens` : "")
    + (degraded ? ` · DEGRADED: ${council.discoveryFallbacks} discovery fallbacks, final vote ${council.gateVoted ? "held" : "single-seat"}` : "");
}
