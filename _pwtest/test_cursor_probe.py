import hashlib
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
PROFILE_ROOT = ROOT / "_pwtest"
SCREENSHOT = PROFILE_ROOT / "cursor-probe.png"
EXT_ID = "fjhjkmpldbepgcpfkhpolnnheccjaamg"

# The headed probe gets its own native-host MCP port, so it cannot collide with
# the Omeety session running this test.
os.environ["OMEETY_MCP_PORT"] = "49471"


def terminal_state(page):
    return page.evaluate(
        """() => {
          const host = document.querySelector('.terminal-tab.active');
          const term = host && host.__omeetyTerm;
          if (!term) return { error: 'terminal not found' };
          const core = term._core;
          const service = core && (core.coreService || core._coreService);
          const modes = service && service.decPrivateModes;
          const renderer = core && core._renderService && core._renderService._renderer &&
            core._renderService._renderer.value;
          const renderedCursor = renderer && renderer._model && renderer._model.cursor;
          const textarea = term.element && term.element.querySelector('.xterm-helper-textarea');
          const style = textarea && getComputedStyle(textarea);
          const screen = term.element && term.element.querySelector('.xterm-screen');
          const rect = screen && screen.getBoundingClientRect();
          const cell = core && core._renderService && core._renderService.dimensions.css.cell;
          return {
            renderer: host.dataset.omeetyRenderer,
            cursorX: term.buffer.active.cursorX,
            cursorY: term.buffer.active.cursorY,
            optionCursorBlink: term.options.cursorBlink,
            optionCursorStyle: term.options.cursorStyle,
            modeCursorBlink: modes && modes.cursorBlink,
            modeCursorStyle: modes && modes.cursorStyle,
            synchronizedOutput: modes && modes.synchronizedOutput,
            cursorHidden: service && service.isCursorHidden,
            renderedCursor: renderedCursor && {
              x: renderedCursor.x,
              y: renderedCursor.y,
              width: renderedCursor.width,
              style: renderedCursor.style,
            },
            focused: document.activeElement === textarea,
            textarea: style && {
              opacity: style.opacity,
              caretColor: style.caretColor,
              color: style.color,
              left: style.left,
              top: style.top,
              width: style.width,
              height: style.height,
              zIndex: style.zIndex,
            },
            cursorRect: rect && cell && {
              x: rect.x + term.buffer.active.cursorX * cell.width,
              y: rect.y + term.buffer.active.cursorY * cell.height,
              width: Math.max(2, cell.width),
              height: Math.max(2, cell.height),
            },
          };
        }"""
    )


def main():
    PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="cursor-probe-", dir=PROFILE_ROOT))
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                str(profile),
                channel="msedge",
                headless=False,
                viewport={"width": 900, "height": 760},
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
                page_errors = []
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.goto(
                    f"chrome-extension://{EXT_ID}/sidepanel.html",
                    wait_until="domcontentloaded",
                )
                try:
                    page.click("#ackBtn", timeout=3000)
                except Exception:
                    pass

                page.click(".terminal-tab.active")
                page.wait_for_timeout(2500)

                # A stable-but-invisible cursor would also produce one pixel hash. Prove the
                # cursor is actually painted by comparing the same cell with DECTCEM on/off.
                visible_state = terminal_state(page)
                visible_rect = visible_state.get("cursorRect")
                assert visible_rect
                visible_hash = hashlib.sha256(page.screenshot()).hexdigest()
                page.evaluate(
                    """() => new Promise((resolve) => {
                      const t = document.querySelector('.terminal-tab.active').__omeetyTerm;
                      t.write('\\x1b[?25l', () => { t.refresh(0, t.rows - 1); requestAnimationFrame(resolve); });
                    })"""
                )
                page.wait_for_timeout(150)
                hidden_hash = hashlib.sha256(page.screenshot()).hexdigest()
                page.evaluate(
                    """() => new Promise((resolve) => {
                      const t = document.querySelector('.terminal-tab.active').__omeetyTerm;
                      t.write('\\x1b[?25h', () => { t.refresh(0, t.rows - 1); requestAnimationFrame(resolve); });
                    })"""
                )
                page.wait_for_timeout(150)
                restored_hash = hashlib.sha256(page.screenshot()).hexdigest()
                print(
                    "VISIBILITY="
                    + json.dumps(
                        {
                            "visibleDiffersFromHidden": visible_hash != hidden_hash,
                            "restoredMatchesVisible": restored_hash == visible_hash,
                        }
                    )
                )
                assert visible_hash != hidden_hash
                assert restored_hash == visible_hash

                page.keyboard.type(
                    "codex -c mcp_servers.omeety_terminal.enabled=false",
                    delay=15,
                )
                page.keyboard.press("Enter")
                page.wait_for_timeout(9000)

                before = terminal_state(page)
                print("STATE_BEFORE=" + json.dumps(before, ensure_ascii=False))

                # Verify the real xterm parser handler, including a control
                # sequence split across separate writes.
                page.evaluate(
                    """() => {
                      const t = document.querySelector('.terminal-tab.active').__omeetyTerm;
                      t.write('\x1b[?');
                      t.write('12h');
                    }"""
                )
                page.wait_for_timeout(300)
                after_injected_blink = terminal_state(page)
                print(
                    "STATE_AFTER_INJECT="
                    + json.dumps(after_injected_blink, ensure_ascii=False)
                )

                samples = []
                anchor_rect = before.get("cursorRect")
                for _ in range(30):
                    state = terminal_state(page)
                    rect = state.get("cursorRect")
                    digest = None
                    anchor_digest = None
                    if rect:
                        image = page.screenshot(clip=rect)
                        digest = hashlib.sha256(image).hexdigest()[:16]
                    if anchor_rect:
                        anchor_image = page.screenshot(clip=anchor_rect)
                        anchor_digest = hashlib.sha256(anchor_image).hexdigest()[:16]
                    samples.append(
                        {
                            "x": state.get("cursorX"),
                            "y": state.get("cursorY"),
                            "hash": digest,
                            "anchorHash": anchor_digest,
                            "modeBlink": state.get("modeCursorBlink"),
                            "optionBlink": state.get("optionCursorBlink"),
                        }
                    )
                    page.wait_for_timeout(100)

                page.screenshot(path=str(SCREENSHOT), full_page=True)
                page.wait_for_timeout(500)
                final_state = terminal_state(page)
                print("STATE_FINAL=" + json.dumps(final_state, ensure_ascii=False))
                print("SAMPLES=" + json.dumps(samples, ensure_ascii=False))
                summary = {
                    "uniquePositions": len({(s["x"], s["y"]) for s in samples}),
                    "uniqueCursorCellHashes": len(
                        {s["hash"] for s in samples if s["hash"]}
                    ),
                    "uniqueAnchorHashes": len(
                        {s["anchorHash"] for s in samples if s["anchorHash"]}
                    ),
                    "pageErrors": page_errors,
                    "screenshot": str(SCREENSHOT),
                }
                print("SUMMARY=" + json.dumps(summary, ensure_ascii=False))

                assert after_injected_blink.get("optionCursorBlink") is False
                assert summary["uniqueAnchorHashes"] == 1
                assert not page_errors
                rendered = final_state.get("renderedCursor") or {}
                assert (rendered.get("x"), rendered.get("y")) == (
                    final_state.get("cursorX"),
                    final_state.get("cursorY"),
                )
            finally:
                context.close()
    finally:
        resolved = profile.resolve()
        if PROFILE_ROOT.resolve() in resolved.parents:
            shutil.rmtree(resolved, ignore_errors=True)


if __name__ == "__main__":
    main()
