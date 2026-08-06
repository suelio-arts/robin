import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

jest.mock("child_process", () => ({ execFile: jest.fn() }));

import { LLMClient } from "./llm-client";

describe("LLMClient", () => {
  it("passes explicit reasoning effort to compatible providers", () => {
    const client = new LLMClient(
      "https://api.openai.com/v1",
      "test-key",
      "gpt-5.6-luna",
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
      model: "gpt-5.6-luna",
      effort: "high",
    }));
    (execFile as unknown as jest.Mock).mockImplementation((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({ result }), "");
    });

    try {
      const response = await new LLMClient(
        "rolly-agent",
        "",
        "luna-5-6-high-subscription",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "codex"
      ).chatCompletion("system", "user", true);
      expect(response.content).toBe('{"summary":"clean"}');
      expect(response.callId).toBe("test-session");
      expect(response.provenance).toEqual({
        provider: "codex",
        auth: "subscription",
        model: "gpt-5.6-luna",
        effort: "high",
      });
      expect(response.usage).toEqual({
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        durationMs: 1500,
      });
      expect(execFile).toHaveBeenCalledWith(
        "/Users/rolly/.local/bin/rolly",
        expect.arrayContaining(["--caller", "codex", "--agent", "luna-5-6-high-subscription"]),
        expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 }),
        expect.any(Function)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps non-Luna agents out of Robin's local transport", () => {
    expect(() => new LLMClient("rolly-agent", "", "opus-5-high-subscription"))
      .toThrow("Unsupported Robin local agent");
  });

});
