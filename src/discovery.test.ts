import { ReviewBudget, runDiscovery } from "./discovery";
import { StructuredReview } from "./review-parser";

const empty = (summary: string, evidenceRequests: StructuredReview["evidenceRequests"] = []): StructuredReview => ({
  summary, high: [], medium: [], low: [], suggestions: [], evidenceRequests, rawResponse: "",
});

describe("runDiscovery", () => {
  it("serializes broad then adversarial and permits one bounded evidence follow-up", async () => {
    const calls: string[] = [];
    const result = await runDiscovery(async (instructions) => {
      calls.push(instructions);
      return empty(instructions, calls.length === 1
        ? [{kind: "symbol", query: "parseAuth", reason: "prove behavior"}]
        : []);
    }, async () => "<review-evidence>proof</review-evidence>", new ReviewBudget(1, Date.now() + 1_000));
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("Review the entire supplied diff broadly");
    expect(calls[1]).toContain("adversarial failure analyst");
    expect(calls[2]).toContain("EVIDENCE FOLLOW-UP");
    expect(result.followedUp).toBe(true);
  });

  it("sends the adversarial pass to the council seat in parallel", async () => {
    const order: string[] = [];
    let releaseBroad: () => void = () => undefined;
    const broadGate = new Promise<void>((resolve) => { releaseBroad = resolve; });
    await runDiscovery(async (instructions) => {
      order.push(`primary:${instructions.slice(0, 20)}`);
      await broadGate;
      return empty("broad");
    }, async () => "", new ReviewBudget(1, Date.now() + 1_000), async (instructions) => {
      order.push(`council:${instructions.includes("adversarial failure analyst")}`);
      releaseBroad();
      return empty("adversarial");
    });
    expect(order).toEqual([expect.stringContaining("primary:"), "council:true"]);
  });

  it("does not start a follow-up after the budget deadline", async () => {
    let calls = 0;
    const result = await runDiscovery(async () => {
      calls += 1;
      return empty("", [{kind: "file", path: "a.ts", reason: "proof"}]);
    }, async () => "evidence", new ReviewBudget(1, 0));
    expect(calls).toBe(2);
    expect(result.followedUp).toBe(false);
  });

  it("does not consume follow-up capacity when exact-head evidence is empty", async () => {
    const budget = new ReviewBudget(1, Date.now() + 1_000);
    await runDiscovery(async () => empty("", [{kind: "file", path: "missing.ts", reason: "proof"}]), async () => "", budget);
    expect(budget.usedFollowups).toBe(0);
  });
});
