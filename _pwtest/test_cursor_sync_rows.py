import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

from test_cursor_probe import EXT, EXT_ID, PROFILE_ROOT, terminal_state


os.environ['OMEETY_MCP_PORT'] = '49472'


def write_and_paint(page, data):
    page.evaluate(
        """data => new Promise((resolve) => {
          const t = document.querySelector('.terminal-tab.active').__omeetyTerm;
          t.write(data, () => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })""",
        data,
    )


def cursor_tuple(state):
    cursor = state.get('renderedCursor') or {}
    return cursor.get('x'), cursor.get('y')


def main():
    PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix='cursor-sync-rows-', dir=PROFILE_ROOT))
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                str(profile),
                channel='msedge',
                headless=False,
                viewport={'width': 900, 'height': 760},
                args=[
                    f'--disable-extensions-except={EXT}',
                    f'--load-extension={EXT}',
                    '--enable-extensions',
                    '--no-first-run',
                    '--no-default-browser-check',
                ],
            )
            try:
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(
                    f'chrome-extension://{EXT_ID}/sidepanel.html',
                    wait_until='domcontentloaded',
                )
                try:
                    page.click('#ackBtn', timeout=3000)
                except Exception:
                    pass
                page.click('.terminal-tab.active')
                page.wait_for_timeout(2500)

                baseline = terminal_state(page)
                baseline_cursor = cursor_tuple(baseline)
                baseline_hash = hashlib.sha256(page.screenshot()).hexdigest()

                # Simulate Codex emitting one synchronized frame in separate native-output
                # chunks: Working line, prompt line, then status line. The browser gets a paint
                # opportunity between chunks, exactly where the old WebGL cursor used to jump.
                fragments = [
                    '\x1b[?2026h',
                    '\x1b[5;1H• Working (4s • esc to interrupt)',
                    '\x1b[7;1H› Improve documentation in @filename',
                    '\x1b[9;1Hgpt-5.6-sol high · Context 63% used',
                ]
                states = []
                frame_hashes = []
                for fragment in fragments:
                    write_and_paint(page, fragment)
                    states.append(terminal_state(page))
                    frame_hashes.append(hashlib.sha256(page.screenshot()).hexdigest())

                assert all(state.get('synchronizedOutput') for state in states)
                assert any(
                    (state.get('cursorX'), state.get('cursorY')) != baseline_cursor
                    for state in states[1:]
                )
                assert all(cursor_tuple(state) == baseline_cursor for state in states)
                assert all(frame_hash == baseline_hash for frame_hash in frame_hashes)

                write_and_paint(page, '\x1b[?2026l')
                page.wait_for_timeout(250)
                final = terminal_state(page)
                final_cursor = cursor_tuple(final)
                buffer_cursor = (final.get('cursorX'), final.get('cursorY'))
                assert final.get('synchronizedOutput') is False
                assert final_cursor == buffer_cursor
                assert final_cursor != baseline_cursor
                assert not errors

                print(
                    'PASS cursor-sync-rows '
                    + json.dumps(
                        {
                            'intermediateBufferPositions': [
                                [state.get('cursorX'), state.get('cursorY')]
                                for state in states
                            ],
                            'renderedDuringTransaction': list(baseline_cursor),
                            'renderedAfterTransaction': list(final_cursor),
                            'intermediateFramesUnchanged': True,
                        },
                        ensure_ascii=False,
                    )
                )
            finally:
                context.close()
    finally:
        resolved = profile.resolve()
        if PROFILE_ROOT.resolve() in resolved.parents:
            shutil.rmtree(resolved, ignore_errors=True)


if __name__ == '__main__':
    main()
