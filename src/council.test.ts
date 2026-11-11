import * as core from "@actions/core";
import type { LLMClient } from "./llm-client";
import { councilReceipt, createCouncilSeat, onCouncilSeat } from "./council";
import { SubscriptionLimitError } from "./subscription-limit";

const seat = (model: string, calls = 0) => ({llm: {getMetrics: () => ({calls})} as unknown as LLMClient, model});
const limit = () => new SubscriptionLimitError("antigravity", "quota");

describe("council seat", () => {
  beforeEach(() => jest.spyOn(core, "warning").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("hands the seat to the fallback on a subscription limit and keeps it there", async () => {
    const carbon = seat("gemini-4-carbon-medium-subscription");
    const deepseek = seat("deepseek-v4.1-flash-deploy", 3);
    const council = createCouncilSeat(carbon, deepseek);
    const run = jest.fn(async (llm: LLMClient) => {
      if (llm === carbon.llm) throw limit();
      return "vote";
    });
    expect(await onCouncilSeat(council, run)).toBe("vote");
    expect(await onCouncilSeat(council, run)).toBe("vote");
    expect(run.mock.calls.map(([llm]) => llm)).toEqual([carbon.llm, deepseek.llm, deepseek.llm]);
    council.gateVoted = true;
    expect(councilReceipt("sol-6.1-medium-subscription", council)).toBe(
      "Robin council: sol-6.1-medium-subscription + deepseek-v4.1-flash-deploy (3 calls) · 0 split verdicts"
      + " · SUBSTITUTED: gemini-4-carbon-medium-subscription hit its subscription limit");
  });

  it("switches once when concurrent calls hit the limit together", async () => {
    const carbon = seat("carbon");
    const deepseek = seat("deepseek");
    const council = createCouncilSeat(carbon, deepseek);
    const run = async (llm: LLMClient) => {
      if (llm === carbon.llm) throw limit();
      return llm;
    };
    expect(await Promise.all([onCouncilSeat(council, run), onCouncilSeat(council, run)])).toEqual([deepseek.llm, deepseek.llm]);
    expect(council.substitutedFor).toBe("carbon");
    expect(core.warning).toHaveBeenCalledTimes(1);
  });

  it("keeps a subscription limit fatal without a fallback", async () => {
    const council = createCouncilSeat(seat("carbon"));
    await expect(onCouncilSeat(council, async () => { throw limit(); })).rejects.toBeInstanceOf(SubscriptionLimitError);
  });

  it("leaves other failures and fallback failures to the caller's degraded path", async () => {
    const carbon = seat("carbon");
    const deepseek = seat("deepseek");
    const council = createCouncilSeat(carbon, deepseek);
    await expect(onCouncilSeat(council, async () => { throw new Error("parse"); })).rejects.toThrow("parse");
    expect(council.model).toBe("carbon");
    const failing = async (llm: LLMClient) => {
      throw llm === carbon.llm ? limit() : new Error("Deploy API returned HTTP 402");
    };
    await expect(onCouncilSeat(council, failing)).rejects.toThrow("HTTP 402");
    expect(council.model).toBe("deepseek");
  });
});
