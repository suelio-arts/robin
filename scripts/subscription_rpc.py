"""Bounded JSON-RPC subprocess transport for subscription completions."""

import json
import os
import select
import signal
import subprocess
import time

class CompletionError(Exception):
    pass


class RpcClient:
    def __init__(self, command, env, cwd, timeout):
        self.process = subprocess.Popen(command, cwd=cwd, env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, start_new_session=True, bufsize=0)
        os.set_blocking(self.process.stdin.fileno(), False)
        self.deadline = time.monotonic() + timeout
        self.buffer = b""
        self.sequence = 0

    def send(self, message):
        pending = memoryview((json.dumps(message) + "\n").encode())
        while pending:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise CompletionError("Subscription RPC write timed out")
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
            raise CompletionError("Subscription provider requested a client operation")

    def next_message(self):
        while time.monotonic() < self.deadline:
            if b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    raise CompletionError("Invalid subscription RPC frame")
                return message
            remaining = self.deadline - time.monotonic()
            if remaining > 0 and select.select([self.process.stdout], [], [], min(remaining, 1))[0]:
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise CompletionError("Subscription process exited before completing the request")
                self.buffer += chunk
                if len(self.buffer) > 10 * 1024 * 1024:
                    raise CompletionError("Subscription RPC exceeded the response limit")
        raise CompletionError("Subscription RPC response timed out")

    def rpc(self, method, params):
        self.sequence += 1
        request_id = self.sequence
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            message = self.next_message()
            if "method" not in message and message.get("id") == request_id:
                if "error" in message:
                    raise CompletionError(f"Subscription RPC {method} rejected (code {message['error'].get('code')})")
                return message["result"]
            self.update(message)

    def close(self, session):
        try:
            if session and time.monotonic() < self.deadline and self.process.poll() is None:
                self.deadline = min(self.deadline, time.monotonic() + 2)
                try:
                    self.rpc("session/close", {"sessionId": session})
                except Exception:
                    # A malformed close reply must not bypass group termination.
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

