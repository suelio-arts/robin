import { execFile } from "child_process";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";

jest.mock("child_process", () => ({ execFile: jest.fn() }));

import { LLMClient, LOCAL_AGENT_COMPLETION_CONTRACT } from "./llm-client";
import { SubscriptionLimitError } from "./subscription-limit";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const mock = execFile as unknown as jest.Mock;

/** A fake `darma t3 run`: writes its run folder under the given TMPDIR like darma does. */
function fakeDarma(meta: Record<string, unknown>, events?: object[]) {
  const runs: string[] = [];
  mock.mockReset();
  mock.mockImplementation((_file: string, _args: string[], options: {env: {TMPDIR: string}}, callback: Callback) => {
    const run = join(options.env.TMPDIR, "darma-t3-run-1");
    const result = join(run, "result.md");
    runs.push(run);
    void (async () => {
      await mkdir(run);
      await writeFile(result, "clean");
      const eventsPath = events ? `${result}.events.jsonl` : undefined;
      if (eventsPath) await writeFile(eventsPath, events!.map((e) => JSON.stringify(e)).join("\n") + "\n");
      await writeFile(`${result}.meta.json`, JSON.stringify({...meta, ...(eventsPath ? {events: eventsPath} : {})}));
      callback(null, JSON.stringify({result}), "");
    })();
  });
  return runs;
}

