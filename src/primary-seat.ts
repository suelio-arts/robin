import * as core from "@actions/core";
import type { LLMClient, LlmMetrics } from "./llm-client";
import { SubscriptionLimitError } from "./subscription-limit";

export type Seat = {llm: LLMClient; model: string};
export type ChatSeat = Pick<LLMClient, "chatCompletion">;

/** The primary reviewer: its live seat, ordered quota fallbacks, and replaced seats. */
export type PrimarySeat = Seat & ChatSeat & {
  fallbacks: Seat[];
  replaced: Seat[];
  getMetrics: () => LlmMetrics;
};

/** Parses a single fallback model or a comma/newline-separated fallback chain. */
export function parseFallbackModels(input: string): string[] {
  return input.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean);
}

export function createPrimarySeat(seat: Seat, fallback?: Seat | Seat[]): PrimarySeat {
  const fallbacks = Array.isArray(fallback) ? [...fallback] : fallback ? [fallback] : [];
  const primary: PrimarySeat = {
    ...seat,
    fallbacks,
    replaced: [],
    chatCompletion(systemPrompt, userContent, jsonResponseMode) {
      return onPrimarySeat(primary, (active) => active.chatCompletion(systemPrompt, userContent, jsonResponseMode));
    },
    getMetrics() {
      const current = primary.llm.getMetrics();
      if (primary.replaced.length === 0) return current;
      const all = [...primary.replaced.map((prior) => prior.llm.getMetrics()), current];
      return {
        calls: all.reduce((sum, item) => sum + item.calls, 0),
        durationMs: Math.max(...all.map((item) => item.durationMs)),
        inputTokens: all.reduce((sum, item) => sum + item.inputTokens, 0),
        cachedInputTokens: all.reduce((sum, item) => sum + item.cachedInputTokens, 0),
        outputTokens: all.reduce((sum, item) => sum + item.outputTokens, 0),
        reasoningOutputTokens: all.reduce((sum, item) => sum + item.reasoningOutputTokens, 0),
      };
    },
  };
  return primary;
}

/**
 * Runs one primary-seat call. A subscription limit advances the seat to the
 * next configured fallback for this call and the rest of the review; once the
 * fallback chain is exhausted, a subscription limit stays fatal.
 */
export async function onPrimarySeat<T>(primary: PrimarySeat, run: (llm: LLMClient) => Promise<T>): Promise<T> {
  const seat = primary.llm;
  try {
    return await run(seat);
  } catch (error) {
    if (!(error instanceof SubscriptionLimitError)) throw error;
    if (seat === primary.llm) {
      const next = primary.fallbacks.shift();
      if (!next) throw error;
      core.warning(`Primary seat ${primary.model} hit its subscription limit; ${next.model} takes the seat: ${error.message}`);
      primary.replaced.push({llm: primary.llm, model: primary.model});
      primary.llm = next.llm;
      primary.model = next.model;
    }
    return onPrimarySeat(primary, run);
  }
}

export function primaryFallbackReceipt(primary: PrimarySeat): string | undefined {
  if (primary.replaced.length === 0) return undefined;
  const metrics = primary.llm.getMetrics();
  const replaced = primary.replaced.length === 1
    ? `${primary.replaced[0].model} hit its subscription limit`
    : `${primary.replaced.map(({model}) => model).join(" -> ")} hit subscription limits`;
  return `Robin fallback: ${primary.model} (${metrics.calls} calls) · SUBSTITUTED: ${replaced};`
    + ` ${primary.model} used ${metrics.inputTokens} input and ${metrics.outputTokens} output tokens`;
}
