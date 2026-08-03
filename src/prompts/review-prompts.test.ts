import { getReviewPrompt } from "./review-prompts";

describe("getReviewPrompt", () => {
  it("includes the focused review passes", () => {
    const prompt = getReviewPrompt();

    expect(prompt).toContain("Trace each changed input through parse");
    expect(prompt).toContain("Trace state and side effects");
    expect(prompt).toContain("Compare changed schemas");
    expect(prompt).toContain("valueless CLI options becoming boolean true");
    expect(prompt).toContain("canonical autopilot identity and role");
    expect(prompt).toContain("skip qualification evidence scans");
    expect(prompt).toContain("Never report standalone requests for tests");
  });
});
