import { createHash } from "crypto";

export type EvalLabel = { file: string; rootCause: string; source?: string };
export type EvalCase = { pr: number; head: string; generation?: number; changedFiles?: string[]; labels: EvalLabel[] };
export type NegativeCase = {
  pr: number;
  head: string;
  rejectedCandidates: Array<{ file: string; rootCause: string; source?: string }>;
};

export type EvalManifest = {
  blindHoldoutSnapshots: string[];
  blindNegativeSnapshots: string[];
  blindUpdatePairs: Array<{before: string; after: string}>;
  holdoutCases: EvalCase[];
  holdoutNegativeControls: NegativeCase[];
};

export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export const LUNA_API_PRICING = {
  source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  inputUsdPerMillion: 0.2,
  cachedInputUsdPerMillion: 0.02,
  outputUsdPerMillion: 1.2,
} as const;

export function lunaApiCost(usage: TokenUsage): number {
  const longContext = usage.inputTokens > 272_000;
  return (
    Math.max(0, usage.inputTokens - usage.cachedInputTokens) * LUNA_API_PRICING.inputUsdPerMillion * (longContext ? 2 : 1)
    + usage.cachedInputTokens * LUNA_API_PRICING.cachedInputUsdPerMillion * (longContext ? 2 : 1)
    + usage.outputTokens * LUNA_API_PRICING.outputUsdPerMillion * (longContext ? 1.5 : 1)
  ) / 1_000_000;
}

type ArtifactRun = {
  id: string;
  model: "gpt-5.6-luna";
  effort: "high" | "medium" | "low";
  transport: "api" | "subscription";
  promptSha256: string;
  pipelineSha: string;
  manifestSha256: string;
  durationMs: number;
  snapshotDurationsMs: Record<string, number>;
  costUsd: number;
  coderabbitEquivalentUsd: number;
  reviewedFiles: number;
  reviewedFileIds: string[];
  calls: number;
  benchmarkCalls: number;
  callRecords: Array<{
    id: string;
    snapshotId: string;
    durationMs: number;
    production: boolean;
    provider: string;
    auth: string;
    model: string;
    effort: string;
    usage: TokenUsage;
  }>;
  usage: TokenUsage;
  benchmarkUsage: TokenUsage;
  selection: {prs: number[]; heads: string[]; files: string[]; chunks: number[]};
};

export type EvaluationArtifact = {
  schemaVersion: 2;
  run: ArtifactRun;
  results: unknown[];
};

export type GradedFinding = {
  id: string;
  disposition: "matched" | "additional-real" | "false-positive" | "suggestion";
  matchedLabelIds?: string[];
  evidence?: string;
  introducedByUpdate?: boolean;
  introductionEvidence?: string;
};

export type EvaluationGrade = {
  schemaVersion: 2;
  artifactSha256: string;
  findings: GradedFinding[];
};

export type EvaluationScore = {
  runId: string;
  artifactSha256: string;
  callIds: string[];
  configurationId: string;
  expectedRoots: number;
  caughtRoots: number;
  recall: number;
  sourceRecall: {coderabbit: number; greptile: number};
  precision: number;
  falsePositives: number;
  blockingFalsePositives: number;
  suggestionsPerSnapshot: number;
  negativeControlRejectionRate: number;
  sourceNegativeRejectionRate: {coderabbit: number; greptile: number};
  updateNoisePerUpdate: number;
  durationMs: number;
  costRatio: number;
  complete: boolean;
  passes: {
    quality: boolean;
    precision: boolean;
    updateStability: boolean;
    latency: boolean;
    cost: boolean;
  };
};

export type ArtifactFinding = {
  id: string;
  pr: number;
  head: string;
  severity: "high" | "medium" | "low" | "suggestion";
  file?: string;
  line?: number;
  description: string;
  recommendation: string;
};

export const snapshotId = (pr: number, head: string): string => `${pr}:${head}`;
export const labelId = (testCase: EvalCase, index: number): string =>
  `${snapshotId(testCase.pr, testCase.head)}:label:${index + 1}`;
export const negativeControlId = (testCase: NegativeCase, index: number): string =>
  `${snapshotId(testCase.pr, testCase.head)}:negative:${index + 1}`;
export const negativeSnapshotDurationId = (pr: number, head: string): string =>
  `${snapshotId(pr, head)}:negative-controls`;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

