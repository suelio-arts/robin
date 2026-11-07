import { ReviewFinding } from "./review-parser";
import { buildPrecisionCandidates, mergeCouncilVerdicts, retainAllCandidates, selectApprovedCandidates } from "./precision-gate";
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
    expect(selectApprovedCandidates(candidates, '{"approved":{},"rejected":{},"already_reported":{}}').high).toHaveLength(1);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{"c1":{"trigger":"","path":"x","impact":"x","evidence":"x"}},"rejected":{},"already_reported":{}}')).toThrow(/approved proof objects/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{"c1":{"trigger":"x","path":"x","impact":"x","evidence":"x"}},"rejected":{"c1":"no"},"already_reported":{}}')).toThrow(/every candidate/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{"c1":{"trigger":"x","path":"x","impact":"x","evidence":"x"}},"rejected":[],"already_reported":{}}')).toThrow(/rejected reason object/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{},"rejected":{"c1":1},"already_reported":{}}')).toThrow(/rejected reason object/);
    expect(() => selectApprovedCandidates(candidates, '{"approved":{},"rejected":{"c1":"no"}}')).toThrow(/already_reported/);
    expect(selectApprovedCandidates(candidates, '{"approved":{},"rejected":{},"already_reported":{"c1":"same prior root"}}').high).toEqual([]);
    expect(buildPrecisionCandidates([{ high: 5 } as never])).toEqual([]);
    expect(buildPrecisionCandidates([{}])).toEqual([]);
  });

  it("retains candidates omitted by the precision response", () => {
    const candidates = buildPrecisionCandidates([review("First bug"), review("Second bug")]);
    const selected = selectApprovedCandidates(
      candidates,
      '{"approved":{},"rejected":{"c1":"not proven"},"already_reported":{}}'
    );

    expect(selected.high.map(({ description }) => description)).toEqual(["Second bug"]);
    expect(retainAllCandidates(candidates, "fallback").high).toHaveLength(2);
  });
});

describe("mergeCouncilVerdicts", () => {
  const finding = (description: string): ReviewFinding => ({
    file: "a.ts", line: 1, severity: "high", category: "bug", description, recommendation: "fix",
  });
  const review = (high: string[], medium: string[]) => ({
    summary: "s", high: high.map((d) => all[d]), medium: medium.map((d) => all[d]),
    low: [], suggestions: [], evidenceRequests: [], rawResponse: "",
  });
  const all: Record<string, ReviewFinding> = {
    h1: finding("h1"), h2: finding("h2"), h3: finding("h3"), m1: finding("m1"), m2: finding("m2"),
  };

  it("keeps a High either seat proves and lower findings only when both agree", () => {
    const {review: merged, splitVerdicts} = mergeCouncilVerdicts(
      review(["h1", "h2"], ["m1", "m2"]),
      review(["h1", "h3"], ["m1"]),
    );
    expect(merged.high).toEqual([all.h1, all.h2, all.h3]);
    expect(merged.medium).toEqual([all.m1]);
    expect(merged.summary).toBe("s");
    expect(splitVerdicts).toBe(3);
  });
});

