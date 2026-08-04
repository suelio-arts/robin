import manifest from "../eval/mix-recent-prs.json";

describe("MIX review benchmark", () => {
  it("keeps a non-trivial, unique historical corpus", () => {
    const prs = manifest.developmentCases.map((testCase) => testCase.pr);
    expect(new Set(prs).size).toBe(prs.length);
    expect(manifest.developmentCases.length).toBeGreaterThanOrEqual(5);
    expect(manifest.developmentCases.flatMap((testCase) => testCase.labels).length).toBeGreaterThanOrEqual(12);
    expect(manifest.holdoutCases.flatMap((testCase) => testCase.labels)).toHaveLength(21);
    expect(manifest.holdoutNegativeControls.flatMap(({ rejectedCandidates }) => rejectedCandidates)).toHaveLength(14);
    for (const label of manifest.holdoutCases.flatMap((testCase) => testCase.labels)) {
      expect(label).toEqual(expect.objectContaining({
        file: expect.stringMatching(/\S/),
        rootCause: expect.stringMatching(/\S/),
        source: expect.stringMatching(/\S/),
      }));
    }
    for (const candidate of manifest.holdoutNegativeControls.flatMap(({ rejectedCandidates }) => rejectedCandidates)) {
      expect(candidate).toEqual(expect.objectContaining({
        file: expect.stringMatching(/\S/),
        rootCause: expect.stringMatching(/\S/),
        reason: expect.stringMatching(/\S/),
      }));
    }
    for (const collection of [manifest.holdoutCases, manifest.holdoutNegativeControls]) {
      const ids = collection.map(({pr, base, head}) => `${pr}:${base}:${head}`);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const developmentHeads = new Set(manifest.developmentCases.map(({head}) => head));
    expect([...manifest.holdoutCases, ...manifest.holdoutNegativeControls].every(({ head }) => !developmentHeads.has(head))).toBe(true);
  });
});