export function artifactFindingId(
  pr: number,
  head: string,
  severity: ArtifactFinding["severity"],
  finding: Record<string, unknown>
): string {
  return createHash("sha256").update(JSON.stringify({
    pr,
    head,
    severity,
    file: typeof finding.file === "string" ? finding.file : null,
    line: typeof finding.line === "number" ? finding.line : null,
    description: finding.description,
    recommendation: typeof finding.recommendation === "string" ? finding.recommendation : "",
  })).digest("hex");
}

export function artifactFindings(artifact: EvaluationArtifact): ArtifactFinding[] {
  const findings: ArtifactFinding[] = [];
  const ids = new Set<string>();
  for (const rawResult of artifact.results) {
    const result = asObject(rawResult);
    if (!result || typeof result.pr !== "number" || typeof result.head !== "string" || !Array.isArray(result.chunks)) continue;
    for (const rawChunk of result.chunks) {
      const response = asObject(asObject(rawChunk)?.response);
      if (!response) continue;
      for (const severity of ["high", "medium", "low", "suggestion"] as const) {
        const key = severity === "suggestion" ? "suggestions" : severity;
        const rawFindings = response[key];
        if (!Array.isArray(rawFindings)) continue;
        for (const rawFinding of rawFindings) {
          const finding = asObject(rawFinding);
          if (!finding || typeof finding.description !== "string" || !finding.description.trim()) {
            throw new Error(`Invalid ${severity} finding in ${snapshotId(result.pr, result.head)}`);
          }
          const id = artifactFindingId(result.pr, result.head, severity, finding);
          if (ids.has(id)) throw new Error(`Duplicate emitted finding: ${id}`);
          ids.add(id);
          findings.push({
            id,
            pr: result.pr,
            head: result.head,
            severity,
            file: typeof finding.file === "string" ? finding.file : undefined,
            line: typeof finding.line === "number" ? finding.line : undefined,
            description: finding.description,
            recommendation: typeof finding.recommendation === "string" ? finding.recommendation : "",
          });
        }
      }
    }
  }
  return findings;
}

