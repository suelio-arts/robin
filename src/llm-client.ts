import { OpenAI } from "openai";
import {
  DEFAULT_LLM_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS,
  DEFAULT_LLM_TIMEOUT_MS,
} from "./config";
import {
  computeRetryDelayMs,
  delayMs,
  getLlmCompletionAttemptCount,
  isOpenRouterRouterModel,
  isRetriableLlmError,
  openRouterStallError,
  resolveLlmTimeoutMs,
  shouldUseJsonResponseMode,
} from "./llm-retry";
import * as core from "@actions/core";
import { execFile } from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
const ROLLY_AGENT_URL = "rolly-agent";
const ROLLY_BIN = "/Users/rolly/.local/bin/rolly";
const ROBIN_LOCAL_AGENTS = new Set([
  "luna-5-6-high-api",
  "luna-5-6-high-subscription",
  "luna-5-6-low-api",
  "luna-5-6-low-subscription",
]);
export const LOCAL_AGENT_COMPLETION_CONTRACT = [
  "Act as a stateless model completion, not an autonomous coding agent.",
  "Do not call tools, run commands, read files, browse, or inspect any repository.",
  "Use only the evidence supplied in this prompt and return the requested response immediately.",
].join(" ");

function runFile(file: string, args: string[], options: { timeout: number; maxBuffer: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}

export interface ChatCompletionResult {
  content: string;
  model?: string;
  callId?: string;
  provenance?: {
    provider: string;
    auth: string;
    model: string;
    effort: string;
  };
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    durationMs?: number;
  };
}

