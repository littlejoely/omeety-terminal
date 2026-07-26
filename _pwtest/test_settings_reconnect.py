"""Headed Edge regression for the settings save/reconnect lifecycle.

Uses a temporary browser profile and test-only MCP port, so it does not touch
the user's normal Omeety session or persisted shell preference.
"""

import os
import shutil
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from test_cursor_probe import EXT, EXT_ID, PROFILE_ROOT


os.environ["OMEETY_MCP_PORT"] = "49474"


def buffer_text(page):
    return page.evaluate(
        """() => {
          const host = document.querySelector('.terminal-tab.active');
          const term = host?.__omeetyTerm;
          const buffer = term?.buffer?.active;
          if (!buffer) return '';
          const first = Math.max(0, buffer.length - 100);
          const lines = [];
          for (let i = first; i < buffer.length; i++) {
            lines.push(buffer.getLine(i)?.translateToString(true) || '');
          }
          return lines.join('\\n');
        }"""
    )


def wait_for_terminal_text(page, marker, timeout=15):
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = buffer_text(page)
        if marker in last:
            return last
        page.wait_for_timeout(100)
    raise AssertionError(f"terminal never showed {marker!r}; tail={last[-1200:]!r}")


def assert_terminal_view(page):
    assert page.locator("#terminalView").evaluate("el => el.classList.contains('active')")
    assert not page.locator("#settingsView").evaluate("el => el.classList.contains('active')")
    assert page.locator("#settingsToggle").text_content() == "⚙"
    assert "danger" not in (page.locator("#settingsToggle").get_attribute("class") or "")


def main():
    PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="settings-reconnect-", dir=PROFILE_ROOT))
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                str(profile),
                channel="msedge",
                headless=False,
                viewport={"width": 540, "height": 760},
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

                # Switch to CMD and save. The panel connection must stay alive, the
                # settings view must close, and the toggle must return to the gear.
                page.click("#settingsToggle")
                page.select_option("#shellSelect", "cmd")
                page.click("#saveBtn")
                assert_terminal_view(page)
                page.wait_for_function(
                    "() => document.getElementById('statusText').textContent.includes('已连接')",
                    timeout=15000,
                )
                page.keyboard.type("echo OMEETY_CMD_RECONNECTED", delay=2)
                page.keyboard.press("Enter")
                wait_for_terminal_text(page, "OMEETY_CMD_RECONNECTED")

                # The top-right toggle and the explicit back button share one state
                # transition, so either way out restores the icon and terminal view.
                page.click("#settingsToggle")
                assert page.locator("#settingsToggle").text_content() == "×"
                page.click("#backBtn")
                assert_terminal_view(page)

                # A custom executable path must remain represented as "custom" after
                # saving; previously it silently appeared as PowerShell on next load.
                custom_shell = r"C:\Windows\System32\cmd.exe"
                page.click("#settingsToggle")
                page.select_option("#shellSelect", "custom")
                page.fill("#shellCustom", custom_shell)
                page.click("#saveBtn")
                page.wait_for_function(
                    "() => document.getElementById('statusText').textContent.includes('已连接')",
                    timeout=15000,
                )
                page.reload(wait_until="domcontentloaded")
                page.wait_for_function(
                    "() => document.getElementById('statusText').textContent.includes('已连接')",
                    timeout=15000,
                )
                page.click("#settingsToggle")
                assert page.locator("#shellSelect").input_value() == "custom"
                assert page.locator("#shellCustom").input_value() == custom_shell
                page.click("#backBtn")
                assert_terminal_view(page)

                print("PASS settings reconnect: atomic PTY restart + restored toggle + custom shell persistence")
            finally:
                context.close()
    finally:
        resolved = profile.resolve()
        if PROFILE_ROOT.resolve() in resolved.parents:
            shutil.rmtree(resolved, ignore_errors=True)


if __name__ == "__main__":
    main()
