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
    const selected = selectApprovedCandidates(candidates, '{"approved":["c2"],"rejected":{"c1":"not proven"}}', "Verified summary");
    expect(selected.high.map(({ description }) => description)).toEqual(["Second bug"]);
    expect(selected.summary).toBe("Verified summary");
  });

  it("rejects unusable gate responses and tolerates sparse candidates", () => {
    const candidates = buildPrecisionCandidates([review("First bug")]);
    expect(() => selectApprovedCandidates(candidates, "not json")).toThrow();
    expect(() => selectApprovedCandidates(candidates, "{}")).toThrow(/approved string array/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":["c999"],"rejected":{"c1":"no"}}')).toThrow(/every candidate/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":[],"rejected":{}}')).toThrow(/every candidate/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":["c1","c1"],"rejected":{}}')).toThrow(/every candidate/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":["c1"],"rejected":{"c1":"no"}}')).toThrow(/every candidate/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":["c1"],"rejected":[]}')).toThrow(/rejected reason object/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":[],"rejected":{"c1":1}}')).toThrow(/rejected reason object/);
    expect(buildPrecisionCandidates([{ high: 5 } as never])).toEqual([]);
    expect(buildPrecisionCandidates([{}])).toEqual([]);
  });
});
