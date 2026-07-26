"""Real Edge regression: strict-CSP execute_js and click+wait across navigation.

Uses a temporary browser profile, local web server, and a test-only MCP port.
It never touches the user's normal Edge profile or the production port 49171.
"""

import http.client
import json
import os
import queue
import shutil
import socket
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"
EXTENSION_ID = "fjhjkmpldbepgcpfkhpolnnheccjaamg"
TARGET_MARKER = "OMEETY-NAVIGATION-TARGET-READY"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def start_web_server():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/target":
                body = f"<!doctype html><title>Target</title><h1>{TARGET_MARKER}</h1>"
            else:
                body = '<!doctype html><title>Strict CSP</title><a id="next" href="/target">Next page</a>'
            data = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; object-src 'none'")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class LegacySseMcpClient:
    def __init__(self, port):
        self.port = port
        self.inbox = queue.Queue()
        self.endpoint_ready = threading.Event()
        self.endpoint = None
        self.next_id = 0
        self.stop = False

    def connect(self):
        threading.Thread(target=self._read, daemon=True).start()
        if not self.endpoint_ready.wait(20):
            raise RuntimeError("MCP SSE endpoint did not become ready")
        self.call("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "browser-reliability-probe", "version": "1"},
        })
        self.post({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _read(self):
        connection = None
        for _ in range(40):
            try:
                connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
                connection.request("GET", "/sse", headers={"Accept": "text/event-stream"})
                response = connection.getresponse()
                if response.status == 200:
                    break
            except OSError:
                time.sleep(0.25)
        else:
            return

        event = None
        data = []
        while not self.stop:
            try:
                line = response.readline()
            except (OSError, http.client.HTTPException):
                # Expected when the temporary Edge context closes its native host.
                break
            if not line:
                break
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            if not text:
                payload = "\n".join(data)
                if event == "endpoint":
                    self.endpoint = payload
                    self.endpoint_ready.set()
                elif event == "message":
                    self.inbox.put(json.loads(payload))
                event, data = None, []
            elif text.startswith("event:"):
                event = text[6:].strip()
            elif text.startswith("data:"):
                data.append(text[5:].lstrip())
        if connection:
            connection.close()

    def post(self, message):
        body = json.dumps(message).encode("utf-8")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        connection.request("POST", self.endpoint, body=body, headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        response.read()
        connection.close()

    def call(self, method, params=None):
        self.next_id += 1
        request_id = self.next_id
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self.post(message)
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                reply = self.inbox.get(timeout=1)
            except queue.Empty:
                continue
            if reply.get("id") == request_id:
                if "error" in reply:
                    raise RuntimeError(str(reply["error"]))
                return reply["result"]
        raise TimeoutError(f"MCP call timed out: {method}")

    def tool(self, name, arguments):
        result = self.call("tools/call", {"name": name, "arguments": arguments})
        text = result.get("content", [{}])[0].get("text", "")
        if result.get("isError"):
            raise AssertionError(f"{name} failed: {text}")
        return json.loads(text)


def main():
    mcp_port = free_port()
    os.environ["OMEETY_MCP_PORT"] = str(mcp_port)
    profile = tempfile.mkdtemp(prefix="omeety-browser-reliability-")
    web_server = start_web_server()
    web_url = f"http://127.0.0.1:{web_server.server_port}/"

    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile,
                channel="msedge",
                headless=False,
                args=[
                    f"--disable-extensions-except={EXTENSION}",
                    f"--load-extension={EXTENSION}",
                    "--enable-extensions",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            )
            try:
                page = context.new_page()
                page.goto(web_url, wait_until="domcontentloaded")
                panel = context.new_page()
                panel.goto(f"chrome-extension://{EXTENSION_ID}/sidepanel.html", wait_until="domcontentloaded")
                try:
                    panel.click("#ackBtn", timeout=2000)
                except Exception:
                    pass

                service_worker = context.service_workers[0]
                service_worker.evaluate(
                    "async (url) => { const tabs = await chrome.tabs.query({});"
                    " const tab = tabs.find((item) => item.url === url);"
                    " if (tab) await chrome.tabs.update(tab.id, {active: true}); }",
                    web_url,
                )

                client = LegacySseMcpClient(mcp_port)
                client.connect()

                executed = client.tool("omeety_execute_js", {
                    "code": "return { title: document.title, linkCount: document.querySelectorAll('a').length }",
                })
                value = json.loads(executed["value"])
                assert value == {"title": "Strict CSP", "linkCount": 1}, value
                assert executed["transport"] == "cdp:Runtime.evaluate", executed
                isolated = client.tool("omeety_execute_js", {
                    "world": "ISOLATED",
                    "code": "return { title: document.title, isolated: true }",
                })
                assert json.loads(isolated["value"]) == {"title": "Strict CSP", "isolated": True}, isolated
                print("PASS strict-CSP execute_js in MAIN and ISOLATED worlds through CDP")

                clicked = client.tool("omeety_click", {
                    "selector": "#next",
                    "waitForText": TARGET_MARKER,
                    "waitForTimeoutMs": 8000,
                })
                assert clicked["clicked"] is True, clicked
                assert clicked["waited"]["found"] is True, clicked
                assert clicked["waited"]["navigationResilient"] is True, clicked
                print("PASS click + wait across full-document navigation")
                client.stop = True
            finally:
                context.close()
    finally:
        web_server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