function validateArtifact(artifact: EvaluationArtifact, artifactSha256: string): void {
  if (artifact.schemaVersion !== 2) throw new Error("Unsupported evaluation artifact schema");
  if (artifact.run.model !== "gpt-5.6-luna") throw new Error("Artifact model is not the frozen Luna model");
  if (!["high", "medium", "low"].includes(artifact.run.effort)) throw new Error("Artifact effort must be high, medium, or low");
  if (artifact.run.transport !== "api" && artifact.run.transport !== "subscription") {
    throw new Error("Artifact transport must be api or subscription");
  }
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) throw new Error("artifactSha256 must be a full SHA-256");
  if (!/^[a-f0-9]{64}$/.test(artifact.run.promptSha256)) throw new Error("promptSha256 must be a full SHA-256");
  if (!/^[a-f0-9]{40}$/.test(artifact.run.pipelineSha)) throw new Error("pipelineSha must be a full Git commit SHA");
  if (!/^[a-f0-9]{64}$/.test(artifact.run.manifestSha256)) throw new Error("manifestSha256 must be a full SHA-256");
  if (!Number.isInteger(artifact.run.reviewedFiles) || artifact.run.reviewedFiles <= 0) {
    throw new Error("reviewedFiles must be a positive integer");
  }
  if (new Set(artifact.run.reviewedFileIds).size !== artifact.run.reviewedFileIds.length || artifact.run.reviewedFileIds.length !== artifact.run.reviewedFiles) {
    throw new Error("reviewedFiles must match unique reviewedFileIds");
  }
  if (!Number.isInteger(artifact.run.calls) || artifact.run.calls <= 0) {
    throw new Error("calls must be a positive integer");
  }
  if (!Number.isFinite(artifact.run.durationMs) || artifact.run.durationMs < 0 ||
      !Number.isFinite(artifact.run.costUsd) || artifact.run.costUsd < 0 ||
      artifact.run.coderabbitEquivalentUsd !== artifact.run.reviewedFiles * 0.25) {
    throw new Error("Run duration and cost must be non-negative; CodeRabbit baseline must equal $0.25 per reviewed file");
  }
  if (artifact.run.callRecords.length !== artifact.run.benchmarkCalls) throw new Error("benchmarkCalls must equal the full call record count");
  const productionCalls = artifact.run.callRecords.filter(({production}) => production);
  if (productionCalls.length !== artifact.run.calls) throw new Error("calls must equal the production call record count");
  const callIds = new Set<string>();
  const summedUsage = {inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0};
  for (const call of artifact.run.callRecords) {
    if (!call.id.trim() || callIds.has(call.id)) throw new Error(`Invalid or duplicate native call id: ${call.id}`);
    if (!call.snapshotId.trim()) throw new Error(`Missing snapshot id for ${call.id}`);
    if (call.provider !== "codex" || call.auth !== artifact.run.transport || call.model !== artifact.run.model || call.effort !== artifact.run.effort) {
      throw new Error(`Call provenance does not match the frozen Luna configuration: ${call.id}`);
    }
    callIds.add(call.id);
    if (!Number.isInteger(call.durationMs) || call.durationMs < 0) throw new Error(`Invalid call duration: ${call.id}`);
    for (const key of Object.keys(summedUsage) as Array<keyof TokenUsage>) {
      if (!Number.isInteger(call.usage[key]) || call.usage[key] < 0) throw new Error(`Invalid ${key} for ${call.id}`);
      summedUsage[key] += call.usage[key];
    }
    if (call.usage.cachedInputTokens > call.usage.inputTokens || call.usage.reasoningOutputTokens > call.usage.outputTokens) {
      throw new Error(`Impossible token usage for ${call.id}`);
    }
  }
  if ((Object.keys(summedUsage) as Array<keyof TokenUsage>).some((key) => summedUsage[key] !== artifact.run.benchmarkUsage[key])) {
    throw new Error("Benchmark usage does not match native call records");
  }
  const productionUsage = productionCalls.reduce((total, call) => {
    for (const key of Object.keys(total) as Array<keyof TokenUsage>) total[key] += call.usage[key];
    return total;
  }, {inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0});
  if ((Object.keys(productionUsage) as Array<keyof TokenUsage>).some((key) => productionUsage[key] !== artifact.run.usage[key])) {
    throw new Error("Production usage does not match native call records");
  }
  const expectedCost = artifact.run.transport === "api"
    ? productionCalls.reduce((total, call) => total + lunaApiCost(call.usage), 0)
    : 0;
  if (Math.abs(expectedCost - artifact.run.costUsd) > 1e-9) throw new Error("costUsd does not match pinned Luna pricing and call usage");
  for (const values of Object.values(artifact.run.selection)) {
    if (!Array.isArray(values)) throw new Error("Invalid evaluation selection metadata");
  }
  for (const [id, duration] of Object.entries(artifact.run.snapshotDurationsMs)) {
    if (!id || !Number.isInteger(duration) || duration < 0) throw new Error(`Invalid snapshot duration: ${id}`);
  }
}

