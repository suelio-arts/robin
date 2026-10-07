import { LlmProviderOptions, parseLlmProviderOptions } from "./llm-usage";

/** Generic provider configuration for direct-API evaluation runs. */
export function evalLlmProviderOptions(env: NodeJS.ProcessEnv): LlmProviderOptions {
  return parseLlmProviderOptions(
    env.EVAL_LLM_USER || "",
    env.EVAL_LLM_METADATA || "",
    env.EVAL_LLM_USAGE_JSONL || ""
  );
}
