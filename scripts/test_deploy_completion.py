import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

spec = importlib.util.spec_from_file_location("completion", Path(__file__).with_name("deploy-completion.py"))
completion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(completion)


class Handler(BaseHTTPRequestHandler):
    reply = {}
    status = 200
    seen = []

    def do_POST(self):
        Handler.seen.append((self.headers["Authorization"], json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
        self.send_response(Handler.status)
        if Handler.status == 307:
            self.send_header("Location", "/elsewhere")
        self.end_headers()
        self.wfile.write(json.dumps(Handler.reply).encode())

    def log_message(self, *_):
        pass


def reply(content="clean", model=completion.MODEL, finish="stop", tool_calls=None):
    return {"id": "call-1", "model": model, "usage": {"prompt_tokens": 7, "completion_tokens": 5, "reasoning_tokens": 2},
            "choices": [{"finish_reason": finish, "message": {"content": content, "tool_calls": tool_calls}}]}


class DeployCompletionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/chat/completions"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.key = Path(self.root.name) / "deploy-api-key"
        self.key.write_text("secret-key\n")
        os.chmod(self.key, 0o600)
        Handler.status, Handler.reply, Handler.seen = 200, reply(), []

    def tearDown(self):
        self.root.cleanup()

    def run_completion(self):
        return completion.complete("prompt", 30, key=self.key, url=self.url)

    def test_returns_api_billed_receipt_with_pinned_model_and_effort(self):
        result = self.run_completion()
        self.assertEqual(result["content"], "clean")
        self.assertEqual(result["model"], "deepseek-v4.1-flash-deploy")
        self.assertEqual(result["provenance"], {"provider": "deploy", "auth": "api", "model": completion.MODEL, "effort": "high"})
        self.assertEqual(result["usage"]["inputTokens"], 7)
        auth, body = Handler.seen[0]
        self.assertEqual(auth, "Bearer secret-key")
        self.assertEqual((body["model"], body["reasoning_effort"]), (completion.MODEL, "high"))
        self.assertNotIn("tools", body)
        self.assertNotIn("secret-key", json.dumps(result))

    def test_rejects_substituted_model_tool_calls_and_truncation(self):
        for bad in (reply(model="other"), reply(tool_calls=[{"id": "t"}]), reply(finish="length"), reply(content=" ")):
            Handler.reply = bad
            with self.assertRaises(completion.CompletionError):
                self.run_completion()

    def test_http_errors_do_not_echo_the_response_or_key(self):
        Handler.status, Handler.reply = 402, {"error": "secret-key insufficient balance"}
        with self.assertRaises(completion.CompletionError) as raised:
            self.run_completion()
        self.assertEqual(str(raised.exception), "Deploy API returned HTTP 402")

    def test_refuses_redirects_so_the_key_is_not_forwarded(self):
        Handler.status = 307
        with self.assertRaisesRegex(completion.CompletionError, "HTTP 307"):
            self.run_completion()
        self.assertEqual(len(Handler.seen), 1)

    def test_requires_a_private_key_file(self):
        os.chmod(self.key, 0o644)
        with self.assertRaisesRegex(completion.CompletionError, "not private"):
            self.run_completion()


if __name__ == "__main__":
    unittest.main()
