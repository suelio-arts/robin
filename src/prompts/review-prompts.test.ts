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
    // A gate must be judged against the production behavior it stands in for, not its own title.
    expect(ADVERSARIAL_INSTRUCTIONS).toContain("Enumerate every property of that production behavior separately");
  });

  it("gates evidence globally without MIX-specific memories", () => {
    expect(PRECISION_INSTRUCTIONS).toContain("one whole pull request");
    expect(PRECISION_INSTRUCTIONS).toContain("Disposition every candidate ID exactly once");
    expect(PRECISION_INSTRUCTIONS).toContain("Approve at most one representative per root cause");
    expect(PRECISION_INSTRUCTIONS).toContain("current head has fixed it");
    // A compiler outcome nobody ran is not evidence: the declaration that fails must be supplied.
    expect(PRECISION_INSTRUCTIONS).toContain("You cannot compile, type-check, or lint anything");
    // A documented deliberate choice is not re-litigated, but a code/doc contradiction still is.
    expect(PRECISION_INSTRUCTIONS).toContain("states the changed behavior is deliberate settles intent");
    expect(PRECISION_INSTRUCTIONS).toContain("contradict each other is not that");
    // An unenforced lint rule is style, not a gate failure.
    expect(PRECISION_INSTRUCTIONS).toContain("runs that rule in a required gate");
    expect(PRECISION_INSTRUCTIONS).toContain("exact declaration, signature, or overload that makes it fail");
    // One fix, one comment: several angles on one weak construct are duplicates, not distinct roots.
    expect(PRECISION_INSTRUCTIONS).toContain("one single edit would resolve together are one root cause");
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
