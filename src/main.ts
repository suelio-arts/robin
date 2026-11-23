import {parseLlmProviderOptions} from "./llm-usage";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { LLMClient } from "./llm-client";
import { councilReceipt, createCouncilSeat } from "./council";
import { type ChatSeat, createPrimarySeat, parseFallbackModels, primaryFallbackReceipt } from "./primary-seat";
import { GitUtils } from "./git-utils";
import { GitHubReviewer, ROBIN_SIGNATURE, formatPriorFindings } from "./github-reviewer";
import { DEFAULT_LLM_TIMEOUT_MS, parseLLMTimeout } from "./config";
import { filterDiff, isWhitespaceOnlyDiff, splitDiffIntoFiles } from "./diff-filter";
import {
  DEFAULT_CONFIG_FILE,
  resolveJsonResponseMode,
  resolveMaxComments,
  resolveMaxDiffSize,
} from "./repo-config";
import { getSummaryPrompt, getHelpMessage } from "./prompts/review-prompts";
import { ReviewerCommand, hasRequiredPermission, parseSlashCommand } from "./commands";
import { isPullRequestReviewEvent, workflowDispatchPrNumber } from "./events";
import {
  ReviewTarget,
  handleReviewFailure,
  postSkippedReceipt,
  resolveReviewTarget,
  setPostedOutputs,
} from "./review-run";
import { PIECE_CONCURRENCY, reviewPieces, runReviewCore, seatCalls } from "./review-core";
import { ReviewTimings } from "./review-timing";
import { loadRepoConfig, loadReviewInstructions } from "./review-settings";
import { statusComment, statusLine } from "./status";

