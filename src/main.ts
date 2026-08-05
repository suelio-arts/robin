import * as core from "@actions/core";
import * as github from "@actions/github";
import { LLMClient } from "./llm-client";
import { GitUtils } from "./git-utils";
import { ReviewFinding, ReviewParser, StructuredReview } from "./review-parser";
import { shouldRetryStructuredReview } from "./review-retry";
import { GitHubReviewer, ROBIN_SIGNATURE } from "./github-reviewer";
import { DEFAULT_LLM_TIMEOUT_MS, parseLLMTimeout } from "./config";
import { chunkDiffByFile, filterDiff, splitDiffIntoFiles } from "./diff-filter";
import { annotateDiffWithLineNumbers } from "./diff-annotate";
import {
  DEFAULT_CONFIG_FILE,
  RepoConfig,
  parseRepoConfigYaml,
  resolveJsonResponseMode,
  resolveMaxComments,
  resolveMaxDiffSize,
  resolveRequestChanges,
} from "./repo-config";
import { CONTRACT_SEARCH_DISCOVERY_PASS, CONTRACT_SEARCH_PLANNER_INSTRUCTIONS, PRECISION_INSTRUCTIONS, PRECISION_SEARCH_PLANNER_INSTRUCTIONS, VERIFICATION_INSTRUCTIONS, getInitialDiscoveryPasses, getReviewPrompt, getSummaryPrompt, getHelpMessage, isContractChunk } from "./prompts/review-prompts";
import { ReviewerCommand, hasRequiredPermission, parseSlashCommand } from "./commands";
import { isPullRequestReviewEvent } from "./events";
import { buildFileContext } from "./review-context";
import { buildPrecisionCandidates, selectApprovedCandidates } from "./precision-gate";
import { buildContractSearchEvidence, changedHeadPaths, completeContractSearchPlan, wrapContractSearchEvidence } from "./contract-discovery";

