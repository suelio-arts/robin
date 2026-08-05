import { readFileSync } from "fs";
import { resolve } from "path";
import manifest from "../eval/mix-recent-prs.json";

describe("MIX review benchmark", () => {
  it("keeps a non-trivial, unique historical corpus", () => {
    const snapshots = manifest.developmentCases.map(({pr, head}) => `${pr}:${head}`);
    expect(new Set(snapshots).size).toBe(snapshots.length);
    expect(manifest.developmentCases.length).toBeGreaterThanOrEqual(5);
    expect(manifest.developmentCases.flatMap((testCase) => testCase.labels).length).toBeGreaterThanOrEqual(12);
    expect(manifest.holdoutCases.flatMap((testCase) => testCase.labels)).toHaveLength(42);
    expect(manifest.holdoutNegativeControls.flatMap(({ rejectedCandidates }) => rejectedCandidates)).toHaveLength(21);
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

  it("keeps evaluation contract and precision discovery aligned with production", () => {
    const source = readFileSync(resolve("scripts/eval-mix-recent-prs.ts"), "utf8");
    expect(source).toContain("getContractSearchDiscoveryPass(chunk)");
    expect(source).toContain("{prioritizePlanned: true}");
    expect(source).toContain("const reviewedPaths = changedHeadPaths(diff)");
    expect(source).toContain("DISCOVERY CONTRACT EVIDENCE");
  });
});
