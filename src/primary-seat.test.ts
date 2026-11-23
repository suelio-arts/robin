import * as core from "@actions/core";
import type { LLMClient } from "./llm-client";
import { createPrimarySeat, onPrimarySeat, primaryFallbackReceipt } from "./primary-seat";
import { seatCalls } from "./review-core";
import { SubscriptionLimitError } from "./subscription-limit";

const makeSeat = (
  model: string,
  metrics: {calls?: number; durationMs?: number; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number} = {},
  chatCompletion?: LLMClient["chatCompletion"]
) => ({
  llm: {
    calls: [{startMs: 0, endMs: 100, inFlight: 1}],
    chatCompletion: chatCompletion ?? jest.fn(async () => ({content: model})),
    getMetrics: () => ({
      calls: metrics.calls ?? 0,
      durationMs: metrics.durationMs ?? 1000,
      inputTokens: metrics.inputTokens ?? 0,
      cachedInputTokens: metrics.cachedInputTokens ?? 0,
      outputTokens: metrics.outputTokens ?? 0,
      reasoningOutputTokens: metrics.reasoningOutputTokens ?? 0,
    }),
  } as unknown as LLMClient,
  model,
});

const limit = () => new SubscriptionLimitError("codex", "quota");

describe("primary seat", () => {
  beforeEach(() => jest.spyOn(core, "warning").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("hands the primary seat to the fallback on a subscription limit and keeps it there", async () => {
    const luna = makeSeat("luna-6-high-subscription", {calls: 1, durationMs: 4200, inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 5},
      jest.fn(async () => { throw limit(); }));
    const deepseek = makeSeat("deepseek-v4.1-flash-deploy", {calls: 3, durationMs: 3900, inputTokens: 400, cachedInputTokens: 0, outputTokens: 90, reasoningOutputTokens: 30},
      jest.fn(async () => ({content: "review"})));
    const primary = createPrimarySeat(luna, deepseek);

    expect(primaryFallbackReceipt(primary)).toBeUndefined();
    expect((await primary.chatCompletion("sys", "user", true)).content).toBe("review");
    expect((await primary.chatCompletion("sys", "user2", true)).content).toBe("review");
    expect(luna.llm.chatCompletion).toHaveBeenCalledTimes(1);
    expect(deepseek.llm.chatCompletion).toHaveBeenCalledTimes(2);
    expect(primary.model).toBe("deepseek-v4.1-flash-deploy");
    expect(primary.substitutedFor?.model).toBe("luna-6-high-subscription");
    expect(primary.getMetrics()).toEqual({
      calls: 4,
      durationMs: 4200,
      inputTokens: 500,
      cachedInputTokens: 20,
      outputTokens: 100,
      reasoningOutputTokens: 35,
    });
    expect(primaryFallbackReceipt(primary)).toBe(
      "Robin fallback: deepseek-v4.1-flash-deploy (3 calls) · SUBSTITUTED: luna-6-high-subscription hit its subscription limit;"
      + " deepseek-v4.1-flash-deploy used 400 input and 90 output tokens"
    );
    expect(seatCalls(primary, "luna-6-high-subscription").map(({model}) => model)).toEqual([
      "luna-6-high-subscription",
      "deepseek-v4.1-flash-deploy",
    ]);
  });

  it("switches once when concurrent calls hit the limit together", async () => {
    const luna = makeSeat("luna");
    const deepseek = makeSeat("deepseek");
    const primary = createPrimarySeat(luna, deepseek);
    const run = async (llm: LLMClient) => {
      if (llm === luna.llm) throw limit();
      return llm;
    };
    expect(await Promise.all([onPrimarySeat(primary, run), onPrimarySeat(primary, run)])).toEqual([deepseek.llm, deepseek.llm]);
    expect(primary.substitutedFor?.model).toBe("luna");
    expect(core.warning).toHaveBeenCalledTimes(1);
  });

  it("keeps a subscription limit fatal without a fallback", async () => {
    const primary = createPrimarySeat(makeSeat("luna"));
    await expect(onPrimarySeat(primary, async () => { throw limit(); })).rejects.toBeInstanceOf(SubscriptionLimitError);
    expect(primaryFallbackReceipt(primary)).toBeUndefined();
  });

  it("keeps non-limit failures fatal without switching seats", async () => {
    const luna = makeSeat("luna");
    const deepseek = makeSeat("deepseek");
    const primary = createPrimarySeat(luna, deepseek);
    await expect(onPrimarySeat(primary, async () => { throw new Error("timeout"); })).rejects.toThrow("timeout");
    expect(primary.model).toBe("luna");
    expect(primary.substitutedFor).toBeUndefined();
  });

  it("keeps a subscription limit on the fallback seat fatal without recursing", async () => {
    const luna = makeSeat("luna");
    const backup = makeSeat("opus");
    const primary = createPrimarySeat(luna, backup);
    const run = jest.fn(async () => { throw limit(); });
    await expect(onPrimarySeat(primary, run)).rejects.toBeInstanceOf(SubscriptionLimitError);
    expect(run).toHaveBeenCalledTimes(2);
    expect(primary.model).toBe("opus");
    expect(primary.substitutedFor?.model).toBe("luna");
  });
});
