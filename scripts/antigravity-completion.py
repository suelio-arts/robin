#!/usr/bin/env python3
"""One bounded, tool-free Carbon completion using Rolly's existing T3 login."""

import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time

RELEASE = "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f"
HOME = Path("/Users/rolly")
INSTALL = HOME / ".t3/tools/antigravity-acp/darwin-arm64/versions" / RELEASE
TOKEN = HOME / ".t3/userdata/providers/antigravity/ac0a3dfd6dddb20962cecff6ee5fe65e19d3923be20e52c5ab52ff877f7e4c32/antigravity-acp/acp_token.json"
MODEL = "gemini-4-carbon"
EFFORT = "medium"


class CompletionError(Exception):
    pass


class Client:
    def __init__(self, command, env, cwd, timeout):
        self.process = subprocess.Popen(command, cwd=cwd, env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, start_new_session=True, bufsize=0)
        os.set_blocking(self.process.stdin.fileno(), False)
        self.deadline = time.monotonic() + timeout
        self.buffer = b""
        self.sequence = 0
        self.text = []
        self.output_bytes = 0

    def send(self, message):
        pending = memoryview((json.dumps(message) + "\n").encode())
        while pending:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise CompletionError("Antigravity write timed out")
            if select.select([], [self.process.stdin], [], min(remaining, 1))[1]:
                try:
                    written = os.write(self.process.stdin.fileno(), pending[:65536])
                    pending = pending[written:]
                except BlockingIOError:
                    continue

    def update(self, message):
        if "method" in message and "id" in message:
            # The completion has no client tools or interactive permission flow.
            self.send({"jsonrpc": "2.0", "id": message["id"],
                       "error": {"code": -32601, "message": "Robin permits no client tools"}})
            raise CompletionError("Antigravity requested a client operation")
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

    def rpc(self, method, params):
        self.sequence += 1
        request_id = self.sequence
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while time.monotonic() < self.deadline:
            while b"\n" in self.buffer:
                if time.monotonic() >= self.deadline:
                    raise CompletionError(f"Antigravity {method} timed out")
                line, self.buffer = self.buffer.split(b"\n", 1)
                try:
                    message = json.loads(line)
                except ValueError:
                    # The native OAuth client can emit a non-JSON sign-in notice.
                    continue
                if "method" not in message and message.get("id") == request_id:
                    if "error" in message:
                        # Provider data and login URLs must not reach Actions logs.
                        raise CompletionError(f"Antigravity {method} rejected (code {message['error'].get('code')})")
                    return message["result"]
                self.update(message)
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                break
            if select.select([self.process.stdout], [], [], min(remaining, 1))[0]:
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise CompletionError("Antigravity exited before completing the request")
                self.buffer += chunk
                if len(self.buffer) > 10 * 1024 * 1024:
                    raise CompletionError("Antigravity exceeded the response limit")
        raise CompletionError(f"Antigravity {method} timed out")

    def close(self, session):
        try:
            if session and time.monotonic() < self.deadline and self.process.poll() is None:
                self.deadline = min(self.deadline, time.monotonic() + 2)
                try:
                    self.rpc("session/close", {"sessionId": session})
                except (CompletionError, OSError):
                    pass
            # Kill the owned process group, including the native harness.
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except PermissionError:
                if self.process.poll() is None:
                    raise
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            # The parent can exit on SIGTERM while a native descendant ignores
            # it. Escalate for the group even when the parent already exited.
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                if self.process.poll() is None:
                    raise
            self.process.wait(timeout=1)
        finally:
            self.process.stdin.close()
            self.process.stdout.close()


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
