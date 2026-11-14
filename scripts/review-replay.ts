/**
 * Replays Robin's production review of one base/head pair from a local checkout
 * and writes findings plus per-stage and per-seat timing as JSON. It never posts:
 * the GitHub token only reads files the local checkout lacks.
 *
 *   npm run review:replay -- --workspace DIR --repo OWNER/NAME --base SHA --head SHA --out FILE
 *
 * Defaults match mix-mono's production Robin seats and inputs. Repository search
 * greps the workspace's HEAD, as on the runner: point HEAD at the commit the
 * replayed run checked out. Prior Robin findings are not replayed.
 */
import { Octokit } from "@octokit/rest";
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { parseArgs } from "util";
import { DEFAULT_LLM_TIMEOUT_MS } from "../src/config";
import { createCouncilSeat } from "../src/council";
import { filterDiff } from "../src/diff-filter";
import { GitUtils } from "../src/git-utils";
import { LLMClient } from "../src/llm-client";
import { DEFAULT_CONFIG_FILE, resolveJsonResponseMode, resolveMaxDiffSize } from "../src/repo-config";
import { PIECE_CONCURRENCY, reviewPieces, runReviewCore, seatCalls } from "../src/review-core";
import { loadRepoConfig, loadReviewInstructions } from "../src/review-settings";
import { ReviewTimings } from "../src/review-timing";

const {values: args} = parseArgs({options: {
  workspace: {type: "string"},
  repo: {type: "string"},
  base: {type: "string"},
  head: {type: "string"},
  out: {type: "string"},
  model: {type: "string", default: "sol-6.1-medium-subscription"},
  "council-model": {type: "string", default: "opus-5-5-low-subscription"},
  "council-fallback-model": {type: "string", default: "deepseek-v4.1-flash-deploy"},
  effort: {type: "string", default: "medium"},
  "max-diff-size": {type: "string", default: "50000"},
  "instructions-file": {type: "string", default: ".github/code-reviewer.md"},
  concurrency: {type: "string", default: String(PIECE_CONCURRENCY)},
}});
const {workspace, repo: fullName, base, head, out} = args;
if (!workspace || !fullName || !base || !head || !out) {
  throw new Error("Required: --workspace --repo --base --head --out");
}
if (!["low", "medium", "high"].includes(args.effort)) throw new Error(`Invalid --effort: ${args.effort}`);
const [owner, repo] = fullName.split("/");
const pieceConcurrency = Number(args.concurrency);
if (!Number.isInteger(pieceConcurrency) || pieceConcurrency < 1) throw new Error(`Invalid --concurrency: ${args.concurrency}`);

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN || execFileSync("gh", ["auth", "token"], {encoding: "utf8"}).trim();
  const git = new GitUtils(new Octokit({auth: token}) as never, workspace);
  const timings = new ReviewTimings();
  const repoConfig = await loadRepoConfig(git, owner, repo, DEFAULT_CONFIG_FILE, base!);
  const maxDiffSize = resolveMaxDiffSize(args["max-diff-size"], repoConfig);
  const diff = await git.getPullRequestDiff(base!, head!);
  const {filtered, removedFiles} = filterDiff(diff, repoConfig.skipPaths || []);
  const reviewDiff = filtered.trim() ? filtered : diff;
  const pieces = reviewPieces(reviewDiff, maxDiffSize).length;
  console.log(`Diff size: ${reviewDiff.length} chars in ${pieces} piece(s); ${removedFiles.length} file(s) skipped: ${removedFiles.join(", ")}`);
  const reviewInstructions = await loadReviewInstructions(git, owner, repo, "", args["instructions-file"], base!);
  const seat = (model: string, effort?: "low" | "medium" | "high") =>
    new LLMClient("rolly-agent", "", model, undefined, DEFAULT_LLM_TIMEOUT_MS, undefined, undefined, effort);
  const llm = seat(args.model, args.effort as "low" | "medium" | "high");
  const council = createCouncilSeat({llm: seat(args["council-model"]), model: args["council-model"]},
    {llm: seat(args["council-fallback-model"]), model: args["council-fallback-model"]});
  const result = await runReviewCore({
    git, owner, repo, baseRef: base!, headRef: head!, reviewDiff, maxDiffSize, pieceConcurrency, reviewInstructions,
    jsonResponseMode: resolveJsonResponseMode("", repoConfig), llm, council, timings,
    loadPriorFindings: async () => "",
  });
  const seats = seatCalls(llm, args.model, council);
  const receipt = timings.receipt(seats);
  console.log(receipt);
  writeFileSync(out!, `${JSON.stringify({
    base, head, pieceConcurrency, diffChars: reviewDiff.length, pieces, removedFiles,
    startedAt: timings.startedAt, receipt, spans: timings.spans, seats,
    evidenceRequests: result.evidenceRequests, usedFollowups: result.usedFollowups, findings: result.findings,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
