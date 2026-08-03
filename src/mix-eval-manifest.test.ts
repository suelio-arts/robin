import manifest from "../eval/mix-recent-prs.json";

describe("MIX review benchmark", () => {
  it("keeps a non-trivial, unique historical corpus", () => {
    const prs = manifest.cases.map((testCase) => testCase.pr);
    expect(new Set(prs).size).toBe(prs.length);
    expect(manifest.cases.length).toBeGreaterThanOrEqual(5);
    expect(manifest.negativeControls.length).toBeGreaterThanOrEqual(5);
    expect(manifest.cases.flatMap((testCase) => testCase.labels).length).toBeGreaterThanOrEqual(12);
  });
});
