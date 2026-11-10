#!/usr/bin/env python3
"""One bounded, tool-free Carbon completion using Rolly's existing T3 login."""

import json
from pathlib import Path
import signal
import sys
import time

from subscription_rpc import RpcClient, CompletionError

RELEASE = "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f"
HOME = Path("/Users/rolly")
INSTALL = HOME / ".t3/tools/antigravity-acp/darwin-arm64/versions" / RELEASE
TOKEN = HOME / ".t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/acp_token.json"
MODEL = "gemini-4-carbon"
EFFORT = "medium"


class Client(RpcClient):
    def __init__(self, *args):
        super().__init__(*args)
        self.text = []
        self.output_bytes = 0

    def update(self, message):
        super().update(message)
        if message.get("method") != "session/update":
            return
        update = message["params"]["update"]
        kind = update.get("sessionUpdate")
        if kind in ("tool_call", "tool_call_update"):
            raise CompletionError("Antigravity attempted a tool call")
        if kind == "agent_message_chunk" and update.get("content", {}).get("type") == "text":
            self.output_bytes += len(update["content"]["text"].encode())
            if self.output_bytes > 10 * 1024 * 1024:
                raise CompletionError("Antigravity exceeded the response limit")
            self.text.append(update["content"]["text"])


def complete(prompt, root, timeout, install=INSTALL, token=TOKEN):
    if not 1 <= timeout <= 600:
        raise CompletionError("Completion timeout must be between 1 and 600 seconds")
    if not token.is_file() or token.stat().st_mode & 0o077:
        raise CompletionError("Rolly T3 Antigravity login is missing or not private")
    profile = root / "antigravity-profile"
    native = profile / "antigravity-acp"
    native.mkdir(parents=True, mode=0o700)
    # Share only this host's existing OAuth login. No copied credential or ambient
    # user settings, hooks, skills, MCP servers, or repository instructions.
    (native / "acp_token.json").symlink_to(token)
    (native / "settings.json").write_text('{"auth":{"type":"oauth-personal"}}\n')
    (profile / "config").mkdir(mode=0o700)
    (profile / "config/mcp_config.json").write_text("{}\n")
    workdir = root / "completion-context"
    workdir.mkdir(mode=0o700)
    env = {"HOME": str(HOME), "PATH": "/opt/homebrew/bin:/usr/bin:/bin",
           "GEMINI_HOME": str(profile), "AGY_ACP_FORCE_FILE_STORAGE": "1",
           "ANTIGRAVITY_HARNESS_PATH": str(install / "localharness_external"),
           "BROWSER": "/usr/bin/false", "PYTHONUNBUFFERED": "1",
           "ELECTRON_RUN_AS_NODE": "1", "TMPDIR": str(root)}
    client = Client([str(install / "agy_acp_server.par")], env, workdir, timeout)
    session = None
    started = time.monotonic()
    try:
        initialized = client.rpc("initialize", {"protocolVersion": 1,
            "clientInfo": {"name": "zed", "version": "0.0.0"},
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}})
        if initialized.get("agentInfo", {}).get("version") != "1.4.5":
            raise CompletionError("Antigravity runtime is not the qualified 1.4.5 release")
        client.rpc("authenticate", {"methodId": "oauth-personal"})
        created = client.rpc("session/new", {"cwd": str(workdir), "mcpServers": [],
            "_meta": {"antigravity": {"enabledTools": ["finish"]}}})
        session = created["sessionId"]
        for key, value in (("model", MODEL), ("thinking_level", EFFORT)):
            selected = client.rpc("session/set_config_option", {"sessionId": session, "configId": key, "value": value})
            if not any(option.get("id") == key and option.get("currentValue") == value
                       for option in selected.get("configOptions", [])):
                raise CompletionError(f"Antigravity did not select the requested {key}")
        result = client.rpc("session/prompt", {"sessionId": session,
            "prompt": [{"type": "text", "text": prompt}]})
        content = "".join(client.text).strip()
        if result.get("stopReason") != "end_turn" or not content:
            raise CompletionError("Antigravity did not finish a nonempty text completion")
        return {"content": content, "model": "gemini-4-carbon-medium-subscription",
                "callId": session, "provenance": {"provider": "antigravity", "auth": "subscription",
                    "model": MODEL, "effort": EFFORT},
                "durationMs": round((time.monotonic() - started) * 1000)}
    finally:
        client.close(session)


def main():
    prompt_file, seconds = sys.argv[1:]
    prompt_file = Path(prompt_file).resolve(strict=True)
    result = complete(prompt_file.read_text(), prompt_file.parent, int(seconds))
    print(json.dumps(result))


def cancel(_signal, _frame):
    raise CompletionError("Completion cancelled")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        main()
    except (CompletionError, OSError, ValueError, KeyError) as error:
        print(f"Robin Antigravity completion failed: {error}", file=sys.stderr)
        sys.exit(1)