describe("LLMClient", () => {
  it.each([
    ["opus-5-5-low-subscription", "claude", "quota", "quota exhausted"],
    ["sol-6.1-medium-subscription", "codex", "quota", "quota exhausted"],
    ["gemini-4-carbon-medium-subscription", "antigravity", "rate-limit", "rate limit reached"],
  ])("reports %s limits explicitly with no automatic retry", async (model, provider, kind, detail) => {
    mock.mockReset();
    mock.mockImplementation((_file, _args, _options, callback: Callback) =>
      callback(new Error("failed"), "", `ROBIN_SUBSCRIPTION_LIMIT:${provider}:${kind}\n`));
    const result = new LLMClient("rolly-agent", "", model).chatCompletion("system", "user");
    await expect(result).rejects.toBeInstanceOf(SubscriptionLimitError);
    await expect(result).rejects.toThrow(`${provider} subscription ${detail}`);
    await expect(result).rejects.toThrow("re-request with /robin");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  const claudeEvents = [
    {type: "system", subtype: "init"},
    {type: "assistant", message: {usage: {input_tokens: 1, output_tokens: 1}}},
    {type: "rate_limit_event", rate_limit_info: {status: "allowed", isUsingOverage: false}},
    {type: "result", usage: {input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 20, output_tokens: 5}},
  ];
  const codexEvents = [{type: "turn.completed", usage: {input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5}}];
  it.each([
    ["opus-5-5-low-subscription", "claudeAgent", "claude", "claude-opus-5-5", "low", claudeEvents,
      {inputTokens: 120, cachedInputTokens: 90, outputTokens: 5, reasoningOutputTokens: 0, durationMs: 1500}],
    ["sol-6.1-medium-subscription", "codex", "codex", "gpt-6.1-sol", "medium", codexEvents,
      {inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5, durationMs: 1500}],
    ["gemini-4-carbon-medium-subscription", "antigravity", "antigravity", "gemini-4-carbon", "medium", undefined, undefined],
  ])("runs %s through darma t3 run on the T3 %s account", async (model, instance, provider, slug, effort, events, usage) => {
    const provenance = {provider, auth: "subscription", model: slug, effort};
    const runs = fakeDarma({session: "call-1", duration_seconds: 1.5, ...provenance}, events);
    const client = new LLMClient("rolly-agent", "", model);
    const response = await client.chatCompletion("system", "untrusted PR evidence");
    expect(response).toEqual({content: "clean", model, callId: "call-1", provenance, ...(usage ? {usage} : {})});
    expect(mock).toHaveBeenCalledTimes(1);
    const [file, args, options] = mock.mock.calls[0];
    expect(file).toBe("/Users/rolly/.local/bin/darma");
    const root = options.env.TMPDIR as string;
    expect(args).toEqual(["t3", "run", "--root", "/Users/rolly/.t3", "--instance", instance, "--model", slug,
      "--effort", effort, "--prompt", join(root, "prompt.md"), "--workdir", join(root, "context"), "--timeout", expect.stringMatching(/^\d+$/)]);
    expect(options.env).toEqual({HOME: "/Users/rolly", PATH: "/Users/rolly/.local/bin:/usr/bin:/bin", TMPDIR: root});
    expect(dirname(runs[0])).toBe(root);
    expect(existsSync(root)).toBe(false);
    expect(client.getMetrics().calls).toBe(1);
  });

  it("rejects a darma receipt for another seat or auth route without falling back", async () => {
    for (const meta of [
      {session: "s", provider: "antigravity", auth: "api", model: "gemini-4-carbon", effort: "medium"},
      {session: "s", provider: "antigravity", auth: "subscription", model: "gemini-4-carbon", effort: "high"},
      {provider: "antigravity", auth: "subscription", model: "gemini-4-carbon", effort: "medium"},
    ]) {
      fakeDarma(meta);
      await expect(new LLMClient("rolly-agent", "", "gemini-4-carbon-medium-subscription").chatCompletion("system", "user"))
        .rejects.toThrow("Invalid subscription completion receipt");
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });

  it("runs the DeepSeek fallback seat on the Deploy API with an API-billed receipt", async () => {
    const result = {content: "clean", model: "deepseek-v4.1-flash-deploy", callId: "deploy-call",
      provenance: {provider: "deploy", auth: "api", model: "deepseek-ai/deepseek-v4.1-flash-1017", effort: "high"},
      usage: {inputTokens: 10, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 2}};
    mock.mockReset();
    mock.mockImplementation((_file, _args, _options, callback: Callback) => callback(null, JSON.stringify(result), ""));
    const client = new LLMClient("rolly-agent", "", result.model);
    expect(await client.chatCompletion("system", "untrusted PR evidence")).toEqual(result);
    expect(mock.mock.calls[0][0]).toBe("/usr/bin/python3");
    expect(mock.mock.calls[0][1][0]).toBe(join(__dirname, "../scripts", "deploy-completion.py"));
    expect(mock.mock.calls[0][2].env).toEqual({HOME: "/Users/rolly", PATH: "/usr/bin:/bin"});
    expect(client.getMetrics()).toEqual(expect.objectContaining({calls: 1, inputTokens: 10, outputTokens: 3}));
    mock.mockImplementation((_file, _args, _options, callback: Callback) => callback(null, JSON.stringify({...result,
      provenance: {...result.provenance, auth: "subscription"}}), ""));
    await expect(client.chatCompletion("system", "user")).rejects.toThrow("Invalid native completion receipt");
  });

  it("confines local agents to the supplied completion evidence", () => {
    expect(LOCAL_AGENT_COMPLETION_CONTRACT).toContain("Do not call tools");
    expect(LOCAL_AGENT_COMPLETION_CONTRACT).toContain("only the evidence supplied");
  });

  it("passes explicit reasoning effort to compatible providers", () => {
    const client = new LLMClient(
      "https://api.openai.com/v1",
      "test-key",
      "gpt-6-luna",
      undefined,
      undefined,
      undefined,
      undefined,
      "low"
    );

    const request = (client as any).buildRequest("system", "user", true);
    expect(request.reasoning_effort).toBe("low");
  });


  it("accepts only known subscription families at low, medium or high effort", () => {
    for (const family of ["sol-6.1", "luna-6", "opus-5-5", "sonnet-5-5", "gemini-4-carbon"]) {
      for (const effort of ["low", "medium", "high"]) {
        expect(() => new LLMClient("rolly-agent", "", `${family}-${effort}-subscription`)).not.toThrow();
      }
    }
    for (const model of ["opus-5-high-subscription", "luna-5-6-low-subscription", "sol-6-low-subscription",
      "sol-6.1-xhigh-subscription", "gpt-6.1-sol"]) {
      expect(() => new LLMClient("rolly-agent", "", model)).toThrow("Unsupported Robin local agent");
    }
  });
});
