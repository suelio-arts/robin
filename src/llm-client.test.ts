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
    await writeFile(result, '{"summary":"clean"}');
    (execFile as unknown as jest.Mock).mockImplementation((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({ result }), "");
    });

    try {
      const response = await new LLMClient(
        "rolly-agent",
        "",
        "luna-5-6-high-subscription"
      ).chatCompletion("system", "user", true);
      expect(response.content).toBe('{"summary":"clean"}');
      expect(execFile).toHaveBeenCalledWith(
        "/Users/rolly/.local/bin/rolly",
        expect.arrayContaining(["--caller", "github", "--agent", "luna-5-6-high-subscription"]),
        expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 }),
        expect.any(Function)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
