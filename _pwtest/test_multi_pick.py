"""Headed Edge regression for continuous element selection and PTY injection."""

import os
import json
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

from test_cursor_probe import EXT, EXT_ID, PROFILE_ROOT


os.environ["OMEETY_MCP_PORT"] = "49479"


HTML = b"""<!doctype html><meta charset=utf-8><title>Multi pick fixture</title>
<button id=alpha aria-label='Alpha action'>Alpha action</button>
<input id=beta placeholder='Beta input'>
<script>
document.body.dataset.activations = '0';
alpha.addEventListener('click', () => document.body.dataset.activations++);
</script>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(HTML)))
        self.end_headers()
        self.wfile.write(HTML)

    def log_message(self, *_args):
        pass


def terminal_text(page, lines=100):
    return page.evaluate(
        """(lineCount) => {
          const term = document.querySelector('.terminal-tab.active')?.__omeetyTerm;
          const buffer = term?.buffer?.active;
          if (!buffer) return '';
          const out = [];
          for (let i = Math.max(0, buffer.length - lineCount); i < buffer.length; i++) {
            out.push(buffer.getLine(i)?.translateToString(true) || '');
          }
          return out.join('\\n');
        }""",
        lines,
    )


def wait_for_terminal_text(page, marker, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        # xterm inserts visual row boundaries when a long injected summary
        # wraps in a narrow side panel; they are not newline bytes in the PTY.
        if marker in terminal_text(page).replace("\n", ""):
            return
        page.wait_for_timeout(50)
    status = page.locator("#statusText").text_content()
    raise AssertionError(
        f"terminal never received picker context {marker!r}; "
        f"status={status!r}; terminal={terminal_text(page)!r}"
    )


def main():
    PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="multi-pick-", dir=PROFILE_ROOT))
    if sys.platform == "darwin":
        native_hosts = profile / "NativeMessagingHosts"
        native_hosts.mkdir(parents=True, exist_ok=True)
        (native_hosts / "com.omeety.terminal.json").write_text(json.dumps({
            "name": "com.omeety.terminal",
            "description": "Omeety Terminal multi-pick regression host",
            "path": str(EXT.parent / "host" / "run-host.sh"),
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{EXT_ID}/"],
        }), encoding="utf-8")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            edge_path = Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
            browser_choice = (
                {"channel": "msedge"}
                if sys.platform != "darwin" or edge_path.exists()
                else {"executable_path": playwright.chromium.executable_path}
            )
            context = playwright.chromium.launch_persistent_context(
                str(profile),
                headless=False,
                **browser_choice,
                viewport={"width": 700, "height": 760},
                args=[
                    f"--disable-extensions-except={EXT}",
                    f"--load-extension={EXT}",
                    "--enable-extensions",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            )
            try:
                panel = context.new_page()
                panel.goto(
                    f"chrome-extension://{EXT_ID}/sidepanel.html",
                    wait_until="domcontentloaded",
                )
                try:
                    panel.click("#ackBtn", timeout=3000)
                except Exception:
                    pass
                panel.wait_for_function(
                    "() => document.getElementById('statusText').textContent.includes('已连接')",
                    timeout=15000,
                )

                fixture = context.new_page()
                fixture.goto(f"http://127.0.0.1:{server.server_port}/")
                fixture.wait_for_load_state("domcontentloaded")
                panel.bring_to_front()
                panel.click("#pickBtn")
                assert panel.locator("#pickBtn").text_content() == "完成选取"
                # In production the side panel is not a browser tab, so the
                # inspected page remains chrome.tabs.query({active:true}). This
                # test hosts sidepanel.html in a normal tab; explicitly route
                # the start message to the fixture to model real side-panel UI.
                panel.evaluate(
                    """async (urlPrefix) => {
                      const tabs = await chrome.tabs.query({});
                      const target = tabs.find((tab) => tab.url?.startsWith(urlPrefix));
                      if (!target?.id) throw new Error('fixture tab not found');
                      await chrome.tabs.sendMessage(target.id, { type: 'omeety_start_pick' });
                    }""",
                    f"http://127.0.0.1:{server.server_port}/",
                )

                fixture.bring_to_front()
                fixture.click("#alpha")
                fixture.click("#beta")
                assert fixture.locator('[data-omeety-pick-id="pick-1"]').count() == 1
                assert fixture.locator('[data-omeety-pick-id="pick-2"]').count() == 1
                assert fixture.locator('[data-omeety-pick-active="1"]').count() == 2
                assert fixture.locator("body").get_attribute("data-activations") == "0"
                fixture.keyboard.press("Enter")
                fixture.wait_for_function(
                    "() => document.querySelectorAll('[data-omeety-pick-active]').length === 0"
                )

                panel.bring_to_front()
                wait_for_terminal_text(panel, "Omeety selected 2 web elements")
                assert panel.locator("#pickBtn").text_content() == "选取"
                assert "写入当前终端输入框" in panel.locator("#statusText").text_content()
                print("PASS multi-pick: 2 stable refs + no page activation + PTY context injection")
            finally:
                context.close()
    finally:
        server.shutdown()
        server.server_close()
        resolved = profile.resolve()
        if PROFILE_ROOT.resolve() in resolved.parents:
            shutil.rmtree(resolved, ignore_errors=True)


if __name__ == "__main__":
    main()