async function run(): Promise<void> {
  let octokit: ReturnType<typeof github.getOctokit> | undefined;
  let statusCommand: "review" | "summary" = "review";
  let target: ReviewTarget | undefined;
  let showStatus: ((line: string) => Promise<void>) | undefined;
  let onJobCancelled: (() => Promise<void>) | undefined;

  try {
    const eventName = github.context.eventName;
    const payload = github.context.payload;
    const expectedHeadSha = core.getInput("expected-head-sha");
    const token = core.getInput("github-token", { required: true });
    octokit = github.getOctokit(token);
    const minCommandPermission = core.getInput("min-command-permission") || "write";

    core.info(`Event: ${eventName}`);

    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    let shouldRun = false;
    let prNumber: number | undefined;
    let command: ReviewerCommand = "review";

    if (isPullRequestReviewEvent(eventName)) {
      if (payload.action === "synchronize") {
        core.info("Skipping pull_request synchronize event. Robin reviews a pull request once; comment /robin for another pass.");
        return;
      }

      shouldRun = true;
      prNumber = payload.pull_request?.number;
    } else if (eventName === "issue_comment") {
      const commentBody: string = payload.comment?.body || "";

      if (!payload.issue?.pull_request) {
        core.info("Issue comment is not on a pull request. Skipping.");
        return;
      }

      if (payload.comment?.user?.type === "Bot") {
        core.info("Ignoring bot comment.");
        return;
      }

      const parsedCommand = parseSlashCommand(commentBody);
      if (!parsedCommand) {
        core.info("No supported slash command found. Skipping.");
        return;
      }

      const commentAuthor = payload.comment?.user?.login;
      const authorized = await isAuthorizedCommenter(
        octokit,
        owner,
        repo,
        commentAuthor,
        minCommandPermission
      );

      if (!authorized) {
        core.warning(
          `Ignoring /${parsedCommand} from ${commentAuthor || "unknown user"}; minimum permission is ${minCommandPermission}.`
        );
        return;
      }

      command = parsedCommand;
      prNumber = payload.issue.number;

      shouldRun = true;
    } else {
      const dispatchedPr = workflowDispatchPrNumber(
        eventName,
        core.getInput("pr-number")
      );
      if (dispatchedPr) {
        shouldRun = true;
        prNumber = dispatchedPr;
      }
    }

    if (!shouldRun || !prNumber) {
      core.info("No matching trigger found. Skipping.");
      return;
    }

    target = await resolveReviewTarget(octokit, owner, repo, prNumber, expectedHeadSha);
    const headSha = target.headSha;
    const reviewTarget = target;
    if (eventName === "issue_comment") {
      await addEyesReaction(octokit, owner, repo, payload.comment?.id);
    }
    if (command === "help") {
      await postHelpComment(octokit, payload);
      return;
    }
    const show = statusComment(octokit, owner, repo, prNumber);
    showStatus = show;
    const skip = async (reason: string) => {
      await show(statusLine.skipped(headSha, reason));
      if (command === "review") await postSkippedReceipt(octokit, reviewTarget, reason);
    };

    const apiKey = core.getInput("llm-api-key") || "ollama";
    const baseUrl = core.getInput("llm-base-url") || "";
    const model = core.getInput("model") || "";
    const fallbackModels = parseFallbackModels(core.getInput("fallback-model") || "");
    const councilModel = core.getInput("council-model") || "";
    const councilFallbackModel = core.getInput("council-fallback-model") || "";
    if (councilFallbackModel && !councilModel) throw new Error("council-fallback-model requires council-model");
    const providerOptions = parseLlmProviderOptions(core.getInput("llm-user"), core.getInput("llm-metadata"), core.getInput("llm-usage-jsonl"));
    if (providerOptions.usageJsonl) core.setOutput("llm-usage-jsonl", providerOptions.usageJsonl);
    const reasoningEffortInput = core.getInput("reasoning-effort") || "";
    if (reasoningEffortInput && !["low", "medium", "high"].includes(reasoningEffortInput)) {
      throw new Error(`Invalid reasoning-effort: ${reasoningEffortInput}`);
    }
    const maxDiffSizeInput = core.getInput("max-diff-size") || "50000";
    const maxCommentsInput = core.getInput("max-comments") || "25";
    const maxOutputTokensInput = core.getInput("max-output-tokens") || "";
    const maxOutputTokens = maxOutputTokensInput ? parseInt(maxOutputTokensInput, 10) : undefined;
    const llmTimeoutMsInput = core.getInput("llm-timeout-ms") || "";
    const { value: llmTimeoutMs, valid: llmTimeoutValid } = parseLLMTimeout(llmTimeoutMsInput);
    if (!llmTimeoutValid) {
      core.warning(`Invalid llm-timeout-ms value "${llmTimeoutMsInput}", using default ${DEFAULT_LLM_TIMEOUT_MS}`);
    }
    const inlineReviewInstructions = core.getInput("review-instructions") || "";
    const reviewInstructionsFile = core.getInput("review-instructions-file") || "";
    const configFile = core.getInput("config-file") || DEFAULT_CONFIG_FILE;
    const jsonResponseModeInput = core.getInput("use-json-response-mode") || "";

    core.info(`Model: ${model || "(not configured)"}${fallbackModels.length > 0 ? ` (fallback: ${fallbackModels.join(" -> ")})` : ""}`);

    core.info(`Running /${command} on PR #${prNumber} in ${owner}/${repo}`);
    statusCommand = command === "summary" ? "summary" : "review";
    const running = statusCommand === "summary" ? () => statusLine.summarizing(headSha) : (detail?: string) => statusLine.running(headSha, detail);
    await show(running());
    onJobCancelled = () => show(statusLine.interrupted(headSha));
    registerJobCancelHandler(async () => {
      if (onJobCancelled) {
        await onJobCancelled();
      }
    });

    if (!baseUrl) {
      throw new Error("Input required and not supplied: llm-base-url");
    }
    if (!model) {
      throw new Error("Input required and not supplied: model");
    }

    const gitUtils = new GitUtils(octokit as any);
    const baseRef = target.baseSha;
    const headRef = headSha;
    const repoConfig = await loadRepoConfig(gitUtils, owner, repo, configFile, baseRef);
    const maxDiffSize = resolveMaxDiffSize(maxDiffSizeInput, repoConfig);
    const maxComments = resolveMaxComments(maxCommentsInput, repoConfig);
    const jsonResponseMode = resolveJsonResponseMode(jsonResponseModeInput, repoConfig);

    const diff = await gitUtils.getPullRequestDiff(baseRef, headRef);

    if (!diff || diff.trim().length === 0) {
      core.warning("No diff found for this PR.");
      await skip("No diff found for this pull request.");
      onJobCancelled = undefined;
      return;
    }

    const diffFiles = splitDiffIntoFiles(diff);
    const { filtered: filteredDiff, removedFiles } = filterDiff(diff, repoConfig.skipPaths || []);
    if (removedFiles.length > 0) {
      core.info(`Skipped ${removedFiles.length} file(s) before review: ${removedFiles.join(", ")}`);
    }

    if (diffFiles.length > 0 && !filteredDiff.trim()) {
      core.info("All changed files were skipped by diff filters; no LLM review needed.");
      await skip(`every changed file was removed by diff filters (${removedFiles.length} file(s)).`);
      onJobCancelled = undefined;
      return;
    }

    const reviewDiff = filteredDiff.trim() ? filteredDiff : diff;
    if (isWhitespaceOnlyDiff(reviewDiff)) {
      core.info("Only whitespace changed; no LLM review needed.");
      await skip("only whitespace changed.");
      onJobCancelled = undefined;
      return;
    }
    const summaryDiff = reviewDiff.length > maxDiffSize
      ? reviewDiff.slice(0, maxDiffSize) + "\n\n[... Diff truncated due to size limit]"
      : reviewDiff;

    core.info(
      `Diff size: ${reviewDiff.length} chars in ${reviewPieces(reviewDiff, maxDiffSize).length} review chunk(s)${removedFiles.length > 0 ? ` (${removedFiles.length} file(s) filtered)` : ""}`
    );
    const reviewInstructions = command === "review"
      ? await loadReviewInstructions(gitUtils, owner, repo, inlineReviewInstructions, reviewInstructionsFile, baseRef)
      : "";

    const createLlm = (seat: string, effort: typeof reasoningEffortInput) => new LLMClient(
      baseUrl,
      apiKey,
      seat,
      maxOutputTokens,
      llmTimeoutMs,
      undefined,
      (detail) => show(running(detail)),
      effort as "low" | "medium" | "high" | undefined,
      providerOptions
    );
    const primary = createPrimarySeat(
      {llm: createLlm(model, reasoningEffortInput), model},
      fallbackModels.map((seat) => ({llm: createLlm(seat, ""), model: seat}))
    );
    const council = councilModel && command === "review"
      ? createCouncilSeat({llm: createLlm(councilModel, ""), model: councilModel},
        councilFallbackModel ? {llm: createLlm(councilFallbackModel, ""), model: councilFallbackModel} : undefined)
      : undefined;
    const useJsonMode = command === "review" && jsonResponseMode;

    if (command === "summary") {
      const reviewText = (await runSummary(primary, summaryDiff)).content;
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: ["## " + ROBIN_SIGNATURE + " · Summary", "", reviewText].join("\n"),
      });
      await show(statusLine.summarized(headSha));
    } else {
      const timings = new ReviewTimings();
      const {findings, evidenceRequests, usedFollowups} = await runReviewCore({
        git: gitUtils, owner, repo, baseRef, headRef, reviewDiff, maxDiffSize, pieceConcurrency: PIECE_CONCURRENCY,
        reviewInstructions, jsonResponseMode: useJsonMode, llm: primary, council, timings,
        loadPriorFindings: () => loadPriorRobinFindings(octokit!, owner, repo, prNumber!),
      });
      const metrics = primary.getMetrics();
      const timingReceipt = timings.receipt(seatCalls(primary, model, council));
      const fallbackReceipt = primaryFallbackReceipt(primary);
      core.info(timingReceipt);
      findings.summary += [
        "",
        `Robin metrics: ${(metrics.durationMs / 1000).toFixed(1)}s · ${metrics.calls} calls · ${metrics.inputTokens} input tokens (${metrics.cachedInputTokens} cached) · ${metrics.outputTokens} output tokens (${metrics.reasoningOutputTokens} reasoning) · ${evidenceRequests} evidence requests · ${usedFollowups} evidence follow-ups`,
        ...(fallbackReceipt ? [fallbackReceipt] : []),
        ...(council ? [councilReceipt(primary.model, council)] : []),
        timingReceipt,
      ].join("\n");

      core.info(`Found ${findings.high.length} high, ${findings.medium.length} medium, ${findings.low.length} low, ${findings.suggestions.length} suggestions`);

      const reviewer = new GitHubReviewer(octokit as any, maxComments);
      const posted = await reviewer.postReview(owner, repo, prNumber, findings, headSha);
      setPostedOutputs("reviewed", headSha, posted);
      await show(statusLine.reviewed(headSha, posted.counts, posted.url));
    }

    onJobCancelled = undefined;
    core.info("Done.");

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onJobCancelled = undefined;
    if (showStatus && target) await showStatus(statusLine.failed(target.headSha, message));
    await handleReviewFailure({
      octokit,
      target,
      message,
      command: statusCommand,
    });
  }
}

