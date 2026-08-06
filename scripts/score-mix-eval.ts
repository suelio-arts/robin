import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import { EvalManifest, EvaluationArtifact, EvaluationGrade, artifactFindings, promotionReady, scoreEvaluation } from "../src/eval-score";

const [manifestPath, ...runPaths] = process.argv.slice(2);
if (manifestPath === "--inventory") {
  if (runPaths.length !== 1) throw new Error("Usage: score-mix-eval --inventory <artifact.json>");
  const bytes = readFileSync(resolve(runPaths[0]));
  const artifact = JSON.parse(bytes.toString("utf8")) as EvaluationArtifact;
  process.stdout.write(`${JSON.stringify({
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    findings: artifactFindings(artifact),
  }, null, 2)}\n`);
  process.exit(0);
}
if (!manifestPath || runPaths.length === 0 || runPaths.length % 2 !== 0) {
  throw new Error("Usage: score-mix-eval <manifest.json> <artifact.json> <grade.json> [artifact.json grade.json ...]");
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolve(path), "utf8")) as T;
const manifestBytes = readFileSync(resolve(manifestPath));
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const manifest = JSON.parse(manifestBytes.toString("utf8")) as EvalManifest;
const scores = [];
for (let index = 0; index < runPaths.length; index += 2) {
  const artifactBytes = readFileSync(resolve(runPaths[index]));
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  scores.push(scoreEvaluation(
    manifest,
    manifestSha256,
    JSON.parse(artifactBytes.toString("utf8")) as EvaluationArtifact,
    artifactSha256,
    readJson<EvaluationGrade>(runPaths[index + 1])
  ));
}
process.stdout.write(`${JSON.stringify({scores, promotionReady: promotionReady(scores)}, null, 2)}\n`);
