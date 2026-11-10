import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import subprocess
import unittest

spec = importlib.util.spec_from_file_location("completion", Path(__file__).with_name("antigravity-completion.py"))
completion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(completion)

FAKE = r'''
import json,os,sys,time,subprocess
from pathlib import Path
mode=Path(__file__).with_name("mode").read_text()
for line in sys.stdin:
 d=json.loads(line)
 if "method" not in d:continue
 method=d["method"]; params=d["params"]; result={}
 if method=="initialize": result={"agentInfo":{"version":"1.4.5"}}
 if method=="session/new":
  assert params["mcpServers"]==[]
  assert params["_meta"]["antigravity"]=={"enabledTools":["finish"]}
  assert "GITHUB_TOKEN" not in os.environ and "GEMINI_API_KEY" not in os.environ
  profile=Path(os.environ["GEMINI_HOME"])
  assert (profile/"antigravity-acp/acp_token.json").is_symlink()
  assert json.loads((profile/"config/mcp_config.json").read_text())=={}
  result={"sessionId":"test-session"}
 if method=="session/set_config_option":
  result={"configOptions":[{"id":params["configId"],"currentValue":"wrong" if mode=="wrong-model" else params["value"]}]}
 if method=="session/prompt":
  if mode=="timeout":
   child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(300)"])
   Path(__file__).with_name("child-pid").write_text(str(child.pid))
   time.sleep(300)
  if mode=="client-tool":
   print(json.dumps({"jsonrpc":"2.0","id":900,"method":"fs/read_text_file","params":{}}),flush=True)
   continue
  update={"sessionUpdate":"tool_call","title":"read_file"} if mode=="tool" else {"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"clean"}}
  print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"update":update}}),flush=True)
  result={"stopReason":"cancelled" if mode=="cancelled" else "end_turn"}
 if method=="session/close":Path(__file__).with_name("closed").touch()
 print(json.dumps({"jsonrpc":"2.0","id":d["id"],"result":result}),flush=True)
'''


class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.install = self.root / "install"
        self.install.mkdir()
        self.binary = self.install / "agy_acp_server.par"
        self.binary.write_text(f"#!{sys.executable}\n" + FAKE)
        self.binary.chmod(0o700)
        self.token = self.root / "existing-login.json"
        self.token.write_text("{}")
        self.token.chmod(0o600)
        self.addCleanup(self.temp.cleanup)

    def run_completion(self, mode="ok", timeout=5):
        (self.install / "mode").write_text(mode)
        work = self.root / "run"
        work.mkdir()
        return completion.complete("review evidence", work, timeout, self.install, self.token)

    def test_text_only_subscription_receipt_and_closed_session(self):
        original = os.environ.copy()
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(original)))
        os.environ.update(GITHUB_TOKEN="must-not-inherit", GEMINI_API_KEY="must-not-inherit")
        result = self.run_completion()
        self.assertEqual(result["content"], "clean")
        self.assertEqual(result["provenance"], {"provider":"antigravity", "auth":"subscription", "model":"gemini-4-carbon", "effort":"medium"})
        self.assertTrue((self.install / "closed").exists())
        self.assertEqual(self.token.read_text(), "{}")

    def test_wrong_model_cannot_fall_back(self):
        with self.assertRaisesRegex(completion.CompletionError, "requested model"):
            self.run_completion("wrong-model")

    def test_model_tool_call_cannot_be_accepted_as_completion(self):
        with self.assertRaisesRegex(completion.CompletionError, "tool call"):
            self.run_completion("tool")

    def test_client_operation_is_rejected_without_execution(self):
        with self.assertRaisesRegex(completion.CompletionError, "client operation"):
            self.run_completion("client-tool")

    def test_cancelled_prompt_is_not_a_successful_review(self):
        with self.assertRaisesRegex(completion.CompletionError, "did not finish"):
            self.run_completion("cancelled")

    def test_timeout_terminates_native_process_group(self):
        with self.assertRaisesRegex(completion.CompletionError, "timed out"):
            self.run_completion("timeout", timeout=5)
        pid = int((self.install / "child-pid").read_text())
        # A terminated orphan may briefly remain as a zombie awaiting init.
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        self.assertTrue(not state or state.startswith("Z"), state)

    def test_nonreading_server_cannot_block_write_or_cleanup(self):
        client = completion.Client([sys.executable, "-c", "import time; time.sleep(300)"],
                                   os.environ.copy(), self.root, 0.1)
        started = time.monotonic()
        try:
            with self.assertRaisesRegex(completion.CompletionError, "write timed out"):
                client.rpc("large-prompt", {"text": "x" * 1_000_000})
            self.assertLess(time.monotonic() - started, 1)
        finally:
            client.close("session")
        self.assertIsNotNone(client.process.returncode)
        self.assertLess(time.monotonic() - started, 4)

    def test_parent_exit_does_not_leave_sigterm_ignoring_descendant(self):
        ready = self.root / "ready"
        child_code = "import signal,time,pathlib,os; signal.signal(signal.SIGTERM,signal.SIG_IGN); pathlib.Path(" + repr(str(ready)) + ").write_text(str(os.getpid())); time.sleep(300)"
        parent_code = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c'," + repr(child_code) + "]); time.sleep(300)"
        client = completion.Client([sys.executable, "-c", parent_code], os.environ.copy(), self.root, 10)
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready.exists(), "fixture child did not start")
        finally:
            client.close(None)
        pid = int(ready.read_text())
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        self.assertTrue(not state or state.startswith("Z"), state)

    def test_nonprivate_login_is_refused(self):
        self.token.chmod(0o644)
        with self.assertRaisesRegex(completion.CompletionError, "not private"):
            self.run_completion()


if __name__ == "__main__":
    unittest.main()
