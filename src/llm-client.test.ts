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

  it("uses hosted web search only on the OpenAI Responses API", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: "gpt-5.6-luna",
        output: [{type: "message", content: [{type: "output_text", text: "{\"high\":[]}"}]}],
      }),
    }) as typeof fetch;
    try {
      const client = new LLMClient("https://api.openai.com/v1", "test-key", "gpt-5.6-luna");
      expect(client.supportsWebSearch()).toBe(true);
      await expect(client.webSearchCompletion("system", "user")).resolves.toMatchObject({
        content: "{\"high\":[]}",
      });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/responses",
        expect.objectContaining({method: "POST"})
      );
      const request = (global.fetch as jest.Mock).mock.calls[0][1];
      expect(JSON.parse(request.body)).toMatchObject({
        tools: [{type: "web_search", search_context_size: "low"}],
        input: [{role: "system", content: "system"}, {role: "user", content: "user"}],
      });
      expect(JSON.parse(request.body)).not.toHaveProperty("reasoning");
      expect(new LLMClient("https://openrouter.ai/api/v1", "test-key", "model").supportsWebSearch()).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("fails once on token-limited web-search responses", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "incomplete",
        incomplete_details: {reason: "max_output_tokens"},
        output: [{type: "message", content: [{type: "output_text", text: "partial"}]}],
      }),
    }) as typeof fetch;
    try {
      const client = new LLMClient("https://api.openai.com/v1", "test-key", "gpt-5.6-luna");
      await expect(client.webSearchCompletion("system", "user")).rejects.toThrow(/max_output_tokens/);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