export type LlmProgressHandler = (detail: string) => void | Promise<void>;
export type ReasoningEffort = "low" | "medium" | "high";
export type LocalAgentCaller = "github" | "codex";

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private maxOutputTokens?: number;
  private maxAttempts: number;
  private routerModel: boolean;
  private onProgress?: LlmProgressHandler;
  private reasoningEffort?: ReasoningEffort;
  private localAgent: boolean;
  private timeoutMs: number;
  private localAgentCaller: LocalAgentCaller;

  constructor(
    baseUrl: string,
    apiKey: string,
    model: string,
    maxOutputTokens?: number,
    timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
    maxAttempts = DEFAULT_LLM_COMPLETION_ATTEMPTS,
    onProgress?: LlmProgressHandler,
    reasoningEffort?: ReasoningEffort,
    localAgentCaller: LocalAgentCaller = "github"
  ) {
    this.model = model;
    this.localAgent = baseUrl === ROLLY_AGENT_URL;
    if (this.localAgent && !ROBIN_LOCAL_AGENTS.has(model)) {
      throw new Error(`Unsupported Robin local agent: ${model}`);
    }
    this.routerModel = isOpenRouterRouterModel(model);
    this.onProgress = onProgress;
    this.reasoningEffort = reasoningEffort;
    this.localAgentCaller = localAgentCaller;
    this.maxOutputTokens =
      maxOutputTokens && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? maxOutputTokens
        : undefined;
    this.maxAttempts = getLlmCompletionAttemptCount(maxAttempts, model);
    const effectiveTimeoutMs = resolveLlmTimeoutMs(model, timeoutMs);
    this.timeoutMs = effectiveTimeoutMs;

    core.info(
      `Initializing LLM client: baseUrl=${baseUrl}, model=${model}, timeout=${effectiveTimeoutMs} ms, maxAttempts=${this.maxAttempts}`
    );

    // ponytail: chatCompletion owns retries; SDK maxRetries × 10-min timeout burned whole job budgets
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey || "ollama",
      maxRetries: 0,
      timeout: effectiveTimeoutMs,
    });

    if (this.routerModel) {
      core.info(
        `OpenRouter router model — ${DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS / 1000}s first-chunk stall detect, ${effectiveTimeoutMs / 1000}s stream cap, provider fallbacks.`
      );
    }
  }

  private retryContext() {
    return { model: this.model };
  }

  private async progress(detail: string): Promise<void> {
    if (!this.onProgress) return;
    try {
      await this.onProgress(detail);
    } catch (error) {
      core.warning(`LLM progress update failed (non-fatal): ${error}`);
    }
  }

  async chatCompletion(
    systemPrompt: string,
    userContent: string,
    jsonResponseMode = false
  ): Promise<ChatCompletionResult> {
    if (this.localAgent) return this.localAgentCompletion(systemPrompt, userContent);
    let lastFinishReason = "unknown";
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const useJson = shouldUseJsonResponseMode(attempt, jsonResponseMode);

      try {
        core.info(`LLM attempt ${attempt}/${this.maxAttempts}: waiting for provider...`);
        await this.progress(
          `Waiting for provider (attempt ${attempt}/${this.maxAttempts})…`
        );
        const request = this.buildRequest(systemPrompt, userContent, useJson);
        const result = this.routerModel
          ? await this.streamChatCompletion(request)
          : await this.blockingChatCompletion(request);
        const { content, model: resolvedModel } = result;

        if (content) {
          if (!this.routerModel) {
            this.logResolvedModel(resolvedModel || this.model);
          }
          return result;
        }

        lastFinishReason = "empty";
        core.warning(
          `LLM attempt ${attempt}/${this.maxAttempts}: empty content${useJson ? " (json mode)" : ""}`
        );
      } catch (error) {
        lastError = error;
        core.warning(`LLM attempt ${attempt}/${this.maxAttempts} failed: ${error}`);

        if (!isRetriableLlmError(error, this.retryContext()) || attempt === this.maxAttempts) {
          core.error(`LLM API error: ${error}`);
          throw new Error(`Failed to get response from LLM: ${error}`);
        }
      }

      if (attempt < this.maxAttempts) {
        const waitMs = computeRetryDelayMs(attempt, this.retryContext());
        const reason = lastError instanceof Error ? lastError.message : "empty response";
        core.info(`Retrying LLM request in ${waitMs} ms (attempt ${attempt + 1}/${this.maxAttempts})...`);
        await this.progress(
          `Attempt ${attempt} did not succeed (${reason}). Retrying in ${Math.round(waitMs / 1000)}s…`
        );
        await delayMs(waitMs);
      }
    }

    if (lastError && isRetriableLlmError(lastError, this.retryContext())) {
      core.error(`LLM API error after ${this.maxAttempts} attempts: ${lastError}`);
      throw new Error(
        `Failed to get response from LLM after ${this.maxAttempts} attempts: ${lastError}`
      );
    }

    throw new Error(
      `Empty response from LLM after ${this.maxAttempts} attempts (finish_reason=${lastFinishReason})`
    );
  }

  private async localAgentCompletion(
    systemPrompt: string,
    userContent: string
  ): Promise<ChatCompletionResult> {
    let root: string | undefined;
    try {
      root = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "robin-agent-"));
      const prompt = join(root, "prompt.md");
      const workdir = join(root, "context");
      await mkdir(workdir, { mode: 0o700 });
      await writeFile(prompt, [
        "# Completion contract",
        LOCAL_AGENT_COMPLETION_CONTRACT,
        "# System",
        systemPrompt,
        "# User",
        userContent,
      ].join("\n\n"), { mode: 0o600 });
      const timeoutSeconds = Math.max(1, Math.floor(this.timeoutMs / 1000));
      const stdout = await runFile(ROLLY_BIN, [
        "agent", "run",
        "--agent", this.model,
        "--mode", "read",
        "--caller", this.localAgentCaller,
        "--user", "deniz",
        "--workdir", workdir,
        "--prompt", prompt,
        "--timeout", String(timeoutSeconds),
      ], { timeout: this.timeoutMs, maxBuffer: 10 * 1024 * 1024 });
      const resultPath = JSON.parse(stdout).result;
      if (typeof resultPath !== "string" || !resultPath) throw new Error("Rolly agent returned no result path");
      const content = await readFile(resultPath, "utf8");
      if (!content.trim()) throw new Error("Rolly agent returned an empty result");
      return { content, model: this.model, ...await this.readLocalAgentMetadata(resultPath) };
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
  }

  private async readLocalAgentMetadata(resultPath: string): Promise<Pick<ChatCompletionResult, "callId" | "provenance" | "usage">> {
    try {
      const meta = JSON.parse(await readFile(`${resultPath}.meta.json`, "utf8")) as {
        duration_seconds?: number;
        events?: string;
        session?: string;
        provider?: string;
        auth?: string;
        model?: string;
        effort?: string;
      };
      if (!meta.events) return {};
      const usage = {inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0};
      let usageEvents = 0;
      for (const line of (await readFile(meta.events, "utf8")).split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as {
          type?: string;
          usage?: {
            input_tokens?: number;
            cached_input_tokens?: number;
            output_tokens?: number;
            reasoning_output_tokens?: number;
          };
        };
        if (event.type !== "turn.completed" || !event.usage) continue;
        const counters = [
          event.usage.input_tokens,
          event.usage.cached_input_tokens,
          event.usage.output_tokens,
          event.usage.reasoning_output_tokens,
        ].map((value) => value ?? 0);
        if (!counters.every((value) => Number.isInteger(value) && value >= 0)) {
          throw new Error("Invalid local agent token usage");
        }
        usageEvents += 1;
        usage.inputTokens += counters[0];
        usage.cachedInputTokens += counters[1];
        usage.outputTokens += counters[2];
        usage.reasoningOutputTokens += counters[3];
      }
      if (usageEvents === 0) throw new Error("Local agent emitted no token usage");
      return {
        callId: meta.session,
        provenance: [meta.provider, meta.auth, meta.model, meta.effort].every((value) => typeof value === "string" && value)
          ? {provider: meta.provider!, auth: meta.auth!, model: meta.model!, effort: meta.effort!}
          : undefined,
        usage: {...usage, durationMs: typeof meta.duration_seconds === "number" ? meta.duration_seconds * 1000 : undefined},
      };
    } catch (error) {
      core.warning(`Could not read local agent usage metadata: ${error}`);
      return {};
    }
  }

  private async blockingChatCompletion(
    request: OpenAI.Chat.Completions.ChatCompletionCreateParams
  ): Promise<ChatCompletionResult> {
    const response = await this.client.chat.completions.create({
      ...request,
      stream: false,
    });
    const usage = response.usage as undefined | {
      prompt_tokens: number;
      completion_tokens: number;
      prompt_tokens_details?: {cached_tokens?: number};
      completion_tokens_details?: {reasoning_tokens?: number};
    };
    return {
      content: this.extractMessageContent(response),
      model: response.model || this.model,
      callId: response.id,
      usage: usage ? {
        inputTokens: usage.prompt_tokens || 0,
        cachedInputTokens: usage.prompt_tokens_details?.cached_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        reasoningOutputTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
      } : undefined,
    };
  }

  /** Stream so the first SSE chunk (model id) proves OpenRouter routed; abort if none arrives. */
  private async streamChatCompletion(
    request: OpenAI.Chat.Completions.ChatCompletionCreateParams
  ): Promise<ChatCompletionResult> {
    const firstChunkMs = DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS;
    const controller = new AbortController();
    let gotFirstChunk = false;
    // ponytail: timer starts before create() so a hung TCP/connect also fails at firstChunkMs
    let stallTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      controller.abort();
    }, firstChunkMs);

    const clearStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };

    try {
      const stream = await this.client.chat.completions.create(
        { ...request, stream: true },
        { signal: controller.signal }
      );

      const parts: string[] = [];
      let resolvedModel = this.model;
      let callId: string | undefined;

      for await (const chunk of stream) {
        if (!gotFirstChunk) {
          gotFirstChunk = true;
          clearStallTimer();
          resolvedModel = chunk.model || resolvedModel;
          if (chunk.model && chunk.model !== this.model) {
            core.info(`LLM resolved model: ${chunk.model} (requested: ${this.model})`);
            await this.progress(`Routed to \`${chunk.model}\` — generating review…`);
          } else {
            core.info("OpenRouter stream started — provider accepted the request.");
            await this.progress("Provider accepted the request — generating review…");
          }
        }

        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          parts.push(delta);
        }
        if (chunk.model) {
          resolvedModel = chunk.model;
        }
        if (chunk.id) callId = chunk.id;
      }

      return { content: parts.join(""), model: resolvedModel, callId };
    } catch (error) {
      clearStallTimer();
      if (!gotFirstChunk) {
        throw openRouterStallError(firstChunkMs);
      }
      throw error;
    }
  }

  private buildRequest(
    systemPrompt: string,
    userContent: string,
    jsonResponseMode: boolean
  ): OpenAI.Chat.Completions.ChatCompletionCreateParams {
    const request: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    };

    if (this.maxOutputTokens) {
      request.max_tokens = this.maxOutputTokens;
    }

    if (this.reasoningEffort) {
      request.reasoning_effort = this.reasoningEffort;
    }

    if (jsonResponseMode) {
      request.response_format = { type: "json_object" };
    }

    if (this.routerModel) {
      // OpenRouter extension: try other providers when the first free route 404s.
      (request as OpenAI.Chat.Completions.ChatCompletionCreateParams & {
        provider?: { allow_fallbacks: boolean };
      }).provider = { allow_fallbacks: true };
    }

    return request;
  }

  private logResolvedModel(resolvedModel: string): void {
    if (resolvedModel && resolvedModel !== this.model) {
      core.info(`LLM resolved model: ${resolvedModel} (requested: ${this.model})`);
    } else {
      core.info(`LLM response model: ${resolvedModel}`);
    }
  }

  private extractMessageContent(response: OpenAI.Chat.Completions.ChatCompletion): string {
    const choice = response.choices?.[0];
    if (!choice) {
      core.warning("LLM response has no choices array.");
      return "";
    }

    const content = choice.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }

    core.warning(
      `LLM choice has no text content (finish_reason=${choice.finish_reason || "unknown"}).`
    );
    return "";
  }
}
