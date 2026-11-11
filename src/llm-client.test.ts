import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

jest.mock("child_process", () => ({ execFile: jest.fn() }));

import { LLMClient, LOCAL_AGENT_COMPLETION_CONTRACT } from "./llm-client";
import { SubscriptionLimitError } from "./subscription-limit";

describe("LLMClient", () => {
  it.each([
    ["sol-6.1-medium-subscription", "codex", "quota", "quota exhausted"],
    ["gemini-4-carbon-medium-subscription", "antigravity", "rate-limit", "rate limit reached"],
  ])("reports %s limits explicitly with no automatic retry", async (model, provider, kind, detail) => {
    const mock = execFile as unknown as jest.Mock;
    mock.mockReset();
    mock.mockImplementation((_file, _args, _options, callback) => callback(new Error("failed"), "", `ROBIN_SUBSCRIPTION_LIMIT:${provider}:${kind}\n`));
    const result = new LLMClient("rolly-agent", "", model).chatCompletion("system", "user");
    await expect(result).rejects.toBeInstanceOf(SubscriptionLimitError);
    await expect(result).rejects.toThrow(`${provider} subscription ${detail}`);
    await expect(result).rejects.toThrow("re-request with /robin");
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["gemini-4-carbon-medium-subscription", "antigravity", "gemini-4-carbon", "antigravity-completion.py"],
    ["sol-6.1-medium-subscription", "codex", "gpt-6.1-sol", "codex-completion.py"],
  ])("runs %s through its bounded native helper without invented usage", async (model, provider, nativeModel, script) => {
    const result = {content: "clean", model, callId: "native-session",
      provenance: {provider, auth: "subscription", model: nativeModel, effort: "medium"}};
    const mock = execFile as unknown as jest.Mock;
    mock.mockReset();
    mock.mockImplementation((_file, _args, _options, callback) => callback(null, JSON.stringify(result), ""));
    const client = new LLMClient("rolly-agent", "", result.model);
    expect(await client.chatCompletion("system", "untrusted PR evidence")).toEqual(result);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe("/usr/bin/python3");
    expect(mock.mock.calls[0][1][0]).toBe(join(__dirname, "../scripts", script));
    expect(mock.mock.calls[0][2].env).toEqual({HOME: "/Users/rolly", PATH: "/usr/bin:/bin"});
    expect(client.getMetrics().calls).toBe(1);
    expect(() => new LLMClient("rolly-agent", "", "gemini-4-carbon-high-subscription")).toThrow("Unsupported Robin local agent");
  });

  it("runs the DeepSeek fallback seat on the Deploy API with an API-billed receipt", async () => {
    const result = {content: "clean", model: "deepseek-v4.1-flash-deploy", callId: "deploy-call",
      provenance: {provider: "deploy", auth: "api", model: "deepseek-ai/deepseek-v4.1-flash-1017", effort: "high"},
      usage: {inputTokens: 10, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 2}};
    const mock = execFile as unknown as jest.Mock;
    mock.mockReset();
    mock.mockImplementation((_file, _args, _options, callback) => callback(null, JSON.stringify(result), ""));
    const client = new LLMClient("rolly-agent", "", result.model);
    expect(await client.chatCompletion("system", "untrusted PR evidence")).toEqual(result);
    expect(mock.mock.calls[0][1][0]).toBe(join(__dirname, "../scripts", "deploy-completion.py"));
    expect(mock.mock.calls[0][2].env).toEqual({HOME: "/Users/rolly", PATH: "/usr/bin:/bin"});
    expect(client.getMetrics()).toEqual(expect.objectContaining({calls: 1, inputTokens: 10, outputTokens: 3}));
    mock.mockImplementation((_file, _args, _options, callback) => callback(null, JSON.stringify({...result,
      provenance: {...result.provenance, auth: "subscription"}}), ""));
    await expect(client.chatCompletion("system", "user")).rejects.toThrow("Invalid native completion receipt");
  });

  it("rejects Carbon receipts from another model or auth route without falling back", async () => {
    const mock = execFile as unknown as jest.Mock;
    mock.mockReset();
    mock.mockImplementation((_file, _args, _options, callback) => callback(null, JSON.stringify({content: "clean", model: "gemini-4-carbon-medium-subscription",
      callId: "s", provenance: {provider: "antigravity", auth: "api", model: "gemini-4-carbon", effort: "medium"}}), ""));
    await expect(new LLMClient("rolly-agent", "", "gemini-4-carbon-medium-subscription").chatCompletion("system", "user"))
      .rejects.toThrow("Invalid native completion receipt");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("reads token usage from a Claude result event", async () => {
    const root = await mkdtemp(join(tmpdir(), "robin-claude-usage-"));
    const result = join(root, "result.txt");
    const events = join(root, "events.jsonl");
    await writeFile(result, "{}");
    await writeFile(events, `${JSON.stringify({type: "result", usage: {input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 20, output_tokens: 5}})}\n`);
    await writeFile(`${result}.meta.json`, JSON.stringify({events, session: "s", provider: "claude", auth: "subscription", model: "m", effort: "medium", duration_seconds: 1}));
    (execFile as unknown as jest.Mock).mockReset();
    (execFile as unknown as jest.Mock).mockImplementation((_file, _args, _options, callback) => callback(null, JSON.stringify({ result }), ""));
    try {
      const client = new LLMClient("rolly-agent", "", "opus-5-5-medium-subscription");
      await client.chatCompletion("system", "user", true);
      expect(client.getMetrics()).toEqual(expect.objectContaining({calls: 1, inputTokens: 120, cachedInputTokens: 90, outputTokens: 5}));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["opus-5-5-low-subscription", true],
    ["opus-5-5-medium-subscription", true],
    ["opus-5-5-high-subscription", true],
    ["sol-6.1-low-subscription", false],
  ])("runs %s tool-free only when it is a Claude seat", async (model, toolFree) => {
    const root = await mkdtemp(join(tmpdir(), "robin-council-"));
    const result = join(root, "result.txt");
    await writeFile(result, "{}");
    const mock = execFile as unknown as jest.Mock;
    mock.mockReset();
    mock.mockImplementation((_file, _args, _options, callback) => callback(null, JSON.stringify({ result }), ""));
    try {
      await new LLMClient("rolly-agent", "", model).chatCompletion("system", "user", true);
      const args = mock.mock.calls[0][1] as string[];
      expect(args[args.indexOf("--agent") + 1]).toBe(model);
      expect(args.includes("--tool-policy")).toBe(toolFree);
      if (toolFree) expect(args[args.indexOf("--tool-policy") + 1]).toBe("none");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("runs subscription agents through Rolly without an API key", async () => {
    const root = await mkdtemp(join(tmpdir(), "robin-result-"));
    const result = join(root, "result.md");
    const events = join(root, "events.jsonl");
    await writeFile(result, '{"summary":"clean"}');
    await writeFile(events, `${JSON.stringify({type: "turn.completed", usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 20,
      reasoning_output_tokens: 5,
    }})}\n`);
    await writeFile(`${result}.meta.json`, JSON.stringify({
      duration_seconds: 1.5,
      events,
      session: "test-session",
      provider: "codex",
      auth: "subscription",
      model: "gpt-6-luna",
      effort: "high",
    }));
    (execFile as unknown as jest.Mock).mockImplementation((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({ result }), "");
    });

    try {
      const client = new LLMClient(
        "rolly-agent",
        "",
        "luna-6-high-subscription",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "codex"
      );
      const response = await client.chatCompletion("system", "user", true);
      expect(response.content).toBe('{"summary":"clean"}');
      expect(response.callId).toBe("test-session");
      expect(response.provenance).toEqual({
        provider: "codex",
        auth: "subscription",
        model: "gpt-6-luna",
        effort: "high",
      });
      expect(response.usage).toEqual({
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        durationMs: 1500,
      });
      expect(client.getMetrics()).toEqual(expect.objectContaining({
        calls: 1,
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 5,
      }));
      expect(execFile).toHaveBeenCalledWith(
        "/Users/rolly/.local/bin/rolly",
        expect.arrayContaining(["--caller", "codex", "--agent", "luna-6-high-subscription"]),
        expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 }),
        expect.any(Function)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only Sol 6.1 and Luna 6 subscription profiles on Robin's local transport", () => {
    for (const effort of ["low", "medium", "high"]) {
      expect(() => new LLMClient("rolly-agent", "", `sol-6.1-${effort}-subscription`)).not.toThrow();
      expect(() => new LLMClient("rolly-agent", "", `luna-6-${effort}-subscription`)).not.toThrow();
    }
    for (const effort of ["low", "medium", "high"]) {
      expect(() => new LLMClient("rolly-agent", "", `opus-5-5-${effort}-subscription`)).not.toThrow();
    }
    expect(() => new LLMClient("rolly-agent", "", "sonnet-5-5-medium-subscription")).not.toThrow();
    expect(() => new LLMClient("rolly-agent", "", "opus-5-high-subscription"))
      .toThrow("Unsupported Robin local agent");
    expect(() => new LLMClient("rolly-agent", "", "luna-5-6-low-subscription"))
      .toThrow("Unsupported Robin local agent");
    expect(() => new LLMClient("rolly-agent", "", "sol-6-low-subscription"))
      .toThrow("Unsupported Robin local agent");
    expect(() => new LLMClient("rolly-agent", "", "sol-6.1-xhigh-subscription"))
      .toThrow("Unsupported Robin local agent");
  });

});