async function run(): Promise<void> {
  let octokit: ReturnType<typeof github.getOctokit> | undefined;
  let statusOwner = "";
  let statusRepo = "";
  let statusCommentId: number | undefined;
  let statusCommand: "review" | "summary" = "review";
  let statusModel = "not configured";
  let onJobCancelled: (() => Promise<void>) | undefined;

  try {
    const eventName = github.context.eventName;
    const payload = github.context.payload;
    const token = core.getInput("github-token", { required: true });
    octokit = github.getOctokit(token);
    const minCommandPermission = core.getInput("min-command-permission") || "write";
    const reviewOnSynchronize = core.getBooleanInput("review-on-synchronize");

    core.info(`Event: ${eventName}`);

    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;
    statusOwner = owner;
    statusRepo = repo;

    let shouldRun = false;
    let prNumber: number | undefined;
    let command: ReviewerCommand = "review"; // default command for PR events

    if (isPullRequestReviewEvent(eventName)) {
      if (payload.action === "synchronize" && !reviewOnSynchronize) {
        core.info("Skipping pull_request synchronize event. Pushes to an existing PR are reviewed manually with /review unless review-on-synchronize is true.");
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

      await addEyesReaction(octokit, owner, repo, payload.comment?.id);

      command = parsedCommand;
      prNumber = payload.issue.number;

      if (command === "help") {
        await postHelpComment(octokit, payload);
        return;
      }

      shouldRun = true;
    }

    if (!shouldRun || !prNumber) {
      core.info("No matching trigger found. Skipping.");
      return;
    }

    const apiKey = core.getInput("llm-api-key") || "ollama";
    const baseUrl = core.getInput("llm-base-url") || "";
    const model = core.getInput("model") || "";
    const reasoningEffortInput = core.getInput("reasoning-effort") || "";
    if (reasoningEffortInput && !["low", "medium", "high"].includes(reasoningEffortInput)) {
      throw new Error(`Invalid reasoning-effort: ${reasoningEffortInput}`);
    }
    const failOnHigh = core.getInput("fail-on-high") === "true";
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
    const requestChangesInput = core.getInput("request-changes") || "";

    core.info(`Model: ${model || "(not configured)"}`);

    core.info(`Running /${command} on PR #${prNumber} in ${owner}/${repo}`);
    statusCommand = command === "summary" ? "summary" : "review";
    statusModel = model || "not configured";
    statusCommentId = await postStatusComment(octokit, owner, repo, prNumber, command, statusModel);
    onJobCancelled = async () => {
      if (octokit && statusCommentId) {
        // The SIGTERM grace period is short — never let the superseded check
        // delay the status update past it. On timeout the check is abandoned
        // fire-and-forget; its own try/catch swallows any late rejection.
        const superseded = await Promise.race([
          isSupersededByNewerRun(octokit, statusOwner, statusRepo),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000).unref()),
        ]);
        await updateStatusComment(
          octokit,
          statusOwner,
          statusRepo,
          statusCommentId,
          superseded
            ? buildSupersededStatusBody(statusCommand)
            : buildCancelledStatusBody(statusCommand)
        );
      }
    };
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
    const { data: pullRequest } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const baseRef = pullRequest.base.sha;
    const headRef = pullRequest.head.sha;
    const repoConfig = await loadRepoConfig(
      octokit,
      gitUtils,
      owner,
      repo,
      prNumber,
      configFile,
      baseRef
    );
    const maxDiffSize = resolveMaxDiffSize(maxDiffSizeInput, repoConfig);
    const maxComments = resolveMaxComments(maxCommentsInput, repoConfig);
    const jsonResponseMode = resolveJsonResponseMode(jsonResponseModeInput, repoConfig);
    const requestChanges = resolveRequestChanges(requestChangesInput, repoConfig);

    const diff = await gitUtils.getPullRequestDiff(owner, repo, prNumber);
    
    if (!diff || diff.trim().length === 0) {
      core.warning("No diff found for this PR.");
      await updateStatusComment(
        octokit,
        owner,
        repo,
        statusCommentId,
        buildFailedStatusBody("No diff found for this pull request.", statusCommand)
      );
      return;
    }

    const diffFiles = splitDiffIntoFiles(diff);
    const { filtered: filteredDiff, removedFiles } = filterDiff(diff, repoConfig.skipPaths || []);
    if (removedFiles.length > 0) {
      core.info(`Skipped ${removedFiles.length} file(s) before review: ${removedFiles.join(", ")}`);
    }

    if (diffFiles.length > 0 && !filteredDiff.trim()) {
      core.info("All changed files were skipped by diff filters; no LLM review needed.");
      await updateStatusComment(
        octokit,
        owner,
        repo,
        statusCommentId,
        buildSkippedFilterStatusBody(removedFiles)
      );
      return;
    }

    const reviewDiff = filteredDiff.trim() ? filteredDiff : diff;
    if (!reviewDiff.trim()) {
      core.warning("No reviewable diff remained after filtering skipped paths.");
      await updateStatusComment(
        octokit,
        owner,
        repo,
        statusCommentId,
        buildFailedStatusBody("No reviewable diff remained after filtering skipped paths.", statusCommand)
      );
      return;
    }

    const reviewChunks = splitDiffIntoFiles(reviewDiff).flatMap(({ content }) =>
      chunkDiffByFile(content, maxDiffSize)
    );
    const summaryDiff = reviewDiff.length > maxDiffSize
      ? reviewDiff.slice(0, maxDiffSize) + "\n\n[... Diff truncated due to size limit]"
      : reviewDiff;

    core.info(
      `Diff size: ${reviewDiff.length} chars in ${reviewChunks.length} review chunk(s)${removedFiles.length > 0 ? ` (${removedFiles.length} file(s) filtered)` : ""}`
    );
    const reviewInstructions = command === "review"
      ? await loadReviewInstructions(
        octokit,
        gitUtils,
        owner,
        repo,
        prNumber,
        inlineReviewInstructions,
        reviewInstructionsFile,
        baseRef
      )
      : "";

    const llm = new LLMClient(
      baseUrl,
      apiKey,
      model,
      maxOutputTokens,
      llmTimeoutMs,
      undefined,
      async (detail) => {
        await updateStatusComment(
          octokit!,
          owner,
          repo,
          statusCommentId,
          buildProgressStatusBody(detail, statusCommand, statusModel)
        );
      },
      reasoningEffortInput as "low" | "medium" | "high" | undefined
    );
    const useJsonMode = command === "review" && jsonResponseMode;
    
    if (command === "summary") {
      const reviewText = (await runSummary(llm, summaryDiff)).content;
      // Post summary as a regular comment
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: ["## " + ROBIN_SIGNATURE + " · Summary", "", reviewText].join("\n"),
      });
      await updateStatusComment(octokit, owner, repo, statusCommentId, buildCompletedStatusBody("summary"));
    } else {
      // Full review parsed and posted as a review
      const findings: StructuredReview = {
        summary: "",
        high: [],
        medium: [],
        low: [],
        suggestions: [],
        rawResponse: "",
      };
      for (let start = 0; start < reviewChunks.length; start += 3) {
        const batch = reviewChunks.slice(start, start + 3);
        const reviews = await Promise.all(batch.map(async (chunk, offset) => {
          core.info(`Reviewing chunk ${start + offset + 1}/${reviewChunks.length}...`);
          const context = await buildFileContext(gitUtils, owner, repo, chunk, baseRef, headRef);
          return runReviewPipeline(
            llm,
            async (queries, changedPaths, counterevidence = false) => buildContractSearchEvidence(
              gitUtils,
              owner,
              repo,
              headRef,
              queries,
              changedPaths,
              {counterevidence, reviewedPaths: diffFiles.map(({path}) => path)}
            ),
            chunk,
            context,
            reviewInstructions,
            useJsonMode
          );
        }));
        for (const review of reviews) {
          findings.summary += `${review.summary}\n`;
          findings.high.push(...review.high);
          findings.medium.push(...review.medium);
          findings.low.push(...review.low);
          findings.suggestions.push(...review.suggestions);
        }
      }

      deduplicateFindings(findings);

      core.info(`Found ${findings.high.length} high, ${findings.medium.length} medium, ${findings.low.length} low, ${findings.suggestions.length} suggestions`);

      const reviewer = new GitHubReviewer(octokit as any, maxComments);
      await reviewer.postReview(owner, repo, prNumber, findings, requestChanges);
      await updateStatusComment(octokit, owner, repo, statusCommentId, buildCompletedStatusBody("review", findings));

      if (findings.high.length > 0 && failOnHigh) {
        core.setFailed(`Found ${findings.high.length} high severity issue(s). Failing check.`);
      }
    }

    onJobCancelled = undefined;
    core.info("Done.");

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (octokit && statusOwner && statusRepo && statusCommentId) {
      await updateStatusComment(octokit, statusOwner, statusRepo, statusCommentId, buildFailedStatusBody(message, statusCommand));
    }
    core.setFailed(message);
  } finally {
    onJobCancelled = undefined;
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

async function postStatusComment(
  octokit: any,
  owner: string,
  repo: string,
  issueNumber: number,
  command: ReviewerCommand,
  model: string
): Promise<number | undefined> {
  try {
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: [
        "## " + ROBIN_SIGNATURE,
        "",
        ":eyes: On it — taking a look at this pull request.",
        "",
        `Mode: ${command === "summary" ? "summary" : "code review"}`,
        `Model: ${model}`,
      ].join("\n"),
    });
    return data.id;
  } catch (error) {
    core.warning(`Could not post status comment: ${error}`);
    return undefined;
  }
}

