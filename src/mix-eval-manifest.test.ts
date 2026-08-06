import { readFileSync } from "fs";
import { resolve } from "path";
import manifest from "../eval/mix-recent-prs.json";
import sandboxManifest from "../eval/sandbox-prs.json";
import developmentRuns from "../eval/development-runs.json";

describe("MIX review benchmark", () => {
  it("keeps isolated sandbox heads frozen", () => {
    const cases = sandboxManifest.holdoutCases;
    expect(cases).toHaveLength(10);
    expect(new Set(cases.map(({pr, head}) => `${pr}:${head}`))).toEqual(
      new Set(sandboxManifest.blindHoldoutSnapshots)
    );
    expect(cases.flatMap(({labels}) => labels)).toHaveLength(5);
    expect(cases.flatMap(({labels}) => labels).filter(({source}) => source === "CodeRabbit")).toHaveLength(4);
    expect(cases.flatMap(({labels}) => labels).filter(({source}) => source === "Seeded")).toHaveLength(1);
    expect(sandboxManifest.blindUpdatePairs).toHaveLength(5);
    expect(sandboxManifest.holdoutNegativeControls).toHaveLength(5);
    expect(new Set(sandboxManifest.blindNegativeSnapshots)).toEqual(
      new Set(sandboxManifest.holdoutNegativeControls.map(({pr, head}) => `${pr}:${head}`))
    );
  });

  it("keeps a measured development-run ledger", () => {
    expect(developmentRuns.schemaVersion).toBe(1);
    expect(developmentRuns.runs.some(({status}) => status === "timeout")).toBe(true);
    const selected = developmentRuns.runs.find(({pipelineSha}) =>
      pipelineSha === developmentRuns.selected.equivalentMeasuredTree
    );
    expect(selected).toEqual(expect.objectContaining({
      status: "complete",
      effort: developmentRuns.selected.effort,
      promptSha256: developmentRuns.selected.promptSha256,
      matchedReferenceRoots: 2,
      duplicateNoise: 0,
      falsePositives: 0,
    }));
    expect((selected?.durationMs || Infinity)).toBeLessThan(300_000);
    expect((selected?.apiEquivalentUsd || Infinity) / (selected?.coderabbitEquivalentUsd || 0)).toBeLessThan(0.5);
    expect(developmentRuns.runs).toContainEqual(expect.objectContaining({
      artifactSha256: "f1e2bed22473280cadcdd91566ee830f2ef3dafb03cc6036fa346b37d3195ea2",
      status: "complete-blind-development",
      matchedReferenceRoots: 1,
      additionalRealFindings: 2,
      falsePositives: 0,
      negativeControlsRejected: 3,
      negativeControlsTotal: 4,
    }));
    expect(developmentRuns.runs).toContainEqual(expect.objectContaining({
      artifactSha256: "2be290a99799fc7345d7b9c726cc9997bb578bad1664b58a07dd1eceb4f6a645",
      status: "complete-blind-development-miss",
      effort: "low",
      matchedReferenceRoots: 0,
      falsePositives: 0,
    }));
  });

  it("keeps a non-trivial, unique historical corpus", () => {
    const snapshots = manifest.developmentCases.map(({pr, head}) => `${pr}:${head}`);
    expect(new Set(snapshots).size).toBe(snapshots.length);
    expect(manifest.developmentCases.length).toBeGreaterThanOrEqual(5);
    expect(manifest.developmentCases.flatMap((testCase) => testCase.labels).length).toBeGreaterThanOrEqual(12);
    expect(manifest.holdoutCases.flatMap((testCase) => testCase.labels).length).toBeGreaterThanOrEqual(43);
    expect(manifest.blindHoldoutSnapshots).toEqual([
      "318:41e4d06be8eab388e93f41e5a88825407da77b09",
      "320:1ad70bd0636d26c8810d93c1f730aa36e6f6e314",
      "353:50b3c98ea6da711700f32775f1b658be7427748e",
    ]);
    expect(manifest.blindNegativeSnapshots).toEqual([
      "352:447f9088ce90a725f1ea7ff294e6fcc85f25169e",
      "353:50b3c98ea6da711700f32775f1b658be7427748e",
    ]);
    expect(manifest.blindUpdatePairs).toEqual([]);
    const blindCases = manifest.holdoutCases.filter(({pr, head}) =>
      manifest.blindHoldoutSnapshots.includes(`${pr}:${head}`)
    );
    expect(blindCases.every(({changedFiles}) => (changedFiles?.length || 0) > 0)).toBe(true);
    expect(manifest.holdoutNegativeControls.flatMap(({ rejectedCandidates }) => rejectedCandidates).length).toBeGreaterThanOrEqual(25);
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
    expect(source).toContain('process.env.EVAL_MANIFEST || "eval/mix-recent-prs.json"');
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
