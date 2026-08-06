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
    expect(manifest.blindHoldoutSnapshots).toEqual([
      "318:41e4d06be8eab388e93f41e5a88825407da77b09",
      "320:1ad70bd0636d26c8810d93c1f730aa36e6f6e314",
    ]);
    expect(manifest.blindNegativeSnapshots).toEqual([]);
    expect(manifest.blindUpdatePairs).toEqual([]);
    const blindCases = manifest.holdoutCases.filter(({pr, head}) =>
      manifest.blindHoldoutSnapshots.includes(`${pr}:${head}`)
    );
    expect(blindCases.every(({changedFiles}) => (changedFiles?.length || 0) > 0)).toBe(true);
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
    expect(source).toContain("const reviewChunks = chunkDiffByFile(selectedDiff, 50000)");
    expect(source).toContain(".slice(offset, offset + EVAL_CHUNK_CONCURRENCY)");
    expect(source).toContain("left.snapshotId.localeCompare(right.snapshotId) || left.id.localeCompare(right.id)");
    expect(source).toContain("DISCOVERY CONTRACT EVIDENCE");
    expect(source).toContain("JSON.stringify({file: candidate.file, rootCause: candidate.rootCause})");
    expect(source).not.toContain("CANDIDATE: ${JSON.stringify(candidate)}");
  });
});
