#!/usr/bin/env python3
"""Bounded Sol completion through the same native app-server path as T3."""

import importlib.machinery
import importlib.util
import json
from pathlib import Path
import signal
import sys
import time

from subscription_rpc import RpcClient, CompletionError, SubscriptionLimitError, reject_provider_error

MODEL = "gpt-6.1-sol"
PROFILE = "sol-6.1-medium-subscription"
BRIDGE = Path("/Users/rolly/.local/bin/agent-bridge")
CODEX = Path("/Users/rolly/.local/bin/codex")


def load_bridge():
    loader = importlib.machinery.SourceFileLoader("robin_native_boundary", str(BRIDGE))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class Client(RpcClient):
    provider = "codex"
    def __init__(self, *args):
        super().__init__(*args)
        self.messages = []
        self.completed = False
        self.usage = None

    def update(self, message):
        super().update(message)
        method = message.get("method")
        params = message.get("params", {})
        if method == "error":
            reject_provider_error(self.provider, params.get("error"))
        if method in ("item/started", "item/completed"):
            item = params.get("item", {})
            if item.get("type") not in ("userMessage", "agentMessage", "reasoning", "contextCompaction"):
                raise CompletionError("Codex attempted a tool or other non-completion item")
            if method == "item/completed" and item.get("type") == "agentMessage":
                self.messages.append(item.get("text", ""))
                if sum(len(text.encode()) for text in self.messages) > 10 * 1024 * 1024:
                    raise CompletionError("Codex completion exceeded the response limit")
        if method == "thread/tokenUsage/updated":
            total = params.get("tokenUsage", {}).get("total", {})
            keys = ("inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens")
            if all(type(total.get(key)) is int and total[key] >= 0 for key in keys):
                self.usage = {key: total[key] for key in keys}
        if method == "turn/completed":
            if params.get("turn", {}).get("status") != "completed":
                reject_provider_error(self.provider, params.get("turn", {}).get("error"), "Codex did not complete its turn")
            self.completed = True


def complete(prompt, root, timeout, codex=CODEX, bridge=None):
    if not 1 <= timeout <= 600:
        raise CompletionError("Completion timeout must be between 1 and 600 seconds")
    boundary = bridge or load_bridge()
    options = boundary.native_review_options()
    config_options = []
    for index, option in enumerate(options):
        if option in ("-c", "--disable"):
            config_options.extend((option, options[index + 1]))
    workdir = root / "completion-context"
    workdir.mkdir(mode=0o700)
    env = {"HOME": "/Users/rolly", "PATH": "/Users/rolly/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
           "TMPDIR": str(root)}
    client = Client([str(codex), "app-server", "--strict-config", *config_options], env, workdir, timeout)
    started = time.monotonic()
    try:
        client.rpc("initialize", {"clientInfo": {"name": "agent-bridge", "version": "1.0.0"}, "capabilities": {}})
        client.send({"method": "initialized", "params": {}})
        config = client.rpc("config/read", {"includeLayers": True, "cwd": str(workdir)})
        account = client.rpc("account/read", {"refreshToken": False})
        # Reuse the installed bridge's native proof: ChatGPT auth, no retained
        # MCP, minimal filesystem read scope and no network/writes/tool features.
        boundary.verify_native_review_preflight(config, account)
        limits = client.rpc("account/rateLimits/read", {})
        # This backend flag means included usage, unlike available purchased
        # credits or rounded percentages. Never infer recovery from a clock.
        allowed = limits.get("ordinaryUsageAllowed")
        if allowed is False:
            raise SubscriptionLimitError("codex", "quota")
        if allowed is not True:
            raise CompletionError("Codex included subscription allowance could not be verified")
        thread = client.rpc("thread/start", {"model": MODEL, "cwd": str(workdir),
            "approvalPolicy": "never", "ephemeral": True, "config": {"model_reasoning_effort": "medium"}})
        if thread.get("model") != MODEL:
            raise CompletionError("Codex did not select Sol 6.1")
        thread_id = thread["thread"]["id"]
        client.rpc("turn/start", {"threadId": thread_id, "model": MODEL, "effort": "medium",
            "input": [{"type": "text", "text": prompt}]})
        while not client.completed:
            client.update(client.next_message())
        content = "\n".join(client.messages).strip()
        if not content:
            raise CompletionError("Codex returned no completed assistant message")
        result = {"content": content, "model": PROFILE, "callId": thread_id,
            "provenance": {"provider": "codex", "auth": "subscription", "model": MODEL, "effort": "medium"}}
        if client.usage:
            result["usage"] = {**client.usage, "durationMs": round((time.monotonic() - started) * 1000)}
        return result
    finally:
        client.close(None)


def cancel(_signal, _frame):
    raise CompletionError("Completion cancelled")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        prompt_file = Path(sys.argv[1]).resolve(strict=True)
        print(json.dumps(complete(prompt_file.read_text(), prompt_file.parent, int(sys.argv[2]))))
    except SubscriptionLimitError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Native RPC/provider errors may contain arbitrary input; never echo them.
        print("Robin Codex subscription completion failed", file=sys.stderr)
        sys.exit(1)
