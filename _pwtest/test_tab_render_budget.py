"""Headless regression for the multi-tab renderer budget.

Loads the real side-panel/xterm bundle with a minimal Chrome API stub. It
verifies that many terminal tabs retain exactly one WebGL renderer and that
rapid switching does not leak active renderers or raise page errors.
"""

import http.server
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]

CHROME_STUB = r"""
window.chrome = {
  runtime: {
    connect() {
      const listeners = [];
      return {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        onDisconnect: { addListener() {} },
        postMessage(message) {
          if (message?.type === "list_sessions") {
            queueMicrotask(() => listeners.forEach((fn) => fn({ type: "sessions_list", sessions: [] })));
          }
        },
        disconnect() {},
      };
    },
    lastError: null,
  },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  tabs: { create() {} },
};
"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, _format, *_args):
        pass


def renderer_state(page):
    return page.locator("#terminalHost .terminal-tab").evaluate_all(
        "els => els.map(el => ({ active: el.classList.contains('active'), renderer: el.dataset.omeetyRenderer }))"
    )


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    errors = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 520, "height": 700})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.add_init_script(CHROME_STUB)
            page.goto(f"http://127.0.0.1:{server.server_port}/extension/sidepanel.html")
            page.wait_for_selector(".tab")

            for _ in range(5):
                page.click("#tabNew")
            page.wait_for_timeout(300)

            state = renderer_state(page)
            assert len(state) == 6, state
            assert sum(item["renderer"] == "webgl" for item in state) == 1, state
            assert sum(item["renderer"] == "suspended" for item in state) == 5, state
            assert sum(item["active"] for item in state) == 1, state

            for index in range(30):
                page.locator(".tab").nth(index % 6).click()
                page.wait_for_timeout(20)

            state = renderer_state(page)
            assert sum(item["renderer"] == "webgl" for item in state) == 1, state
            assert sum(item["renderer"] == "suspended" for item in state) == 5, state
            assert not errors, errors
            browser.close()
            print("PASS tab render budget: 6 tabs, 1 WebGL renderer, 30 rapid switches")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
