import { buildPrecisionCandidates, selectApprovedCandidates } from "./precision-gate";
import { StructuredReview } from "./review-parser";

const review = (description: string, line = 1): StructuredReview => ({
  summary: "",
  high: [{ file: "a.ts", line, severity: "high", category: "correctness", confidence: "high", description, recommendation: "Fix it." }],
  medium: [], low: [], suggestions: [], rawResponse: "",
});

describe("precision gate", () => {
  it("assigns stable IDs, removes exact duplicates, and keeps only approved IDs", () => {
    const candidates = buildPrecisionCandidates([review("First bug"), review("First bug"), review("Second bug")]);
    expect(candidates.map(({ id }) => id)).toEqual(["c1", "c2"]);
    const selected = selectApprovedCandidates(candidates, '{"approved":["c2"]}', "Verified summary");
    expect(selected.high.map(({ description }) => description)).toEqual(["Second bug"]);
    expect(selected.summary).toBe("Verified summary");
  });

  it("rejects unusable gate responses and tolerates sparse candidates", () => {
    const candidates = buildPrecisionCandidates([review("First bug")]);
    expect(() => selectApprovedCandidates(candidates, "not json")).toThrow();
    expect(() => selectApprovedCandidates(candidates, "{}")).toThrow(/approved string array/);
    expect(buildPrecisionCandidates([{}])).toEqual([]);
  });
});
