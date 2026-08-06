import {
  EvalManifest,
  EvaluationArtifact,
  EvaluationGrade,
  artifactFindings,
  labelId,
  lunaApiCost,
  negativeSnapshotDurationId,
  promotionReady,
  scoreEvaluation,
  snapshotId,
} from "./eval-score";

const manifest: EvalManifest = {
  blindHoldoutSnapshots: ["a", "e", "f", "g"].map((head) => snapshotId(1, head.repeat(40))),
  blindNegativeSnapshots: [snapshotId(2, "b".repeat(40))],
  blindUpdatePairs: [["a", "e"], ["e", "f"], ["f", "g"]].map(([before, after]) => ({
    before: snapshotId(1, before.repeat(40)),
    after: snapshotId(1, after.repeat(40)),
  })),
  holdoutCases: ["a", "e", "f", "g"].map((head) => ({pr: 1, head: head.repeat(40), changedFiles: head === "a"
    ? Array.from({length: 10}, (_unused, index) => `${index}.ts`)
    : [`empty-${head}.ts`], labels: head === "a"
    ? Array.from({length: 10}, (_unused, index) => ({file: `${index}.ts`, rootCause: `root ${index}`, source: index % 2 ? "Greptile" : "CodeRabbit"}))
    : []})),
  holdoutNegativeControls: [{pr: 2, head: "b".repeat(40), rejectedCandidates:
    Array.from({length: 10}, (_unused, index) => ({
      file: `negative-${index}.ts`,
      rootCause: `not a bug ${index}`,
      source: index % 2 ? "Greptile" : "CodeRabbit",
    }))}],
};
const manifestSha256 = "e".repeat(64);

function artifact(id: string, noisy = false): EvaluationArtifact {
  const positive = manifest.holdoutCases[0];
  const negative = manifest.holdoutNegativeControls[0];
  const reviewed = positive.labels.map((label, index) => ({
    file: label.file,
    line: index + 1,
    description: label.rootCause,
    recommendation: "fix it",
  }));
  if (noisy) reviewed.push({file: "noise.ts", line: 3, description: "not real", recommendation: "remove it"});
  const usage = {inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 50};
  const productionCalls = manifest.holdoutCases.map(({pr, head}, index) => ({
    id: `${id}-review-${index}`,
    snapshotId: snapshotId(pr, head),
    durationMs: 1_000,
    production: true,
    provider: "codex",
    auth: "api",
    model: "gpt-5.6-luna",
    effort: "high",
    usage,
  }));
  const negativeCalls = negative.rejectedCandidates.map((_candidate, index) => ({
    id: `${id}-negative-${index}`,
    snapshotId: negativeSnapshotDurationId(negative.pr, negative.head),
    durationMs: 1_000,
    production: false,
    provider: "codex",
    auth: "api",
    model: "gpt-5.6-luna",
    effort: "high",
    usage,
  }));
  const callRecords = [...productionCalls, ...negativeCalls];
  const productionUsage = {
    inputTokens: usage.inputTokens * productionCalls.length,
    cachedInputTokens: 0,
    outputTokens: usage.outputTokens * productionCalls.length,
    reasoningOutputTokens: usage.reasoningOutputTokens * productionCalls.length,
  };
  const benchmarkUsage = {
    inputTokens: usage.inputTokens * callRecords.length,
    cachedInputTokens: 0,
    outputTokens: usage.outputTokens * callRecords.length,
    reasoningOutputTokens: usage.reasoningOutputTokens * callRecords.length,
  };
  return {
    schemaVersion: 2,
    run: {
      id,
      model: "gpt-5.6-luna",
      effort: "high",
      transport: "api",
      promptSha256: "c".repeat(64),
      pipelineSha: "d".repeat(40),
      manifestSha256,
      durationMs: 600_000,
      snapshotDurationsMs: Object.fromEntries([
        ...manifest.holdoutCases.map(({pr, head}) => [snapshotId(pr, head), 240_000]),
        [negativeSnapshotDurationId(negative.pr, negative.head), 10_000],
      ]),
      costUsd: productionCalls.reduce((total, call) => total + lunaApiCost(call.usage), 0),
      coderabbitEquivalentUsd: 3.25,
      reviewedFiles: 13,
      reviewedFileIds: manifest.holdoutCases.flatMap(({pr, head, changedFiles = []}) =>
        changedFiles.map((file) => `${snapshotId(pr, head)}:${file}`)
      ),
      calls: productionCalls.length,
      benchmarkCalls: callRecords.length,
      callRecords,
      usage: productionUsage,
      benchmarkUsage,
      selection: {prs: [], heads: [], files: [], chunks: []},
    },
    results: [
      ...manifest.holdoutCases.map(({pr, head}, index) => ({
        pr,
        head,
        chunks: [{response: {high: index === 0 ? reviewed : [], medium: [], low: [], suggestions: []}}],
      })),
      ...negative.rejectedCandidates.map((candidate) => ({
        pr: negative.pr,
        head: negative.head,
        kind: "candidate-rejection",
        candidate,
        decision: {approved: false, reason: "not a bug"},
      })),
    ],
  };
}

