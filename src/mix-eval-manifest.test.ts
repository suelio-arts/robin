import manifest from "../eval/mix-recent-prs.json";

describe("MIX review benchmark", () => {
  it("keeps a non-trivial, unique historical corpus", () => {
    const prs = manifest.developmentCases.map((testCase) => testCase.pr);
    expect(new Set(prs).size).toBe(prs.length);
    expect(manifest.developmentCases.length).toBeGreaterThanOrEqual(5);
    expect(manifest.negativeControls.length).toBeGreaterThanOrEqual(5);
    expect(manifest.developmentCases.flatMap((testCase) => testCase.labels).length).toBeGreaterThanOrEqual(12);
  });
});