async function updateStatusComment(
  octokit: any,
  owner: string,
  repo: string,
  commentId: number | undefined,
  body: string
): Promise<void> {
  if (!commentId) return;

  try {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
  } catch (error) {
    core.warning(`Could not update status comment: ${error}`);
  }
}

function buildCompletedStatusBody(command: "review" | "summary", findings?: StructuredReview): string {
  if (command === "summary") {
    return [
      "## " + ROBIN_SIGNATURE,
      "",
      ":white_check_mark: Summary's ready above.",
      "",
      "Want the full review? Comment `/robin`.",
    ].join("\n");
  }

  const totalFindings = findings
    ? findings.high.length + findings.medium.length + findings.low.length + findings.suggestions.length
    : 0;
  const result = totalFindings === 0
    ? "Nothing worth flagging — looks clean to me."
    : `I flagged ${totalFindings} thing${totalFindings === 1 ? "" : "s"} worth a look.`;

  return [
    "## " + ROBIN_SIGNATURE,
    "",
    `:white_check_mark: Review done. ${result}`,
    "",
    "Push fixes whenever you like, then comment `/robin` for another pass.",
  ].join("\n");
}

function buildSkippedFilterStatusBody(removedFiles: string[]): string {
  const preview = removedFiles.slice(0, 8).join(", ");
  const suffix = removedFiles.length > 8 ? `, and ${removedFiles.length - 8} more` : "";

  return [
    "## " + ROBIN_SIGNATURE,
    "",
    ":white_check_mark: Nothing to review here — only ignored paths changed.",
    "",
    `Skipped: ${preview}${suffix}`,
    "",
    "Add `skip-paths` in `.github/robin.yml` if that's not what you expected.",
  ].join("\n");
}

