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
    const selected = selectApprovedCandidates(candidates, '{"approved":{"c2":{"trigger":"input","path":"handler","impact":"failure","evidence":"a.ts:1"}},"rejected":{"c1":"not proven"},"already_reported":{}}', "Verified summary");
    expect(selected.high.map(({ description }) => description)).toEqual(["Second bug"]);
    expect(selected.summary).toBe("Verified summary");
  });

  it("rejects unusable gate responses and tolerates sparse candidates", () => {
    const candidates = buildPrecisionCandidates([review("First bug")]);
    expect(() => selectApprovedCandidates(candidates, "not json")).toThrow();
    expect(() => selectApprovedCandidates(candidates, "{}")).toThrow(/approved proof objects/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{"c999":{"trigger":"x","path":"x","impact":"x","evidence":"x"}},"rejected":{"c1":"no"},"already_reported":{}}')).toThrow(/every candidate/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{},"rejected":{},"already_reported":{}}')).toThrow(/every candidate/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{"c1":{"trigger":"","path":"x","impact":"x","evidence":"x"}},"rejected":{},"already_reported":{}}')).toThrow(/approved proof objects/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{"c1":{"trigger":"x","path":"x","impact":"x","evidence":"x"}},"rejected":{"c1":"no"},"already_reported":{}}')).toThrow(/every candidate/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{"c1":{"trigger":"x","path":"x","impact":"x","evidence":"x"}},"rejected":[],"already_reported":{}}')).toThrow(/rejected reason object/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{},"rejected":{"c1":1},"already_reported":{}}')).toThrow(/rejected reason object/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{},"rejected":{"c1":"no"}}')).toThrow(/already_reported/);
    expect(selectApprovedCandidates(candidates, '{"approved":{},"rejected":{},"already_reported":{"c1":"same prior root"}}').high).toEqual([]);
    expect(buildPrecisionCandidates([{ high: 5 } as never])).toEqual([]);
    expect(buildPrecisionCandidates([{}])).toEqual([]);
  });
});