function grade(raw: EvaluationArtifact, artifactSha256: string): EvaluationGrade {
  const positive = manifest.holdoutCases[0];
  return {
    schemaVersion: 2,
    artifactSha256,
    findings: artifactFindings(raw).map((finding, index) => index < positive.labels.length ? {
      id: finding.id,
      disposition: "matched" as const,
      matchedLabelIds: [labelId(positive, index)],
    } : {
      id: finding.id,
      disposition: "false-positive" as const,
    }),
  };
}

describe("MIX evaluation scorer", () => {
  it("promotes only three complete threshold-passing artifact-bound runs", () => {
    const scores = ["1", "2", "3"].map((digit) => {
      const raw = artifact(`run-${digit}`);
      const sha = digit.repeat(64);
      return scoreEvaluation(manifest, manifestSha256, raw, sha, grade(raw, sha));
    });
    expect(scores[0]).toMatchObject({complete: true, recall: 1, precision: 1, durationMs: 240_000});
    expect(scores[0].costRatio).toBeLessThan(0.01);
    expect(promotionReady(scores.slice(0, 2))).toBe(false);
    expect(promotionReady(scores)).toBe(true);
    expect(promotionReady([scores[0], {...scores[1], callIds: scores[0].callIds}, scores[2]])).toBe(false);
    expect(promotionReady([
      scores[0],
      {...scores[1], configurationId: `${scores[1].configurationId}:low`},
      scores[2],
    ])).toBe(false);
  });

  it("keeps an emitted high false positive from passing precision", () => {
    const raw = artifact("noisy", true);
    const sha = "4".repeat(64);
    expect(scoreEvaluation(manifest, manifestSha256, raw, sha, grade(raw, sha)).passes.precision).toBe(false);
  });

  it("rejects grades that omit or invent raw findings", () => {
    const raw = artifact("bound");
    const sha = "5".repeat(64);
    const incomplete = grade(raw, sha);
    incomplete.findings.pop();
    expect(() => scoreEvaluation(manifest, manifestSha256, raw, sha, incomplete)).toThrow("Every emitted finding");
  });

  it("cannot promote filtered, mispriced, or cross-file matches", () => {
    const raw = artifact("guarded");
    const sha = "6".repeat(64);
    raw.run.selection.files = ["0.ts"];
    expect(scoreEvaluation(manifest, manifestSha256, raw, sha, grade(raw, sha)).complete).toBe(false);
    raw.run.selection.files = [];
    expect(() => scoreEvaluation(manifest, "f".repeat(64), raw, sha, grade(raw, sha))).toThrow("scored manifest");
    raw.run.costUsd = 0;
    expect(() => scoreEvaluation(manifest, manifestSha256, raw, sha, grade(raw, sha))).toThrow("pinned Luna pricing");
    raw.run.costUsd = raw.run.callRecords.filter(({production}) => production)
      .reduce((total, call) => total + lunaApiCost(call.usage), 0);
    const wrongLabel = grade(raw, sha);
    wrongLabel.findings[0].matchedLabelIds = [labelId(manifest.holdoutCases[0], 1)];
    expect(() => scoreEvaluation(manifest, manifestSha256, raw, sha, wrongLabel)).toThrow("snapshot and file");
  });

  it("requires update findings to say whether that update introduced them", () => {
    const raw = artifact("update");
    const updateResult = raw.results[1] as {chunks: Array<{response: {high: unknown[]}}>};
    updateResult.chunks[0].response.high.push({file: "new.ts", line: 1, description: "real later finding", recommendation: "fix"});
    const sha = "7".repeat(64);
    const adjudication = grade(raw, sha);
    adjudication.findings[adjudication.findings.length - 1] = {
      id: artifactFindings(raw).at(-1)!.id,
      disposition: "additional-real",
      evidence: "verified at this exact head",
    };
    expect(() => scoreEvaluation(manifest, manifestSha256, raw, sha, adjudication)).toThrow("must state whether the update introduced it");
    adjudication.findings.at(-1)!.introducedByUpdate = true;
    expect(() => scoreEvaluation(manifest, manifestSha256, raw, sha, adjudication)).toThrow("exact base/head evidence");
  });

  it("rejects inflated file counts and wrong native model provenance", () => {
    const raw = artifact("tampered");
    const sha = "8".repeat(64);
    raw.run.reviewedFileIds.push(`${snapshotId(1, "a".repeat(40))}:invented.ts`);
    raw.run.reviewedFiles += 1;
    raw.run.coderabbitEquivalentUsd += 0.25;
    expect(() => scoreEvaluation(manifest, manifestSha256, raw, sha, grade(raw, sha))).toThrow("frozen changed-file inventory");
    raw.run.reviewedFileIds.pop();
    raw.run.reviewedFiles -= 1;
    raw.run.coderabbitEquivalentUsd -= 0.25;
    raw.run.callRecords[0].auth = "subscription";
    expect(() => scoreEvaluation(manifest, manifestSha256, raw, sha, grade(raw, sha))).toThrow("Call provenance");
    raw.run.callRecords[0].auth = "api";
    (raw.run as {model: string}).model = "gpt-4o";
    expect(() => scoreEvaluation(manifest, manifestSha256, raw, sha, grade(raw, sha))).toThrow("frozen Luna model");
  });
});
