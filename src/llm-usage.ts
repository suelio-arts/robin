import { randomUUID } from "crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "fs";
import { dirname, resolve } from "path";

/** Optional generic OpenAI-compatible attribution and per-attempt export. */
export interface LlmProviderOptions {
  user?: string;
  metadata?: Record<string, string>;
  usageJsonl?: string;
}

export interface LlmTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  cacheWrite1hInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  durationMs?: number;
}

export type LlmUsageStatus = "started" | "completed" | "failed" | "rejected";
export interface LlmUsageReceipt {
  id: string;
  occurredAtMs: number;
  auth: "api";
  model: string;
  status: LlmUsageStatus;
  user?: string;
  metadata?: Record<string, string>;
  providerRequestId?: string;
  usage?: LlmTokenUsage;
  uncertainty?: "missing_usage" | "transport";
}
export interface LlmUsageAttempt {
  file: string;
  receipt: LlmUsageReceipt;
}

export function parseLlmProviderOptions(user: string, metadataJson: string, usageJsonl: string): LlmProviderOptions {
  let metadata: unknown;
  if (metadataJson) {
    try { metadata = JSON.parse(metadataJson); }
    catch { throw new Error("llm-metadata must be a JSON object of strings"); }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      Object.entries(metadata).some(([key, value]) => key.length > 64 || typeof value !== "string" || value.length > 512) ||
      Object.keys(metadata).length > 16) {
      throw new Error("llm-metadata must contain at most 16 string values (keys <=64, values <=512 characters)");
    }
  }
  return { ...(user ? {user} : {}), ...(metadata ? {metadata: metadata as Record<string, string>} : {}),
    ...(usageJsonl ? {usageJsonl: resolve(usageJsonl)} : {}) };
}

/** Preserve absence of cache-write usage instead of claiming a zero write. */
export function readLlmTokenUsage(value: unknown): LlmTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as {prompt_tokens?: unknown; completion_tokens?: unknown;
    prompt_tokens_details?: {cached_tokens?: unknown; cache_write_tokens?: unknown; cache_write_1h_tokens?: unknown};
    completion_tokens_details?: {reasoning_tokens?: unknown}};
  const input = raw.prompt_tokens;
  const output = raw.completion_tokens;
  const cached = raw.prompt_tokens_details?.cached_tokens ?? 0;
  const write = raw.prompt_tokens_details?.cache_write_tokens;
  const write1h = raw.prompt_tokens_details?.cache_write_1h_tokens;
  const reasoning = raw.completion_tokens_details?.reasoning_tokens ?? 0;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!count(input) || !count(output) || !count(cached) || !count(reasoning) || cached > input ||
    (write !== undefined && (!count(write) || write + cached > input)) ||
    (write1h !== undefined && (!count(write1h) || !count(write) || write1h > write))) return undefined;
  return {inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning,
    ...(write === undefined ? {} : {cacheWriteInputTokens: write as number}),
    ...(write1h === undefined ? {} : {cacheWrite1hInputTokens: write1h as number})};
}

function appendReceipt(attempt: LlmUsageAttempt): void {
  mkdirSync(dirname(attempt.file), {recursive: true, mode: 0o700});
  const fd = openSync(attempt.file, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(attempt.receipt)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Persist before dispatch so interrupted processes leave a visible attempt. */
export function beginLlmUsageAttempt(options: LlmProviderOptions, model: string): LlmUsageAttempt | undefined {
  if (!options.usageJsonl) return undefined;
  const attempt: LlmUsageAttempt = {file: options.usageJsonl, receipt: {
    id: randomUUID(), occurredAtMs: Date.now(), auth: "api", model, status: "started", uncertainty: "transport",
    ...(options.user ? {user: options.user} : {}), ...(options.metadata ? {metadata: options.metadata} : {}),
  }};
  appendReceipt(attempt);
  return attempt;
}

/** Consumers use the last line per stable attempt id, retaining every retry. */
export function finishLlmUsageAttempt(attempt: LlmUsageAttempt | undefined, status: Exclude<LlmUsageStatus, "started">,
  model: string, providerRequestId?: string, usage?: LlmTokenUsage): void {
  if (!attempt) return;
  const {uncertainty: _uncertainty, ...identity} = attempt.receipt;
  const receipt: LlmUsageReceipt = {...identity, status, model,
    ...(providerRequestId ? {providerRequestId} : {}), ...(usage ? {usage} : {}),
    ...(status === "rejected" || usage ? {} : {uncertainty: status === "completed" ? "missing_usage" : "transport"})};
  appendReceipt({...attempt, receipt});
}
