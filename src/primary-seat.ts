import * as core from "@actions/core";
import type { LLMClient, LlmMetrics } from "./llm-client";
import { SubscriptionLimitError } from "./subscription-limit";

export type Seat = {llm: LLMClient; model: string};
export type ChatSeat = Pick<LLMClient, "chatCompletion">;

/** The primary reviewer: its live seat, an optional quota fallback, and substitution state. */
export type PrimarySeat = Seat & ChatSeat & {
  fallback?: Seat;
  substitutedFor?: Seat;
  getMetrics: () => LlmMetrics;
};

export function createPrimarySeat(seat: Seat, fallback?: Seat): PrimarySeat {
  const primary: PrimarySeat = {
    ...seat,
    fallback,
    chatCompletion(systemPrompt, userContent, jsonResponseMode) {
      return onPrimarySeat(primary, (active) => active.chatCompletion(systemPrompt, userContent, jsonResponseMode));
    },
    getMetrics() {
      const current = primary.llm.getMetrics();
      if (!primary.substitutedFor) return current;
      const original = primary.substitutedFor.llm.getMetrics();
      return {
        calls: original.calls + current.calls,
        durationMs: Math.max(original.durationMs, current.durationMs),
        inputTokens: original.inputTokens + current.inputTokens,
        cachedInputTokens: original.cachedInputTokens + current.cachedInputTokens,
        outputTokens: original.outputTokens + current.outputTokens,
        reasoningOutputTokens: original.reasoningOutputTokens + current.reasoningOutputTokens,
      };
    },
  };
  return primary;
}

/**
 * Runs one primary-seat call. A subscription limit hands the seat to the
 * fallback for this call and the rest of the review; without one it stays
 * fatal. A limit on the fallback itself stays fatal and does not recurse.
 */
export async function onPrimarySeat<T>(primary: PrimarySeat, run: (llm: LLMClient) => Promise<T>): Promise<T> {
  const seat = primary.llm;
  try {
    return await run(seat);
  } catch (error) {
    const {fallback} = primary;
    if (!(error instanceof SubscriptionLimitError) || !fallback || seat === fallback.llm) throw error;
    if (primary.llm !== fallback.llm) {
      core.warning(`Primary seat ${primary.model} hit its subscription limit; ${fallback.model} takes the seat: ${error.message}`);
      primary.substitutedFor = {llm: primary.llm, model: primary.model};
      primary.llm = fallback.llm;
      primary.model = fallback.model;
    }
    return onPrimarySeat(primary, run);
  }
}

export function primaryFallbackReceipt(primary: PrimarySeat): string | undefined {
  const {substitutedFor} = primary;
  if (!substitutedFor) return undefined;
  const metrics = primary.llm.getMetrics();
  return `Robin fallback: ${primary.model} (${metrics.calls} calls) · SUBSTITUTED: ${substitutedFor.model} hit its subscription limit;`
    + ` ${primary.model} used ${metrics.inputTokens} input and ${metrics.outputTokens} output tokens`;
}