export function scoreEvaluation(
  manifest: EvalManifest,
  manifestSha256: string,
  artifact: EvaluationArtifact,
  artifactSha256: string,
  grade: EvaluationGrade
): EvaluationScore {
  validateArtifact(artifact, artifactSha256);
  if (artifact.run.manifestSha256 !== manifestSha256) throw new Error("Artifact does not match the scored manifest SHA-256");
  if (grade.schemaVersion !== 2) throw new Error("Unsupported evaluation grade schema");
  if (grade.artifactSha256 !== artifactSha256) throw new Error("Grade does not match the raw artifact SHA-256");

  const blindPositiveIds = new Set(manifest.blindHoldoutSnapshots);
  const blindNegativeIds = new Set(manifest.blindNegativeSnapshots);
  const blindCases = manifest.holdoutCases.filter(({pr, head}) => blindPositiveIds.has(snapshotId(pr, head)));
  const blindNegativeCases = manifest.holdoutNegativeControls.filter(({pr, head}) => blindNegativeIds.has(snapshotId(pr, head)));
  if (blindCases.length !== blindPositiveIds.size || blindNegativeCases.length !== blindNegativeIds.size) {
    throw new Error("Blind snapshot allowlist references an unknown or duplicate corpus case");
  }
  const blindSnapshotIds = new Set(blindCases.map(({pr, head}) => snapshotId(pr, head)));
  const positiveSnapshots = new Set<string>();
  let artifactHasErrors = false;
  for (const rawResult of artifact.results) {
    const result = asObject(rawResult);
    if (!result || typeof result.pr !== "number" || typeof result.head !== "string") {
      artifactHasErrors = true;
      continue;
    }
    const id = snapshotId(result.pr, result.head);
    if (Array.isArray(result.chunks)) {
      if (!blindSnapshotIds.has(id) || positiveSnapshots.has(id)) throw new Error(`Unknown or duplicate positive snapshot: ${id}`);
      positiveSnapshots.add(id);
      if (result.chunks.some((chunk) => !asObject(asObject(chunk)?.response))) artifactHasErrors = true;
    } else if (result.kind === "candidate-rejection") {
      // Validated against the manifest below.
    } else {
      artifactHasErrors = true;
    }
  }

  const expectedLabels = new Set<string>();
  const labelsById = new Map<string, {testCase: EvalCase; label: EvalLabel}>();
  for (const testCase of blindCases) {
    if (!positiveSnapshots.has(snapshotId(testCase.pr, testCase.head))) continue;
    testCase.labels.forEach((label, index) => {
      const id = labelId(testCase, index);
      expectedLabels.add(id);
      labelsById.set(id, {testCase, label});
    });
  }

  const emittedFindings = artifactFindings(artifact);
  const updateSnapshotIds = new Set<string>();
  for (const {before, after} of manifest.blindUpdatePairs) {
    const beforeCase = blindCases.find(({pr, head}) => snapshotId(pr, head) === before);
    const afterCase = blindCases.find(({pr, head}) => snapshotId(pr, head) === after);
    if (!beforeCase || !afterCase || beforeCase.pr !== afterCase.pr || before === after || updateSnapshotIds.has(after)) {
      throw new Error(`Invalid blind update pair: ${before} -> ${after}`);
    }
    updateSnapshotIds.add(after);
  }
  const emittedById = new Map(emittedFindings.map((finding) => [finding.id, finding]));
  const gradesById = new Map<string, GradedFinding>();
  for (const finding of grade.findings) {
    if (!emittedById.has(finding.id)) throw new Error(`Grade references unknown finding: ${finding.id}`);
    if (gradesById.has(finding.id)) throw new Error(`Duplicate finding grade: ${finding.id}`);
    gradesById.set(finding.id, finding);
  }
  if (gradesById.size !== emittedFindings.length) throw new Error("Every emitted finding must be graded exactly once");

  const matched = new Set<string>();
  let additionalReal = 0;
  let matchedFindings = 0;
  let falsePositives = 0;
  let blockingFalsePositives = 0;
  let suggestions = 0;
  for (const finding of emittedFindings) {
    const adjudication = gradesById.get(finding.id)!;
    const updateFinding = updateSnapshotIds.has(snapshotId(finding.pr, finding.head));
    if (updateFinding && ["matched", "additional-real"].includes(adjudication.disposition)) {
      if (typeof adjudication.introducedByUpdate !== "boolean") {
        throw new Error(`Real update finding ${finding.id} must state whether the update introduced it`);
      }
      if (adjudication.introducedByUpdate && !adjudication.introductionEvidence?.trim()) {
        throw new Error(`Introduced update finding ${finding.id} needs exact base/head evidence`);
      }
      if (!adjudication.introducedByUpdate && adjudication.introductionEvidence !== undefined) {
        throw new Error(`introductionEvidence is invalid for finding ${finding.id}`);
      }
    } else if (adjudication.introducedByUpdate !== undefined) {
      throw new Error(`introducedByUpdate is invalid for finding ${finding.id}`);
    } else if (adjudication.introductionEvidence !== undefined) {
      throw new Error(`introductionEvidence is invalid for finding ${finding.id}`);
    }
    if (adjudication.disposition === "matched") {
      if (adjudication.matchedLabelIds?.length !== 1) throw new Error(`Matched finding ${finding.id} must name exactly one label`);
      const id = adjudication.matchedLabelIds[0];
      const expected = labelsById.get(id);
      if (!expected) throw new Error(`Finding ${finding.id} references unknown label ${id}`);
      if (matched.has(id)) throw new Error(`Label matched more than once: ${id}`);
      if (finding.pr !== expected.testCase.pr || finding.head !== expected.testCase.head || finding.file !== expected.label.file) {
        throw new Error(`Finding ${finding.id} does not match label snapshot and file`);
      }
      matched.add(id);
      matchedFindings += 1;
    } else if (adjudication.disposition === "additional-real") {
      if (!adjudication.evidence?.trim()) throw new Error(`Additional real finding ${finding.id} needs exact-head evidence`);
      additionalReal += 1;
    } else if (adjudication.disposition === "false-positive") {
      falsePositives += 1;
      if (finding.severity === "high") blockingFalsePositives += 1;
    } else {
      if (finding.severity !== "suggestion") {
        throw new Error(`Only an emitted suggestion can be graded as a suggestion: ${finding.id}`);
      }
      suggestions += 1;
    }
  }

  const negativeCasesBySnapshot = new Map(blindNegativeCases.map((testCase) => [
    snapshotId(testCase.pr, testCase.head),
    testCase,
  ]));
  const negativeDecisions = new Map<string, boolean>();
  for (const rawResult of artifact.results) {
    const result = asObject(rawResult);
    if (!result || result.kind !== "candidate-rejection" || typeof result.pr !== "number" || typeof result.head !== "string") continue;
    const testCase = negativeCasesBySnapshot.get(snapshotId(result.pr, result.head));
    const candidate = asObject(result.candidate);
    const decision = asObject(result.decision);
    if (!testCase || !candidate || typeof decision?.approved !== "boolean") throw new Error("Invalid negative-control result");
    const index = testCase.rejectedCandidates.findIndex(({file, rootCause}) => file === candidate.file && rootCause === candidate.rootCause);
    if (index < 0) throw new Error(`Unknown negative control in ${snapshotId(result.pr, result.head)}`);
    const id = negativeControlId(testCase, index);
    if (negativeDecisions.has(id)) throw new Error(`Duplicate negative control: ${id}`);
    negativeDecisions.set(id, !decision.approved);
  }
  const expectedNegativeIds = blindNegativeCases.flatMap((testCase) =>
    testCase.rejectedCandidates.map((_candidate, index) => negativeControlId(testCase, index))
  );
  const rejectedNegatives = [...negativeDecisions.values()].filter(Boolean).length;
  const sourceLabelIds = {
    coderabbit: [...labelsById].filter(([, {label}]) => label.source === "CodeRabbit").map(([id]) => id),
    greptile: [...labelsById].filter(([, {label}]) => label.source === "Greptile").map(([id]) => id),
  };
  const sourceRecall = {
    coderabbit: ratio(sourceLabelIds.coderabbit.filter((id) => matched.has(id)).length, sourceLabelIds.coderabbit.length),
    greptile: ratio(sourceLabelIds.greptile.filter((id) => matched.has(id)).length, sourceLabelIds.greptile.length),
  };
  const sourceNegativeIds = {
    coderabbit: blindNegativeCases.flatMap((testCase) => testCase.rejectedCandidates.flatMap((candidate, index) =>
      candidate.source === "CodeRabbit" ? [negativeControlId(testCase, index)] : []
    )),
    greptile: blindNegativeCases.flatMap((testCase) => testCase.rejectedCandidates.flatMap((candidate, index) =>
      candidate.source === "Greptile" ? [negativeControlId(testCase, index)] : []
    )),
  };
  const sourceNegativeRejectionRate = {
    coderabbit: ratio(sourceNegativeIds.coderabbit.filter((id) => negativeDecisions.get(id)).length, sourceNegativeIds.coderabbit.length),
    greptile: ratio(sourceNegativeIds.greptile.filter((id) => negativeDecisions.get(id)).length, sourceNegativeIds.greptile.length),
  };

  const evaluatedUpdates = [...updateSnapshotIds].filter((id) => positiveSnapshots.has(id));
  const updateNoiseFindings = emittedFindings.filter((finding) =>
    updateSnapshotIds.has(snapshotId(finding.pr, finding.head))
    && (gradesById.get(finding.id)!.introducedByUpdate !== true)
  );
  const updateBlockingFalsePositives = updateNoiseFindings.filter((finding) =>
    finding.severity === "high" && gradesById.get(finding.id)?.disposition === "false-positive"
  ).length;

  const expectedSnapshotIds = new Set([
    ...blindSnapshotIds,
    ...blindNegativeCases.map(({pr, head}) => negativeSnapshotDurationId(pr, head)),
  ]);
  const durationIds = new Set(Object.keys(artifact.run.snapshotDurationsMs));
  if ([...durationIds].some((id) => !expectedSnapshotIds.has(id))) throw new Error("Unknown snapshot duration");
  if (artifact.run.callRecords.some((call) => !expectedSnapshotIds.has(call.snapshotId))) throw new Error("Call belongs to an unknown snapshot");
  if ([...blindSnapshotIds].some((id) => !artifact.run.callRecords.some((call) => call.production && call.snapshotId === id))) {
    throw new Error("Every positive snapshot needs a production call");
  }
  for (const testCase of blindNegativeCases) {
    const id = negativeSnapshotDurationId(testCase.pr, testCase.head);
    const calls = artifact.run.callRecords.filter((call) => !call.production && call.snapshotId === id);
    if (calls.length !== testCase.rejectedCandidates.length) throw new Error(`Negative call count mismatch for ${id}`);
  }
  if (artifact.run.callRecords.some((call) => call.production !== blindSnapshotIds.has(call.snapshotId))) {
    throw new Error("Call production classification does not match its snapshot");
  }
  const expectedReviewedFileIds = blindCases.flatMap((testCase) => {
    if (!testCase.changedFiles?.length) throw new Error(`Blind snapshot is missing changedFiles: ${snapshotId(testCase.pr, testCase.head)}`);
    return testCase.changedFiles.map((file) => `${snapshotId(testCase.pr, testCase.head)}:${file}`);
  }).sort();
  const actualReviewedFileIds = [...artifact.run.reviewedFileIds].sort();
  if (JSON.stringify(actualReviewedFileIds) !== JSON.stringify(expectedReviewedFileIds)) {
    throw new Error("Reviewed files do not match the frozen changed-file inventory");
  }
  const fullPositiveSet = blindCases.every(({pr, head}) => positiveSnapshots.has(snapshotId(pr, head)));
  const fullNegativeSet = expectedNegativeIds.every((id) => negativeDecisions.has(id));
  const fullDurations = [...expectedSnapshotIds].every((id) => durationIds.has(id));
  const unfiltered = Object.values(artifact.run.selection).every((values) => values.length === 0);
  const complete = !artifactHasErrors
    && unfiltered
    && artifact.run.transport === "api"
    && fullPositiveSet
    && sourceLabelIds.coderabbit.length >= 10
    && fullNegativeSet
    && sourceNegativeIds.coderabbit.length >= 10
    && fullDurations
    && evaluatedUpdates.length >= 3;
  const recall = ratio(matched.size, expectedLabels.size);
  const precisionNumerator = matchedFindings + additionalReal;
  const precision = ratio(precisionNumerator, precisionNumerator + falsePositives);
  const negativeControlRejectionRate = ratio(rejectedNegatives, expectedNegativeIds.length);
  const updateNoisePerUpdate = ratio(updateNoiseFindings.length, evaluatedUpdates.length);
  const durationMs = Math.max(0, ...[...blindSnapshotIds].map((id) => artifact.run.snapshotDurationsMs[id] || 0));
  const costRatio = artifact.run.costUsd / artifact.run.coderabbitEquivalentUsd;
  const suggestionsPerSnapshot = ratio(suggestions, positiveSnapshots.size);

  return {
    runId: artifact.run.id,
    artifactSha256,
    callIds: artifact.run.callRecords.map(({id}) => id),
    configurationId: [artifact.run.model, artifact.run.effort, artifact.run.transport, artifact.run.promptSha256, artifact.run.pipelineSha, artifact.run.manifestSha256].join(":"),
    expectedRoots: expectedLabels.size,
    caughtRoots: matched.size,
    recall,
    sourceRecall,
    precision,
    falsePositives,
    blockingFalsePositives,
    suggestionsPerSnapshot,
    negativeControlRejectionRate,
    sourceNegativeRejectionRate,
    updateNoisePerUpdate,
    durationMs,
    costRatio,
    complete,
    passes: {
      quality: complete && recall >= 0.8 && sourceRecall.coderabbit >= 0.8,
      precision: complete && precision >= 0.7 && blockingFalsePositives === 0 && negativeControlRejectionRate >= 0.9
        && sourceNegativeRejectionRate.coderabbit >= 0.9 && suggestionsPerSnapshot <= 1,
      updateStability: complete && updateBlockingFalsePositives === 0 && updateNoisePerUpdate <= 0.25,
      latency: complete && durationMs < 300_000,
      cost: complete && costRatio < 0.5,
    },
  };
}

export function promotionReady(scores: EvaluationScore[]): boolean {
  const callIds = scores.flatMap(({callIds}) => callIds);
  return scores.length >= 3
    && new Set(scores.map(({runId}) => runId)).size === scores.length
    && new Set(scores.map(({artifactSha256}) => artifactSha256)).size === scores.length
    && new Set(callIds).size === callIds.length
    && new Set(scores.map(({configurationId}) => configurationId)).size === 1
    && scores.every((score) => score.complete && Object.values(score.passes).every(Boolean));
}
