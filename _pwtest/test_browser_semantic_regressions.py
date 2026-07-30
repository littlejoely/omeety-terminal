"""Real Chromium regressions for Browser Core semantic actions.

Exercises document-scoped UIDs, rich-text verification, icon-only controls,
SPA target-state transitions, and explicit rich-text sending without touching
the user's browser profile or network.
"""

import http.server
import sys
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"


class AppHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = """<!doctype html><title>Semantic regression</title>
        <button id="stable" aria-label="Stable action">Stable action</button>
        <div id="stable-result">idle</div>
        <div id="conversation" role="tab" aria-selected="false"><span>Alice</span></div>
        <div id="conversation-title">Inbox</div>
        <div id="editor" role="textbox" contenteditable="true"><p><br></p></div>
        <button id="send"><svg data-icon="SendColorful"><title>Send message</title></svg></button>
        <div id="messages"></div>
        <script>
        document.addEventListener('click', event => {
          if (event.target.closest('#stable')) document.querySelector('#stable-result').textContent = 'clicked';
          if (event.target.closest('#conversation')) {
            const target = document.querySelector('#conversation');
            target.setAttribute('aria-selected', 'true');
            target.classList.add('is-selected');
            document.querySelector('#conversation-title').textContent = 'Alice';
          }
          if (event.target.closest('#send')) {
            const editor = document.querySelector('#editor');
            const text = editor.innerText.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
            editor.innerHTML = '<p><br></p>';
            const bubble = document.createElement('div');
            bubble.className = 'message';
            bubble.textContent = text;
            document.querySelector('#messages').appendChild(bubble);
          }
        });
        </script>"""
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


class OtherOriginHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = """<!doctype html><title>Other origin</title>
        <button id="other">Other action</button>
        <script>window.crossOriginClicks=0;document.querySelector('#other').onclick=()=>window.crossOriginClicks++;</script>"""
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def start_server(handler):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    app = start_server(AppHandler)
    other = start_server(OtherOriginHandler)
    profile = tempfile.TemporaryDirectory(prefix="omeety-semantic-")
    errors = []
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile.name,
                headless=True,
                **({"channel": "msedge"} if sys.platform == "win32" else {}),
                args=[
                    f"--disable-extensions-except={EXTENSION}",
                    f"--load-extension={EXTENSION}",
                    "--enable-extensions",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            )
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            url = f"http://127.0.0.1:{app.server_port}/"
            page.goto(url, wait_until="domcontentloaded")
            if not context.service_workers:
                context.wait_for_event("serviceworker", timeout=10_000)
            worker = context.service_workers[0]
            tab_id = worker.evaluate(
                "async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id",
                url,
            )
            assert tab_id, "extension could not resolve the regression tab"

            def content_tool(name, arguments):
                return worker.evaluate(
                    "async arg => chrome.tabs.sendMessage(arg.tabId, {type:'omeety_execute_tool',tool:arg.name,arguments:arg.arguments})",
                    {"tabId": tab_id, "name": name, "arguments": arguments},
                )

            snapshot = content_tool("omeety_get_page_snapshot", {"maxInteractive": 50})
            stable = next(item for item in snapshot["interactive"] if item["text"] == "Stable action")
            assert stable["uid"].startswith("u") and "-" in stable["uid"], stable
            page.eval_on_selector("#stable", "el => el.outerHTML='<button id=stable aria-label=\"Stable action\">Stable action</button>'")
            recovered = content_tool("omeety_click", {"uid": stable["uid"], "confirmed": True})
            assert recovered["clicked"] is True, recovered
            page.wait_for_function("document.querySelector('#stable-result').textContent === 'clicked'")

            conversation = worker.evaluate(
                "async arg => globalThis.__omeetyActAndVerify(arg.tabId,{action:'click',selector:'#conversation',confirmed:true,expect:{text:'Alice'},timeoutMs:2000})",
                {"tabId": tab_id},
            )
            assert conversation["result"]["verified"] is True, conversation
            assert conversation["result"]["verificationStrength"] == "target-state-transition", conversation
            assert conversation["result"]["after"]["target"]["selected"] is True, conversation
            selected = content_tool(
                "omeety_wait_for",
                {"targetSelector": "#conversation", "selected": True, "classIncludes": "is-selected", "match": "all", "probeOnly": True},
            )
            assert selected["found"] is True, selected

            page.eval_on_selector("#editor", "el => el.innerHTML='<p>Hello\\u200b</p><p>World</p>'")
            rich_text = content_tool(
                "omeety_wait_for",
                {"targetSelector": "#editor", "valueEquals": "Hello\nWorld", "probeOnly": True},
            )
            assert rich_text["found"] is True, rich_text

            semantic = content_tool("omeety_get_page_snapshot", {"maxInteractive": 50})
            send = next(item for item in semantic["interactive"] if item["text"] == "SendColorful")
            sent = worker.evaluate(
                """async arg => globalThis.__omeetyActAndVerify(arg.tabId,{
                  action:'click',uid:arg.uid,confirmed:true,
                  expect:{targetSelector:'#editor',valueEquals:'',text:'Hello',match:'all'},timeoutMs:2000
                })""",
                {"tabId": tab_id, "uid": send["uid"]},
            )
            assert sent["result"]["verified"] is True, sent
            assert page.locator("#editor").inner_text().strip() == ""
            assert "Hello" in page.locator("#messages").inner_text()
            assert "World" in page.locator("#messages").inner_text()

            page.goto(f"http://localhost:{other.server_port}/", wait_until="domcontentloaded")
            stale = worker.evaluate(
                "async arg => globalThis.__omeetyActAndVerify(arg.tabId,{action:'click',uid:arg.uid,confirmed:true,verify:false})",
                {"tabId": tab_id, "uid": stable["uid"]},
            )
            assert stale["ok"] is False, stale
            assert page.evaluate("window.crossOriginClicks") == 0
            assert not errors, errors
            context.close()
            print("PASS Browser Core semantic regressions: scoped UID, rich text, icon semantics, SPA state, explicit send")
    finally:
        app.shutdown()
        other.shutdown()
        profile.cleanup()


if __name__ == "__main__":
    main()
