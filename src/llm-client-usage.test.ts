import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

const mockCreate = jest.fn();
jest.mock("openai", () => {
  const actual = jest.requireActual("openai");
  return {OpenAI: Object.assign(jest.fn(() => ({chat: {completions: {create: mockCreate}}})),
    {APIError: actual.OpenAI.APIError})};
});
jest.mock("./llm-retry", () => ({...jest.requireActual("./llm-retry"), delayMs: jest.fn(async () => {})}));
import { OpenAI } from "openai";
import { LLMClient } from "./llm-client";
import { parseLlmProviderOptions } from "./llm-usage";

const options = {user: "generic:test:review", metadata: {feature: "review", environment: "test"}};
let root: string;
let usageJsonl: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "robin-api-usage-"));
  usageJsonl = join(root, "receipts.jsonl");
  mockCreate.mockReset();
});
afterEach(async () => rm(root, {recursive: true, force: true}));
const receipts = async () => (await readFile(usageJsonl, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const client = (model = "gpt-6-luna", maxAttempts = 1) => new LLMClient("https://api.openai.com/v1", "secret-fixture-key",
  model, 8000, 60000, maxAttempts, undefined, "low", "github", {...options, usageJsonl});
const response = (content = "{}") => ({id: "provider_fixture", model: "gpt-6-luna", choices: [{message: {content}, finish_reason: "length"}],
  usage: {prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: {cached_tokens: 400, cache_write_tokens: 200},
    completion_tokens_details: {reasoning_tokens: 5}}});

test("actual SDK request carries generic metadata and persists split usage before text extraction", async () => {
  mockCreate.mockImplementation(async request => {
    expect(request.user).toBe(options.user);
    expect(request.metadata).toEqual(options.metadata);
    const before = JSON.parse(readFileSync(usageJsonl, "utf8"));
    expect(before.status).toBe("started");
    expect(before.uncertainty).toBe("transport");
    return response();
  });
  const instance = client();
  const extract = jest.spyOn(instance as any, "extractMessageContent").mockImplementation(() => {
    const lines = readFileSync(usageJsonl, "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1)!).usage.cacheWriteInputTokens).toBe(200);
    throw new Error("fixture decode rejection");
  });
  await expect(instance.chatCompletion("private-system", "private-user")).rejects.toThrow("fixture decode rejection");
  expect(extract).toHaveBeenCalled();
  const lines = await receipts();
  expect(lines).toHaveLength(2);
  expect(lines[0].id).toBe(lines[1].id);
  expect(lines[1]).toMatchObject({status: "completed", auth: "api", providerRequestId: "provider_fixture",
    usage: {inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 200, outputTokens: 20}});
  expect(JSON.stringify(lines)).not.toMatch(/private-system|private-user|secret-fixture-key/);
});

test("empty charged responses and retries produce distinct complete attempt receipts", async () => {
  mockCreate.mockResolvedValueOnce(response("")).mockResolvedValueOnce(response("{}"));
  await expect(client("gpt-6-luna", 2).chatCompletion("system", "user")).resolves.toMatchObject({content: "{}"});
  const lines = await receipts();
  expect(lines).toHaveLength(4);
  expect(lines.filter(line => line.status === "completed")).toHaveLength(2);
  expect(new Set(lines.map(line => line.id)).size).toBe(2);
});

test("missing usage remains uncertain while definite HTTP rejection supersedes its started marker", async () => {
  mockCreate.mockResolvedValueOnce({...response(), usage: undefined});
  await client().chatCompletion("system", "user");
  expect((await receipts()).at(-1)).toMatchObject({status: "completed", uncertainty: "missing_usage"});
  mockCreate.mockRejectedValueOnce(new OpenAI.APIError(400, undefined, "fixture rejected", undefined));
  await expect(client().chatCompletion("system", "user")).rejects.toThrow();
  const rejected = (await receipts()).at(-1);
  expect(rejected.status).toBe("rejected");
  expect(rejected.uncertainty).toBeUndefined();
});

test("interrupted streams preserve reported usage and request identity", async () => {
  mockCreate.mockImplementation(async request => {
    expect(request.stream_options).toEqual({include_usage: true});
    return (async function* () {
      yield {id: "stream_fixture", model: "actual-route", choices: [{delta: {content: "partial"}}]};
      yield {id: "stream_fixture", model: "actual-route", choices: [], usage: response().usage};
      throw new Error("fixture connection reset");
    })();
  });
  await expect(client("openrouter/free").chatCompletion("system", "user")).rejects.toThrow("fixture connection reset");
  expect((await receipts()).at(-1)).toMatchObject({status: "failed", model: "actual-route", providerRequestId: "stream_fixture",
    usage: {inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 200, outputTokens: 20}});
});

test("dispatch errors retain transport uncertainty; absent configuration preserves the existing request", async () => {
  mockCreate.mockRejectedValueOnce(new Error("fixture reset"));
  await expect(client().chatCompletion("system", "user")).rejects.toThrow();
  expect((await receipts()).at(-1)).toMatchObject({status: "failed", uncertainty: "transport"});
  mockCreate.mockResolvedValueOnce(response());
  await new LLMClient("https://api.openai.com/v1", "fixture-key", "gpt-6-luna").chatCompletion("system", "user");
  expect(mockCreate.mock.calls.at(-1)![0].metadata).toBeUndefined();
  expect(mockCreate.mock.calls.at(-1)![0].user).toBeUndefined();
});

test("action option parser rejects non-string metadata without leaking its contents", () => {
  expect(() => parseLlmProviderOptions("", '{"bad":42}', "")).toThrow("string");
  expect(() => parseLlmProviderOptions("", "[1]", "")).toThrow("string");
  expect(parseLlmProviderOptions("caller", '{"feature":"review"}', usageJsonl)).toEqual({
    user: "caller", metadata: {feature: "review"}, usageJsonl});
});


test("SDK retries stay disabled and HTTP 500 retries produce one receipt pair per actual call", async () => {
  mockCreate.mockRejectedValueOnce(new OpenAI.APIError(500, undefined, "fixture server error", undefined))
    .mockResolvedValueOnce(response());
  await client("gpt-6-luna", 2).chatCompletion("system", "user");
  expect(OpenAI).toHaveBeenLastCalledWith(expect.objectContaining({maxRetries: 0}));
  expect(mockCreate).toHaveBeenCalledTimes(2);
  const lines = await receipts();
  expect(lines).toHaveLength(4);
  expect(new Set(lines.map(line => line.id)).size).toBe(2);
  expect(lines[1]).toMatchObject({status: "failed", uncertainty: "transport"});
  expect(lines[3]).toMatchObject({status: "completed", usage: {inputTokens: 1000}});
});

test("HTTP 408 remains ambiguous rather than disappearing as an unbilled rejection", async () => {
  mockCreate.mockRejectedValueOnce(new OpenAI.APIError(408, undefined, "fixture timeout", undefined));
  await expect(client().chatCompletion("system", "user")).rejects.toThrow();
  expect((await receipts()).at(-1)).toMatchObject({status: "failed", uncertainty: "transport"});
});