function buildFailedStatusBody(errorMessage: string, command: "review" | "summary"): string {
  return [
    "## " + ROBIN_SIGNATURE,
    "",
    `:warning: I couldn't finish the ${command === "summary" ? "summary" : "review"} this time.`,
    "",
    `Reason: ${errorMessage}`,
    "",
    "Free model routes drop sometimes — comment `/robin` to try again. (No secrets are included in this message.)",
  ].join("\n");
}

function buildProgressStatusBody(
  detail: string,
  command: "review" | "summary",
  model: string
): string {
  return [
    "## " + ROBIN_SIGNATURE,
    "",
    ":hourglass_flowing_sand: Still working on this pull request.",
    "",
    detail,
    "",
    `Mode: ${command === "summary" ? "summary" : "code review"}`,
    `Model: ${model}`,
  ].join("\n");
}

/**
 * True when a newer run of this same workflow exists — i.e. this run was
 * cancelled by concurrency `cancel-in-progress`, not by a human or a timeout.
 * Note: runs are matched per workflow, not per PR — a newer run on a different
 * PR can also count. Acceptable: this only softens the cancel-notice wording.
 * Best-effort: any API failure returns false.
 */
async function isSupersededByNewerRun(octokit: any, owner: string, repo: string): Promise<boolean> {
  try {
    const runId = Number(process.env.GITHUB_RUN_ID);
    const runNumber = Number(process.env.GITHUB_RUN_NUMBER);
    if (!runId || !runNumber) return false;

    const { data: currentRun } = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: runId,
    });

    const { data } = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: currentRun.workflow_id,
      per_page: 10,
    });

    const superseded = data.workflow_runs.some(
      (run: { id: number; run_number: number }) => run.id !== runId && run.run_number > runNumber
    );
    core.info(
      superseded
        ? `Superseded by a newer workflow run (this is #${runNumber})`
        : `No newer workflow run found (this is #${runNumber})`
    );
    return superseded;
  } catch (error) {
    core.warning(`Could not check for a superseding run: ${error}`);
  }
  return false;
}

function buildSupersededStatusBody(command: "review" | "summary"): string {
  return [
    "## " + ROBIN_SIGNATURE,
    "",
    `:arrows_counterclockwise: This ${command === "summary" ? "summary" : "review"} run was replaced by a newer Robin run.`,
    "",
    "No action needed — the newer run posts its own result when it finishes.",
  ].join("\n");
}

