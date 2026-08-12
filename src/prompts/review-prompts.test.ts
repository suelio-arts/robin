import { ADVERSARIAL_INSTRUCTIONS, DISCOVERY_INSTRUCTIONS, PRECISION_INSTRUCTIONS, getReviewPrompt } from "./review-prompts";

describe("review prompts", () => {
  it("uses one broad discovery pass instead of incident-specific audit passes", () => {
    expect(DISCOVERY_INSTRUCTIONS).toContain("entire supplied diff broadly");
    expect(DISCOVERY_INSTRUCTIONS).toContain("every concrete regression");
    expect(DISCOVERY_INSTRUCTIONS).toContain("one representative finding per root cause");
    expect(DISCOVERY_INSTRUCTIONS).not.toContain("Audit only");
    expect(ADVERSARIAL_INSTRUCTIONS).toContain("valueless, empty, whitespace-only");
    expect(ADVERSARIAL_INSTRUCTIONS).toContain("--flag=value");
    expect(ADVERSARIAL_INSTRUCTIONS).toContain("monotonic session ordinals");
    expect(ADVERSARIAL_INSTRUCTIONS).toContain("experimental or alternate modes");
    expect(ADVERSARIAL_INSTRUCTIONS).not.toContain("Audit only");
  });

  it("gates evidence globally without MIX-specific memories", () => {
    expect(PRECISION_INSTRUCTIONS).toContain("one whole pull request");
    expect(PRECISION_INSTRUCTIONS).toContain("Disposition every candidate ID exactly once");
    expect(PRECISION_INSTRUCTIONS).toContain("Approve at most one representative per root cause");
    expect(PRECISION_INSTRUCTIONS).toContain("current head has fixed it");
    expect(PRECISION_INSTRUCTIONS).not.toMatch(/buildStoryWalk|pollJob|OverridesById/);
  });

  it("keeps the output and evidence contracts concise", () => {
    const prompt = getReviewPrompt("Prefer hard cuts.");
    expect(prompt).toContain("trigger, failing path, material impact");
    expect(prompt).toContain("strict JSON only");
    expect(prompt).toContain("Prefer hard cuts.");
    expect(prompt.length).toBeLessThan(5000);
  });
});
