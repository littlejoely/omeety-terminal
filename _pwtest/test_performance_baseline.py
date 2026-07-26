"""Headed Edge performance baseline for Omeety's real terminal pipeline.

Measures the extension page with CDP while output travels through the complete
PTY -> Native Messaging -> service worker -> side panel -> xterm path.  A
temporary Edge profile and a test-only MCP port keep the user's normal session
untouched.  Results are intentionally local-only because process timing is
machine-specific.
"""

import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from test_cursor_probe import EXT, EXT_ID, PROFILE_ROOT


os.environ["OMEETY_MCP_PORT"] = "49476"
RESULT = PROFILE_ROOT / "performance-baseline.local.json"


def terminal_text(page, lines=240):
    return page.evaluate(
        """(lineCount) => {
          const term = document.querySelector('.terminal-tab.active')?.__omeetyTerm;
          const buffer = term?.buffer?.active;
          if (!buffer) return '';
          const first = Math.max(0, buffer.length - lineCount);
          const out = [];
          for (let i = first; i < buffer.length; i++) {
            out.push(buffer.getLine(i)?.translateToString(true) || '');
          }
          return out.join('\\n');
        }""",
        lines,
    )


def wait_for_terminal_text(page, marker, timeout=30):
    deadline = time.perf_counter() + timeout
    while time.perf_counter() < deadline:
        if marker in terminal_text(page):
            return
        page.wait_for_timeout(50)
    raise AssertionError(f"terminal never showed {marker!r}")


def metrics(cdp):
    raw = cdp.send("Performance.getMetrics")["metrics"]
    values = {item["name"]: item["value"] for item in raw}
    wanted = (
        "Timestamp",
        "TaskDuration",
        "ScriptDuration",
        "LayoutDuration",
        "RecalcStyleDuration",
        "LayoutCount",
        "RecalcStyleCount",
        "JSHeapUsedSize",
        "JSHeapTotalSize",
        "Nodes",
        "Documents",
        "Frames",
    )
    return {name: values.get(name, 0) for name in wanted}


def delta(before, after, *names):
    return {name: after[name] - before[name] for name in names}


def main():
    PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="performance-", dir=PROFILE_ROOT))
    if sys.platform == "darwin":
        native_hosts = profile / "NativeMessagingHosts"
        native_hosts.mkdir(parents=True, exist_ok=True)
        (native_hosts / "com.omeety.terminal.json").write_text(json.dumps({
            "name": "com.omeety.terminal",
            "description": "Omeety Terminal performance regression host",
            "path": str(EXT.parent / "host" / "run-host.sh"),
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{EXT_ID}/"],
        }), encoding="utf-8")
    result = {}
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
                viewport={"width": 620, "height": 780},
                args=[
                    f"--disable-extensions-except={EXT}",
                    f"--load-extension={EXT}",
                    "--enable-extensions",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            )
            try:
                page = context.new_page()
                page.goto(
                    f"chrome-extension://{EXT_ID}/sidepanel.html",
                    wait_until="domcontentloaded",
                )
                try:
                    page.click("#ackBtn", timeout=3000)
                except Exception:
                    pass
                page.wait_for_function(
                    "() => document.getElementById('statusText').textContent.includes('已连接')",
                    timeout=15000,
                )
                page.click(".terminal-tab.active")

                cdp = context.new_cdp_session(page)
                cdp.send("Performance.enable")
                cdp.send("HeapProfiler.enable")
                cdp.send("HeapProfiler.collectGarbage")
                page.wait_for_timeout(500)

                initial = metrics(cdp)
                page.wait_for_timeout(5000)
                idle_end = metrics(cdp)
                result["idle5s"] = {
                    **delta(
                        initial,
                        idle_end,
                        "TaskDuration",
                        "ScriptDuration",
                        "LayoutDuration",
                        "RecalcStyleDuration",
                        "LayoutCount",
                        "RecalcStyleCount",
                    ),
                    "heapUsedBytes": idle_end["JSHeapUsedSize"],
                    "nodes": idle_end["Nodes"],
                }

                marker = "OMEETY_PERF_DONE"
                command = (
                    "1..2000 | ForEach-Object { Write-Output "
                    "(\"OMEETY_PERF_{0:D4} 0123456789abcdefghijklmnopqrstuvwxyz\" -f $_) }; "
                    f'Write-Output \"{marker}\"'
                    if sys.platform == "win32"
                    else "for i in {1..2000}; do printf 'OMEETY_PERF_%04d 0123456789abcdefghijklmnopqrstuvwxyz\\n' $i; done; "
                    f"printf '{marker}\\n'"
                )
                burst_before = metrics(cdp)
                started = time.perf_counter()
                page.keyboard.type(command, delay=0)
                page.keyboard.press("Enter")
                wait_for_terminal_text(page, marker)
                elapsed = time.perf_counter() - started
                page.wait_for_timeout(300)
                burst_after = metrics(cdp)
                result["output2000"] = {
                    "wallSeconds": elapsed,
                    "linesPerSecond": 2000 / elapsed,
                    **delta(
                        burst_before,
                        burst_after,
                        "TaskDuration",
                        "ScriptDuration",
                        "LayoutDuration",
                        "RecalcStyleDuration",
                        "LayoutCount",
                        "RecalcStyleCount",
                    ),
                    "heapUsedBytes": burst_after["JSHeapUsedSize"],
                    "nodes": burst_after["Nodes"],
                }

                # Exercise allocation and disposal of full xterm/WebGL instances.
                for _ in range(3):
                    page.click("#tabNew")
                    page.wait_for_timeout(250)
                churn_peak = metrics(cdp)
                for _ in range(3):
                    page.click(".tab.active .tab-close")
                    page.wait_for_timeout(250)
                cdp.send("HeapProfiler.collectGarbage")
                page.wait_for_timeout(800)
                churn_end = metrics(cdp)
                result["tabChurn"] = {
                    "peakHeapUsedBytes": churn_peak["JSHeapUsedSize"],
                    "afterGcHeapUsedBytes": churn_end["JSHeapUsedSize"],
                    "peakNodes": churn_peak["Nodes"],
                    "afterGcNodes": churn_end["Nodes"],
                    "remainingTabs": page.locator(".tab").count(),
                }
                result["environment"] = {
                    "edgeUserAgent": page.evaluate("navigator.userAgent"),
                    "viewport": page.viewport_size,
                    "terminalRenderer": page.locator(".terminal-tab.active").get_attribute(
                        "data-omeety-renderer"
                    ),
                }
                RESULT.write_text(
                    json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                print(json.dumps(result, ensure_ascii=False, indent=2))
                print(f"PASS performance baseline: {RESULT}")
            finally:
                context.close()
    finally:
        resolved = profile.resolve()
        if PROFILE_ROOT.resolve() in resolved.parents:
            shutil.rmtree(resolved, ignore_errors=True)


if __name__ == "__main__":
    main()
