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
    expect(sandboxManifest.blindUpdatePairs).toEqual([
      {before: "2:0a85c6cbf0bcc2ce544a59bfb33259f199a71a77", after: "2:911d11498035c0b464d0598800781e076d985e21"},
      {before: "3:9fac4da53ba1a3b5f24a687fb9484da5e4274ad1", after: "3:09c85bbaebaf527e04bcf687bb61dbda2e0118d6"},
      {before: "4:78391fd272f8a19186f17ac0e32f92c2f9c04f97", after: "4:28cddbae0408172466bbd90bd502852996664e71"},
      {before: "5:01ddd427b038942361078f3e9a851e7a05f6b271", after: "5:78b7954b405cacc262bebdc3aacc35bad14da7ad"},
      {before: "6:5193ef5b07527e9d54b7c74530c6e771e3c1f0cb", after: "6:0148f258bb0d00de7b03ae9fdc851b9eafcbac31"},
    ]);
    const updateHeads = sandboxManifest.blindUpdatePairs.flatMap(({before, after}) => [before, after]);
    expect(new Set(updateHeads).size).toBe(updateHeads.length);
    expect(sandboxManifest.holdoutNegativeControls).toHaveLength(5);
    expect(new Set(sandboxManifest.blindNegativeSnapshots)).toEqual(
      new Set(sandboxManifest.holdoutNegativeControls.map(({pr, head}) => `${pr}:${head}`))
    );
  });

  it("keeps a measured development-run ledger", () => {
    expect(developmentRuns.schemaVersion).toBe(1);
    expect(developmentRuns.selected.candidateHead).toMatch(/^[a-f0-9]{40}$/);
    expect(developmentRuns.runs.some(({status}) => status === "timeout")).toBe(true);
    const selectedRuns = developmentRuns.runs.filter(({pipelineSha, promptSha256}) =>
      pipelineSha === developmentRuns.selected.equivalentMeasuredTree
      && promptSha256 === developmentRuns.selected.promptSha256
    );
    expect(selectedRuns).toHaveLength(3);
    for (const selected of selectedRuns) {
      expect(selected).toEqual(expect.objectContaining({
        status: "complete-isolated-repeatability",
        effort: developmentRuns.selected.effort,
        matchedReferenceRoots: 5,
        duplicateNoise: 0,
        falsePositives: 0,
        negativeControlsRejected: 5,
        negativeControlsTotal: 5,
        updateNoisePerUpdate: 0,
        suggestionsPerSnapshot: 0,
      }));
      const {durationMs, apiEquivalentUsd, coderabbitEquivalentUsd} = selected;
      if (durationMs === undefined || apiEquivalentUsd === undefined || coderabbitEquivalentUsd === undefined) {
        throw new Error("Selected measured run is missing timing or cost metadata");
      }
      for (const value of [durationMs, apiEquivalentUsd, coderabbitEquivalentUsd]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(coderabbitEquivalentUsd).toBeGreaterThan(0);
      expect(durationMs).toBeLessThan(300_000);
      expect(apiEquivalentUsd / coderabbitEquivalentUsd).toBeLessThan(0.5);
    }
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
    expect(developmentRuns.runs).toContainEqual(expect.objectContaining({
      artifactSha256: "ef1e86c5e388b9ffab1ca51f9b5e9b45709116171ee662f99bd56a18a314f79b",
      status: "complete-isolated-blind",
      matchedReferenceRoots: 5,
      coderabbitMatchedRoots: 4,
      coderabbitMissedSeededRoots: 1,
      falsePositives: 0,
    }));
    expect(developmentRuns.runs).toContainEqual(expect.objectContaining({
      artifactSha256: "52fa90df279e0eea93b7091bfa7e7e56e7e52ab8b55b41c08516f781e45bd31a",
      status: "complete-isolated-updates",
      negativeControlsRejected: 5,
      negativeControlsTotal: 5,
      updateNoisePerUpdate: 0,
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
    const blindCaseIds = new Set(manifest.holdoutCases
      .map(({pr, head}) => `${pr}:${head}`)
      .filter((id) => manifest.blindHoldoutSnapshots.includes(id)));
    const blindNegativeIds = new Set(manifest.holdoutNegativeControls
      .map(({pr, head}) => `${pr}:${head}`)
      .filter((id) => manifest.blindNegativeSnapshots.includes(id)));
    expect(blindCaseIds).toEqual(new Set(manifest.blindHoldoutSnapshots));
    expect(blindCaseIds.size).toBe(manifest.blindHoldoutSnapshots.length);
    expect(blindNegativeIds).toEqual(new Set(manifest.blindNegativeSnapshots));
    expect(blindNegativeIds.size).toBe(manifest.blindNegativeSnapshots.length);
    const blindCases = manifest.holdoutCases.filter(({pr, head}) => blindCaseIds.has(`${pr}:${head}`));
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
    const selectedDiffIndex = source.indexOf("const selectedDiff = selectDiffFiles(diff, selectedFiles)");
    const reviewChunksIndex = source.indexOf("const reviewChunks = chunkDiffByFile(selectedDiff, 50000)");
    expect(selectedDiffIndex).toBeGreaterThanOrEqual(0);
    expect(reviewChunksIndex).toBeGreaterThan(selectedDiffIndex);
    expect(source).toContain("const reviewedPaths = changedHeadPaths(diff)");
    expect(source).toContain(".slice(offset, offset + EVAL_CHUNK_CONCURRENCY)");
    expect(source).toContain("left.snapshotId.localeCompare(right.snapshotId) || left.id.localeCompare(right.id)");
    expect(source).toContain("DISCOVERY CONTRACT EVIDENCE");
    expect(source).toContain("JSON.stringify({file: candidate.file, rootCause: candidate.rootCause})");
    expect(source).not.toContain("CANDIDATE: ${JSON.stringify(candidate)}");
  });
});