function buildCancelledStatusBody(command: "review" | "summary"): string {
  return [
    "## " + ROBIN_SIGNATURE,
    "",
    `:warning: The ${command === "summary" ? "summary" : "review"} was interrupted before it finished.`,
    "",
    "This usually means the GitHub Actions job was cancelled or hit its time limit while waiting on the model.",
    "",
    "Comment `/robin` to run again.",
  ].join("\n");
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

async function loadRepoConfig(
  octokit: any,
  gitUtils: GitUtils,
  owner: string,
  repo: string,
  prNumber: number,
  configFile: string,
  baseRef?: string
): Promise<RepoConfig> {
  const filePath = configFile.trim();
  if (!filePath) return {};

  try {
    let ref = baseRef;
    if (!ref) {
      const { data: pullRequest } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      ref = pullRequest.base.sha;
    }

    if (!ref) return {};

    const fileContent = await gitUtils.getFileContent(owner, repo, filePath, ref);
    if (!fileContent.trim()) return {};

    core.info(`Loaded repo config from ${filePath}`);
    return parseRepoConfigYaml(fileContent);
  } catch (error) {
    core.info(`No repo config at ${filePath} (${error})`);
    return {};
  }
}

async function loadReviewInstructions(
  octokit: any,
  gitUtils: GitUtils,
  owner: string,
  repo: string,
  prNumber: number,
  inlineInstructions: string,
  instructionsFile: string,
  baseRef?: string
): Promise<string> {
  const instructions = inlineInstructions.trim() ? [inlineInstructions.trim()] : [];
  const filePath = instructionsFile.trim();

  if (!filePath) {
    return instructions.join("\n\n");
  }

  try {
    let ref: string;
    if (baseRef) {
      ref = baseRef;
    } else {
      const { data: pullRequest } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      ref = pullRequest.base.sha;
    }

    const fileInstructions = await gitUtils.getFileContent(owner, repo, filePath, ref);
    if (fileInstructions.trim()) {
      core.info(`Loaded reviewer instructions from ${filePath}`);
      instructions.push(`Instructions from ${filePath}:\n${fileInstructions.trim()}`);
    }
  } catch (error) {
    core.warning(`Could not load review instructions from ${filePath}: ${error}`);
  }

  return instructions.join("\n\n");
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

async function runReview(
  llm: LLMClient,
  diff: string,
  reviewInstructions: string,
  jsonResponseMode: boolean,
  context = "",
  focusInstructions = ""
) {
  const systemPrompt = getReviewPrompt(reviewInstructions);
  const userContent = [
    buildReviewInput(diff, context),
    focusInstructions && `REVIEW FOCUS:\n${focusInstructions}`,
  ].filter(Boolean).join("\n\n");
  core.info("Getting full code review...");
  return await llm.chatCompletion(systemPrompt, userContent, jsonResponseMode);
}

async function runReviewPipeline(
  llm: LLMClient,
  searchContracts: (queries: string[], changedPaths: string[], counterevidence?: boolean) => Promise<string>,
  diff: string,
  context: string,
  reviewInstructions: string,
  jsonResponseMode: boolean
): Promise<StructuredReview> {
  const discover = async (instructions: string) => {
    const response = await runReview(
      llm,
      diff,
      reviewInstructions,
      jsonResponseMode,
      context,
      instructions
    );
    const parsed = ReviewParser.parseDetailed(response.content);
    if (!shouldRetryStructuredReview(parsed.findings, parsed.usedJson)) return parsed.findings;
    return ReviewParser.parse((await runReview(
      llm,
      diff,
      reviewInstructions,
      true,
      context,
      `${instructions}\n\nReturn ONLY a single valid JSON object.`
    )).content);
  };
  const [firstPass, ...remainingPasses] = getInitialDiscoveryPasses(diff);
  const discovery = [await discover(firstPass)];
  for (let index = 0; index < remainingPasses.length; index += 2) {
    discovery.push(...await Promise.all(remainingPasses.slice(index, index + 2).map(discover)));
  }
  if (isContractChunk(diff)) {
    const plan = await llm.chatCompletion(
      CONTRACT_SEARCH_PLANNER_INSTRUCTIONS,
      buildReviewInput(diff, context),
      true
    );
    const changedPaths = changedHeadPaths(diff);
    const evidence = await searchContracts(completeContractSearchPlan(plan.content, diff, context), changedPaths);
    discovery.push(await discover([
      CONTRACT_SEARCH_DISCOVERY_PASS,
      "CONTRACT SEARCH EVIDENCE:",
      wrapContractSearchEvidence(evidence),
    ].join("\n\n")));
  }
  const candidates = JSON.stringify(discovery.map(({ rawResponse: _, ...review }) => review));
  const verified = ReviewParser.parse((await runReview(
    llm,
    diff,
    reviewInstructions,
    true,
    context,
    [`CANDIDATE FINDINGS:\n${candidates}`, ...VERIFICATION_INSTRUCTIONS].join("\n\n")
  )).content);
  const precisionCandidates = buildPrecisionCandidates([...discovery, verified]);
  let precisionEvidence = "";
  if (precisionCandidates.length > 0) {
    const plan = await llm.chatCompletion(
      PRECISION_SEARCH_PLANNER_INSTRUCTIONS,
      [`CANDIDATES:\n${JSON.stringify(precisionCandidates)}`, buildReviewInput(diff, context)].join("\n\n"),
      true
    );
    precisionEvidence = await searchContracts(completeContractSearchPlan(plan.content, diff, context), changedHeadPaths(diff), true);
  }
  const precisionPrompt = [
    reviewInstructions,
    ...PRECISION_INSTRUCTIONS,
  ].filter(Boolean).join("\n\n");
  const precisionInput = [
    "CANDIDATES:",
    JSON.stringify(precisionCandidates),
    precisionEvidence && `CANDIDATE COUNTEREVIDENCE:\n${wrapContractSearchEvidence(precisionEvidence)}`,
    buildReviewInput(diff, context),
  ].filter(Boolean).join("\n\n");
  let verdict = await llm.chatCompletion(precisionPrompt, precisionInput, true);
  let precise: StructuredReview;
  try {
    precise = selectApprovedCandidates(precisionCandidates, verdict.content, verified.summary);
  } catch {
    try {
      verdict = await llm.chatCompletion(`${precisionPrompt}\n\nYour prior response was invalid. Return only the required JSON object.`, precisionInput, true);
      precise = selectApprovedCandidates(precisionCandidates, verdict.content, verified.summary);
    } catch (error) {
      throw new Error(`Precision gate failed twice; refusing an unverified review: ${error}`);
    }
  }

  deduplicateFindings(precise);
  return precise;
}

function deduplicateFindings(review: StructuredReview): void {
  const seen = new Set<string>();
  for (const severity of ["high", "medium", "low", "suggestions"] as const) {
    review[severity] = review[severity].filter((finding: ReviewFinding) => {
      const key = `${finding.file || ""}:${finding.line || 0}:${finding.description.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").slice(0, 12).join(" ")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

async function runSummary(llm: LLMClient, diff: string) {
  const systemPrompt = getSummaryPrompt();
  const userContent = buildSummaryInput(diff);
  core.info("Getting PR summary...");
  return await llm.chatCompletion(systemPrompt, userContent, false);
}

function buildReviewInput(diff: string, context = ""): string {
  const annotated = annotateDiffWithLineNumbers(diff);
  const input = [
    "Review the following code diff and return only the strict JSON object described in the system prompt.",
    "Each line is prefixed with its line number in the NEW file (blank for removed lines and headers).",
    "For any line-specific finding, copy that exact number into the `line` field. Do not guess or recount.",
    "---",
    "CODE DIFF:",
    "```diff",
    annotated,
    "```",
  ];
  if (context) {
    input.push(
      "UNCHANGED BASE/HEAD FILE CONTEXT (evidence only; anchor comments to changed lines):",
      "```",
      context,
      "```"
    );
  }
  return input.join("\n");
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