async function addEyesReaction(
  octokit: any,
  owner: string,
  repo: string,
  commentId: number | undefined
): Promise<void> {
  if (!commentId) return;

  try {
    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content: "eyes",
    });
  } catch (error) {
    core.warning(`Could not add eyes reaction to trigger comment: ${error}`);
  }
}

function registerJobCancelHandler(onCancel: () => Promise<void>): void {
  let handled = false;
  const run = () => {
    if (handled) return;
    handled = true;
    void onCancel().finally(() => process.exit(143));
  };
  process.once("SIGTERM", run);
  process.once("SIGINT", run);
}

async function isAuthorizedCommenter(
  octokit: any,
  owner: string,
  repo: string,
  username: string | undefined,
  minCommandPermission: string
): Promise<boolean> {
  if (!username) return false;

  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });

    return hasRequiredPermission(data.permission, minCommandPermission);
  } catch (error) {
    core.warning(`Could not verify permissions for ${username}: ${error}`);
    return false;
  }
}

async function postHelpComment(octokit: any, payload: any): Promise<void> {
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const issueNumber = payload.issue?.number;

  if (!issueNumber) return;

  const helpBody = getHelpMessage();
  
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: helpBody,
  });

  core.info("Posted help comment.");
}

async function loadPriorRobinFindings(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<string> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner, repo, pull_number: pullNumber, per_page: 100,
  });
  const ids = new Set(reviews
    .filter(({body}) => (body || "").includes(ROBIN_SIGNATURE))
    .map(({id}) => id));
  if (ids.size === 0) return "";
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner, repo, pull_number: pullNumber, per_page: 100,
  });
  const resolved = await resolvedReviewCommentIds(octokit, owner, repo, pullNumber);
  return formatPriorFindings(comments, ids, resolved);
}

