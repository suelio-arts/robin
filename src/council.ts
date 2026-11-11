import * as core from "@actions/core";
import type { LLMClient } from "./llm-client";
import { SubscriptionLimitError } from "./subscription-limit";

type Seat = {llm: LLMClient; model: string};

/** The second reviewer: its live seat, an optional quota fallback, and the receipt counters. */
export type CouncilSeat = Seat & {
  fallback?: Seat;
  substitutedFor?: string;
  discoveryFallbacks: number;
  gateVoted: boolean;
  splitVerdicts: number;
};

export function createCouncilSeat(seat: Seat, fallback?: Seat): CouncilSeat {
  return {...seat, fallback, discoveryFallbacks: 0, gateVoted: false, splitVerdicts: 0};
}

/**
 * Runs one council call. A subscription limit hands the seat to the fallback
 * for this call and the rest of the review; without one it stays fatal.
 */
export async function onCouncilSeat<T>(council: CouncilSeat, run: (llm: LLMClient) => Promise<T>): Promise<T> {
  const seat = council.llm;
  try {
    return await run(seat);
  } catch (error) {
    const {fallback} = council;
    if (!(error instanceof SubscriptionLimitError) || !fallback || seat === fallback.llm) throw error;
    if (council.llm !== fallback.llm) {
      core.warning(`Council seat ${council.model} hit its subscription limit; ${fallback.model} takes the seat: ${error.message}`);
      council.substitutedFor = council.model;
      council.llm = fallback.llm;
      council.model = fallback.model;
    }
    return run(fallback.llm);
  }
}

export function councilReceipt(model: string, council: CouncilSeat): string {
  const degraded = council.discoveryFallbacks > 0 || !council.gateVoted;
  return `Robin council: ${model} + ${council.model} (${council.llm.getMetrics().calls} calls) · ${council.splitVerdicts} split verdicts`
    + (council.substitutedFor ? ` · SUBSTITUTED: ${council.substitutedFor} hit its subscription limit` : "")
    + (degraded ? ` · DEGRADED: ${council.discoveryFallbacks} discovery fallbacks, final vote ${council.gateVoted ? "held" : "single-seat"}` : "");
}
