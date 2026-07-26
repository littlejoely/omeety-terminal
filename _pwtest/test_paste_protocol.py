"""Headless regression for long-paste delivery.

Exercises the real side-panel and xterm bundle with a minimal Chrome API stub.
Long text pasted through the macOS shortcut or the terminal context menu must
reach the PTY once, as one bracketed-paste event, so Codex can collapse it.
"""

import http.server
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]

CHROME_STUB = r"""
window.__omeetyMessages = [];
window.chrome = {
  runtime: {
    connect() {
      const listeners = [];
      return {
        onMessage: { addListener(fn) { listeners.push(fn); } },
        onDisconnect: { addListener() {} },
        postMessage(message) {
          window.__omeetyMessages.push(message);
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


def input_messages(page):
    return page.evaluate("() => window.__omeetyMessages.filter(message => message.type === 'input')")


def assert_bracketed_once(messages, expected):
    assert len(messages) == 1, messages
    data = messages[0]["data"]
    assert data.startswith("\x1b[200~"), repr(data[:24])
    assert data.endswith("\x1b[201~"), repr(data[-24:])
    assert data[6:-6] == expected, (len(data), len(expected))


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
            page.wait_for_selector(".terminal-tab.active")

            payload = "OMEETY_LONG_PASTE\n" + "x" * 1_200
            normalized = payload.replace("\n", "\r")
            page.evaluate(
                """payload => new Promise(resolve => {
                  Object.defineProperty(navigator, "clipboard", {
                    configurable: true,
                    value: {
                      readText: async () => payload,
                      writeText: async () => {},
                    },
                  });
                  const host = document.querySelector(".terminal-tab.active");
                  host.__omeetyTerm.write("\\x1b[?2004h", resolve);
                })""",
                payload,
            )

            # macOS primary paste shortcut. This used to bypass Omeety's
            # controlled paste path because only Ctrl+V was intercepted.
            page.evaluate("window.__omeetyMessages = []")
            page.evaluate(
                """() => {
                  const textarea = document.querySelector(".terminal-tab.active .xterm-helper-textarea");
                  textarea.focus();
                  textarea.dispatchEvent(new KeyboardEvent("keydown", {
                    key: "v", code: "KeyV", metaKey: true,
                    bubbles: true, cancelable: true,
                  }));
                }"""
            )
            page.wait_for_function("window.__omeetyMessages.some(message => message.type === 'input')")
            assert_bracketed_once(input_messages(page), normalized)

            # Right-click paste must use the exact same xterm paste path.
            page.evaluate("window.__omeetyMessages = []")
            page.evaluate(
                """() => document.querySelector(".terminal-tab.active").dispatchEvent(
                  new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })
                )"""
            )
            page.wait_for_function("window.__omeetyMessages.some(message => message.type === 'input')")
            assert_bracketed_once(input_messages(page), normalized)

            assert not errors, errors
            browser.close()
            print("PASS paste protocol: Cmd+V and context menu send one 1,218-char bracketed paste")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