/**
 * Review-comment ids belonging to threads a human has resolved.
 *
 * Prior findings are replayed into the final gate as "keep only if still
 * present", and the gate keeps anything it cannot affirmatively disprove. The
 * REST listReviewComments endpoint carries no resolution state, so a finding
 * the author explicitly rejected with evidence and resolved was replayed every
 * round and re-kept forever — a ratchet that no amount of fixing could clear.
 * Resolution lives only in the GraphQL reviewThreads connection.
 *
 * Failing open (returning an empty set) restores the previous behaviour rather
 * than dropping prior findings wholesale, so a GraphQL outage costs noise, not
 * a missed regression.
 */
async function resolvedReviewCommentIds(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<Set<number>> {
  const resolved = new Set<number>();
  try {
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const response: any = await octokit.graphql(
        `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                nodes { isResolved comments(first: 100) { nodes { databaseId } } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        {owner, repo, number: pullNumber, cursor}
      );
      const threads = response?.repository?.pullRequest?.reviewThreads;
      for (const thread of threads?.nodes ?? []) {
        if (!thread?.isResolved) continue;
        for (const comment of thread.comments?.nodes ?? []) {
          if (typeof comment?.databaseId === "number") resolved.add(comment.databaseId);
        }
      }
      if (!threads?.pageInfo?.hasNextPage) break;
      cursor = threads.pageInfo.endCursor;
    }
  } catch (error) {
    core.warning("Could not read review-thread resolution; replaying all prior findings: " + error);
    return new Set();
  }
  return resolved;
}

async function runSummary(llm: ChatSeat, diff: string) {
  const systemPrompt = getSummaryPrompt();
  const userContent = buildSummaryInput(diff);
  core.info("Getting PR summary...");
  return await llm.chatCompletion(systemPrompt, userContent, false);
}

function buildSummaryInput(diff: string): string {
  return [
    "Summarize the following pull request diff. Provide:",
    "1. High-level overview of what changed",
    "2. Key files affected",
    "3. Any notable patterns or patterns that could be improved",
    "Be concise but informative.",
    "---",
    "CODE DIFF:",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

run();
