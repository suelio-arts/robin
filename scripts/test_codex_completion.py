import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("codex_completion", Path(__file__).with_name("codex-completion.py"))
completion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(completion)

FAKE = r'''
import json,os,sys
from pathlib import Path
mode=Path(__file__).with_name("mode").read_text()
def emit(value): print(json.dumps(value),flush=True)
for line in sys.stdin:
 d=json.loads(line)
 if "id" not in d: continue
 method=d["method"]; params=d["params"]; result={}
 if method=="initialize":
  assert "GITHUB_TOKEN" not in os.environ and "OPENAI_API_KEY" not in os.environ
  assert sys.argv[1:]==["app-server","--strict-config","-c","approval_policy=\"never\"","--disable","shell_tool"]
 if method=="config/read":result={"safe":mode!="unsafe"}
 if method=="account/read":result={"account":{"type":"apiKey" if mode=="api" else "chatgpt"}}
 if method=="account/rateLimits/read":
  result={"ordinaryUsageAllowed":None if mode=="unknown-quota" else mode!="exhausted", "rateLimits":{"credits":{"hasCredits":True,"balance":"886.3"}}}
 if method=="thread/start":
  Path(__file__).with_name("thread-started").touch()
  assert Path(__file__).with_name("preflight").exists()
  assert params["model"]=="gpt-6.1-sol" and params["ephemeral"] is True
  assert params["approvalPolicy"]=="never" and params["config"]["model_reasoning_effort"]=="medium"
  result={"model":"other" if mode=="wrong-model" else params["model"],"thread":{"id":"test-thread"}}
 if method=="turn/start":
  assert params["model"]=="gpt-6.1-sol" and params["effort"]=="medium"
  assert params["input"]==[{"type":"text","text":"review evidence"}]
  if mode in ("quota-error","rate-error"):
   emit({"method":"error","params":{"error":{"codexErrorInfo":"usageLimitExceeded" if mode=="quota-error" else "rateLimitExceeded","message":"private-provider-detail"},"willRetry":False}})
   continue
  if mode=="client-tool":
   emit({"jsonrpc":"2.0","id":900,"method":"item/commandExecution/requestApproval","params":{}})
   continue
  item={"type":"commandExecution","command":"touch marker"} if mode=="tool" else {"type":"agentMessage","text":"clean"}
  emit({"method":"item/started","params":{"item":item}})
  if mode!="incomplete-text":emit({"method":"item/completed","params":{"item":item}})
  emit({"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"total":{"inputTokens":20,"cachedInputTokens":5,"outputTokens":4,"reasoningOutputTokens":2}}}})
  emit({"method":"turn/completed","params":{"turn":{"status":"failed" if mode=="failed" else "completed"}}})
  result={"turn":{"id":"turn"}}
 emit({"jsonrpc":"2.0","id":d["id"],"result":result})
'''


class CodexCompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / "codex"
        self.binary.write_text(f"#!{sys.executable}\n" + FAKE)
        self.binary.chmod(0o700)

    def run_completion(self, mode="ok"):
        (self.root / "mode").write_text(mode)
        work = self.root / "run"
        work.mkdir()
        root = self.root

        class Boundary:
            @staticmethod
            def native_review_options():
                return ["--ignore-user-config", "--ephemeral", "-c", 'approval_policy="never"', "--disable", "shell_tool"]

            @staticmethod
            def verify_native_review_preflight(config, account):
                if not config["safe"] or account["account"]["type"] != "chatgpt":
                    raise completion.CompletionError("Native subscription boundary rejected")
                (root / "preflight").touch()

        return completion.complete("review evidence", work, 5, codex=self.binary, bridge=Boundary)

    def test_exact_subscription_model_and_completed_text_with_native_usage(self):
        original = os.environ.copy()
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(original)))
        os.environ.update(GITHUB_TOKEN="must-not-inherit", OPENAI_API_KEY="must-not-inherit")
        result = self.run_completion()
        self.assertEqual(result["content"], "clean")
        self.assertEqual(result["callId"], "test-thread")
        self.assertEqual(result["provenance"], {"provider":"codex", "auth":"subscription", "model":"gpt-6.1-sol", "effort":"medium"})
        self.assertEqual(result["usage"]["inputTokens"], 20)
        self.assertEqual(result["usage"]["cachedInputTokens"], 5)

    def test_model_substitution_fails(self):
        with self.assertRaisesRegex(completion.CompletionError, "did not select"):
            self.run_completion("wrong-model")

    def test_exhausted_included_allowance_never_starts_thread_despite_paid_credits(self):
        with self.assertRaisesRegex(completion.SubscriptionLimitError, "codex:quota"):
            self.run_completion("exhausted")
        self.assertFalse((self.root / "thread-started").exists())

    def test_unknown_included_allowance_fails_closed(self):
        with self.assertRaisesRegex(completion.CompletionError, "allowance could not be verified"):
            self.run_completion("unknown-quota")
        self.assertFalse((self.root / "thread-started").exists())

    def test_native_usage_limit_is_reported_without_provider_details(self):
        with self.assertRaisesRegex(completion.SubscriptionLimitError, "^ROBIN_SUBSCRIPTION_LIMIT:codex:quota$"):
            self.run_completion("quota-error")

    def test_native_rate_limit_is_reported_without_provider_details(self):
        with self.assertRaisesRegex(completion.SubscriptionLimitError, "^ROBIN_SUBSCRIPTION_LIMIT:codex:rate-limit$"):
            self.run_completion("rate-error")

    def test_native_boundary_must_pass_before_thread_start(self):
        for mode in ("api", "unsafe"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp:
                # Each completion owns a fresh context directory.
                (self.root / "mode").write_text(mode)
                class Boundary:
                    native_review_options = staticmethod(lambda: ["-c", 'approval_policy="never"', "--disable", "shell_tool"])
                    @staticmethod
                    def verify_native_review_preflight(config, account):
                        if not config["safe"] or account["account"]["type"] != "chatgpt":
                            raise completion.CompletionError("Native subscription boundary rejected")
                with self.assertRaisesRegex(completion.CompletionError, "boundary rejected"):
                    completion.complete("review evidence", Path(temp), 5, codex=self.binary, bridge=Boundary)

    def test_tools_and_approvals_fail_without_execution(self):
        with self.assertRaisesRegex(completion.CompletionError, "non-completion item"):
            self.run_completion("tool")

    def test_client_request_fails(self):
        with self.assertRaisesRegex(completion.CompletionError, "client operation"):
            self.run_completion("client-tool")

    def test_failed_turn_is_not_a_review(self):
        with self.assertRaisesRegex(completion.CompletionError, "did not complete"):
            self.run_completion("failed")

    def test_partial_text_is_not_a_review(self):
        with self.assertRaisesRegex(completion.CompletionError, "no completed assistant"):
            self.run_completion("incomplete-text")


if __name__ == "__main__":
    unittest.main()
