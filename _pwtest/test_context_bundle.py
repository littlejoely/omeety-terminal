"""Headless regression for Context Bundle and incremental snapshots."""

import http.server
import threading

from pathlib import Path
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
CONTENT_SCRIPT = ROOT / "extension" / "content.js"

PAGE = """<!doctype html>
<meta charset="utf-8">
<title>Context Lab</title>
<style>body{font-family:sans-serif}.box{margin:20px;padding:16px}#shadow-host{margin-top:900px}iframe{width:420px;height:120px}</style>
<main class="box">
  <h1>Context Bundle Lab</h1>
  <button id="target" aria-label="Save draft">Save draft</button>
  <div id="shadow-host"></div>
  <iframe id="same-frame" srcdoc="<label>Frame name <input id='frame-input' value='Alice'></label><button id='frame-button'>Frame action</button>"></iframe>
</main>
<script>
  const root = document.querySelector('#shadow-host').attachShadow({mode:'open'});
  root.innerHTML = `<style>button{color:rgb(12,34,56)}</style><button id="shadow-action" aria-label="Shadow action">Shadow action</button>`;
</script>"""

CHROME_STUB = """
window.__omeetyContentListener = null;
window.chrome = {
  runtime: {
    onMessage: { addListener(fn) { window.__omeetyContentListener = fn; } },
    sendMessage: async () => ({}),
  },
};
window.__omeetyCall = (tool, args = {}) => new Promise((resolve, reject) => {
  const listener = window.__omeetyContentListener;
  if (!listener) return reject(new Error('content listener unavailable'));
  let settled = false;
  const timer = setTimeout(() => { if (!settled) reject(new Error('tool timeout: ' + tool)); }, 3000);
  const sendResponse = value => { settled = true; clearTimeout(timer); resolve(value); };
  try { listener({type:'omeety_execute_tool', tool, arguments:args}, {}, sendResponse); }
  catch (error) { clearTimeout(timer); reject(error); }
});
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        data = PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def call(page, tool, args=None):
    return page.evaluate("([tool,args]) => window.__omeetyCall(tool,args)", [tool, args or {}])


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    errors = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 900, "height": 700})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.add_init_script(CHROME_STUB)
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            page.add_script_tag(path=str(CONTENT_SCRIPT))
            page.wait_for_function("window.__omeetyContentListener !== null")

            first = call(page, "omeety_get_page_snapshot", {"maxInteractive": 40})
            labels = {item.get("text"): item for item in first["interactive"]}
            assert "Shadow action" in labels, labels
            assert "Alice" in labels, labels
            assert first["topology"]["shadowRoots"] >= 1, first["topology"]
            assert first["topology"]["sameOriginFrames"] == 1, first["topology"]
            assert first["metrics"]["buildMs"] >= 0, first["metrics"]

            unchanged = call(page, "omeety_get_page_snapshot", {"sinceSnapshotId": first["snapshotId"], "maxInteractive": 40})
            assert unchanged["incremental"] is True and unchanged["unchanged"] is True, unchanged

            page.locator("#target").evaluate("el => { el.textContent='Draft saved'; el.setAttribute('aria-label','Draft saved'); }")
            changed = call(page, "omeety_get_page_snapshot", {"sinceSnapshotId": first["snapshotId"], "maxInteractive": 40})
            assert changed["incremental"] is True and changed["unchanged"] is False, changed
            assert changed["delta"]["interactiveUpsert"], changed["delta"]

            shadow_uid = labels["Shadow action"]["uid"]
            bundle = call(page, "omeety_get_context_bundle", {"uid": shadow_uid, "maxNearbyInteractive": 8})
            assert bundle["version"] == 1, bundle
            assert bundle["target"]["accessibleName"] == "Shadow action", bundle["target"]
            assert bundle["target"]["shadowPath"], bundle["target"]
            assert bundle["target"]["styles"]["color"] == "rgb(12, 34, 56)", bundle["target"]
            assert bundle["screenshotRequest"]["bbox"]["w"] > 0, bundle
            assert bundle["scrolledForScreenshot"] is True, bundle
            assert 0 <= bundle["screenshotRequest"]["bbox"]["y"] < 700, bundle["screenshotRequest"]

            frame_uid = labels["Alice"]["uid"]
            waited = call(page, "omeety_wait_for", {
                "targetUid": frame_uid,
                "valueEquals": "Alice",
                "titleIncludes": "Context",
                "match": "all",
                "probeOnly": True,
            })
            assert waited["found"] is True and waited["matchedBy"] == "all", waited
            assert not errors, errors
            browser.close()
            print("PASS Context Bundle: Shadow DOM + iframe + incremental snapshot + compound verification")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
