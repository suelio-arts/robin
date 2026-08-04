import { DISCOVERY_PASSES, getReviewPrompt } from "./review-prompts";

describe("getReviewPrompt", () => {
  it("includes the focused review passes", () => {
    const prompt = getReviewPrompt();

    expect(prompt).toContain("Trace each changed input through parse");
    expect(prompt).toContain("Trace state and side effects");
    expect(prompt).toContain("Compare changed schemas");
    expect(prompt).toContain("valueless CLI options becoming boolean true");
    expect(prompt).toContain("repository registries and sibling entry points");
    expect(prompt).toContain("Never report standalone requests for tests");
  });

  it("keeps repository-wide contract checks in the fixed-cost discovery passes", () => {
    expect(DISCOVERY_PASSES).toHaveLength(6);
    expect(DISCOVERY_PASSES.join("\n")).toContain("normalized readback comparisons");
    expect(DISCOVERY_PASSES.join("\n")).toContain("user-entered search/filter values");
    expect(DISCOVERY_PASSES.join("\n")).toContain("required registries and preflight lists");
  });
});
