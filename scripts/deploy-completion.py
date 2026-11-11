#!/usr/bin/env python3
"""One bounded, tool-free DeepSeek completion on Rolly's existing Deploy API key.

Same provider, model and key file as Rolly's OpenCode `deploy` provider, called
directly so the untrusted diff never reaches an agent harness with tools.
"""

import json
from pathlib import Path
import signal
import sys
import time
import urllib.error
import urllib.request

KEY = Path("/Users/rolly/.credentials/deploy-api-key")
URL = "https://api.deploy.com/api/v1/chat/completions"
MODEL = "deepseek-ai/deepseek-v4.1-flash-1017"
EFFORT = "high"


class CompletionError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib forwards Authorization across redirects; refuse them so the key stays with the API."""
    def redirect_request(self, *_):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def complete(prompt, timeout, key=KEY, url=URL):
    if not 1 <= timeout <= 600:
        raise CompletionError("Completion timeout must be between 1 and 600 seconds")
    if not key.is_file() or key.stat().st_mode & 0o077:
        raise CompletionError("Rolly Deploy API key is missing or not private")
    body = {"model": MODEL, "reasoning_effort": EFFORT, "max_tokens": 32768,
            "messages": [{"role": "user", "content": prompt}]}
    request = urllib.request.Request(url, json.dumps(body).encode(), {
        "Authorization": f"Bearer {key.read_text().strip()}", "Content-Type": "application/json"})
    started = time.monotonic()
    try:
        with OPENER.open(request, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise CompletionError(f"Deploy API returned HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError) as error:
        raise CompletionError(f"Deploy API unreachable: {getattr(error, 'reason', error)}") from None
    choice = result["choices"][0]
    content = (choice["message"].get("content") or "").strip()
    if result.get("model") != MODEL or choice.get("finish_reason") != "stop" or choice["message"].get("tool_calls") or not content:
        raise CompletionError("Deploy API did not finish a nonempty text completion from the requested model")
    usage = result.get("usage") or {}
    return {"content": content, "model": "deepseek-v4.1-flash-deploy", "callId": result["id"],
            "provenance": {"provider": "deploy", "auth": "api", "model": MODEL, "effort": EFFORT},
            "usage": {"inputTokens": usage.get("prompt_tokens", 0), "cachedInputTokens": 0,
                      "outputTokens": usage.get("completion_tokens", 0),
                      "reasoningOutputTokens": usage.get("reasoning_tokens", 0)},
            "durationMs": round((time.monotonic() - started) * 1000)}


def main():
    prompt_file, seconds = sys.argv[1:]
    print(json.dumps(complete(Path(prompt_file).resolve(strict=True).read_text(), int(seconds))))


def cancel(_signal, _frame):
    raise CompletionError("Completion cancelled")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        main()
    except (CompletionError, OSError, ValueError, KeyError, IndexError) as error:
        print(f"Robin Deploy completion failed: {error}", file=sys.stderr)
        sys.exit(1)
