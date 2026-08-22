"""Regression for terminal content width while switching tabs.

The newly visible xterm must not paint at the full host width and then shrink
after the deferred renderer handoff/scrollbar layout settles.
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
      const emit = (message) => queueMicrotask(() => listeners.forEach((fn) => fn(message)));
      return {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        onDisconnect: { addListener() {} },
        postMessage(message) {
          if (message?.type === "list_sessions") emit({ type: "sessions_list", sessions: [] });
          if (message?.type === "hello") {
            const lines = Array.from({ length: 120 }, (_, i) => `line ${i} ${"x".repeat(90)}\r\n`).join("");
            emit({ type: "output", sid: message.sid, data: lines });
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


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    errors = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 390, "height": 720})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.add_init_script(CHROME_STUB)
            page.goto(f"http://127.0.0.1:{server.server_port}/extension/sidepanel.html")
            page.wait_for_selector(".tab")
            page.click("#tabNew")
            page.wait_for_timeout(250)

            samples = page.locator(".tab").first.evaluate(
                """async (tab) => {
                  const read = (phase) => {
                    const host = document.querySelector('.terminal-tab.active');
                    const hosts = [...document.querySelectorAll('.terminal-tab')];
                    const xterm = host?.querySelector('.xterm');
                    const viewport = host?.querySelector('.xterm-viewport');
                    const screen = host?.querySelector('.xterm-screen');
                    const scrollbar = host?.querySelector(
                      '.xterm-scrollable-element > :is(.scrollbar, .xterm-scrollbar)'
                    );
                    const rect = (el) => el ? el.getBoundingClientRect() : { width: 0, right: 0, left: 0 };
                    return {
                      phase,
                      visibleIndex: hosts.indexOf(host),
                      focusedVisible: document.activeElement?.closest('.terminal-tab') === host,
                      renderer: host?.dataset.omeetyRenderer,
                      hostWidth: rect(host).width,
                      xtermWidth: rect(xterm).width,
                      viewportWidth: rect(viewport).width,
                      screenWidth: rect(screen).width,
                      scrollbarWidth: rect(scrollbar).width,
                      rightGap: rect(xterm).right - rect(screen).right,
                    };
                  };
                  tab.click();
                  const result = [read('sync')];
                  await new Promise(requestAnimationFrame);
                  result.push(read('raf1'));
                  await new Promise(requestAnimationFrame);
                  result.push(read('raf2'));
                  await new Promise((resolve) => setTimeout(resolve, 60));
                  result.push(read('handoff'));
                  await new Promise(requestAnimationFrame);
                  result.push(read('settled'));
                  return result;
                }"""
            )

            widths = [round(sample["screenWidth"], 3) for sample in samples]
            assert max(widths) - min(widths) <= 0.5, samples
            assert samples[0]["visibleIndex"] == 1, samples
            assert samples[-1]["visibleIndex"] == 0, samples
            assert samples[-1]["focusedVisible"], samples
            assert 0 < samples[-1]["scrollbarWidth"] <= 1.5, samples
            assert not errors, errors
            browser.close()
            print("PASS tab width stability:", samples)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
