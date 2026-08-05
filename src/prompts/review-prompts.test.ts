import { DISCOVERY_PASSES, PRECISION_INSTRUCTIONS, getReviewPrompt } from "./review-prompts";

describe("getReviewPrompt", () => {
  it("includes the focused review passes", () => {
    const prompt = getReviewPrompt();

    expect(prompt).toContain("Trace each changed input through parse");
    expect(prompt).toContain("Trace state and side effects");
    expect(prompt).toContain("Compare changed schemas");
    expect(prompt).toContain("valueless CLI options becoming boolean true");
    expect(prompt).toContain("repository registries and sibling entry points");
    expect(prompt).toContain("Never report standalone requests for more tests");
    expect(prompt).toContain("compare every imported predicate and canonical preflight");
    expect(prompt).toContain("An added or changed required validator, gate, fixture, or harness that claims a contract");
    expect(prompt).toContain("omits a reachable changed state or canonical preflight");
    expect(prompt).toContain("anchor it to the changed assertion or invocation block");
  });

  it("keeps repository-wide contract checks in the fixed-cost discovery passes", () => {
    expect(DISCOVERY_PASSES).toHaveLength(6);
    expect(DISCOVERY_PASSES.join("\n")).toContain("normalized readback comparisons");
    expect(DISCOVERY_PASSES.join("\n")).toContain("user-entered search/filter values");
    expect(DISCOVERY_PASSES.join("\n")).toContain("required registries and preflight lists");
    expect(DISCOVERY_PASSES.join("\n")).toContain("aggregate commands invoke its canonical contract gates");
    expect(DISCOVERY_PASSES.join("\n")).toContain("observable system to settle");
    expect(DISCOVERY_PASSES.join("\n")).toContain("transient pending or generating states");
    expect(DISCOVERY_PASSES.join("\n")).toContain("losing timeout or operation is cancelled");
    expect(DISCOVERY_PASSES.join("\n")).toContain("privacy text with the actual data and capability use");
    expect(PRECISION_INSTRUCTIONS.join("\n")).toContain("every supplied candidate ID exactly once");
  });
});
