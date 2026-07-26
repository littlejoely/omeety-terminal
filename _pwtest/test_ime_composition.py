import json
import os
import shutil
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

from test_cursor_probe import EXT, EXT_ID, PROFILE_ROOT, terminal_state


os.environ['OMEETY_MCP_PORT'] = '49477'


def ime_state(page):
    return page.evaluate(
        """() => {
          const host = document.querySelector('.terminal-tab.active');
          const t = host.__omeetyTerm;
          const composition = t._core?._compositionView;
          const textarea = t._core?.textarea;
          const renderer = t._core?._renderService?._renderer?.value;
          const cursor = renderer?._model?.cursor;
          const rect = element => {
            const r = element.getBoundingClientRect();
            return {left: r.left, top: r.top, width: r.width, height: r.height};
          };
          return {
            active: composition.classList.contains('active'),
            compositionText: composition.textContent,
            composition: rect(composition),
            textarea: rect(textarea),
            rendered: cursor ? [cursor.x, cursor.y] : null,
            buffer: [t.buffer.active.cursorX, t.buffer.active.cursorY],
            committed: host.dataset.omeetyCursorGuardCommitted || null,
            imeAnchor: host.dataset.omeetyImeAnchor || null,
            synchronized: Boolean(t._core?.coreService?.decPrivateModes?.synchronizedOutput),
          };
        }"""
    )


def write_and_paint(page, data):
    page.evaluate(
        """data => new Promise(resolve => {
          const t = document.querySelector('.terminal-tab.active').__omeetyTerm;
          t.write(data, () => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })""",
        data,
    )


def same_anchor(left, right, tolerance=0.6):
    return (
        abs(left['composition']['left'] - right['composition']['left']) <= tolerance
        and abs(left['composition']['top'] - right['composition']['top']) <= tolerance
        and abs(left['textarea']['left'] - right['textarea']['left']) <= tolerance
        and abs(left['textarea']['top'] - right['textarea']['top']) <= tolerance
    )


def main():
    PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix='ime-composition-', dir=PROFILE_ROOT))
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
                page.evaluate(
                    """() => {
                      const host = document.querySelector('.terminal-tab.active');
                      host.__omeetyImeData = [];
                      host.__omeetyTerm.onData(data => host.__omeetyImeData.push(data));
                      host.__omeetyTerm.focus();
                    }"""
                )

                cdp = context.new_cdp_session(page)
                cdp.send('Input.imeSetComposition', {
                    'text': 'zhongwen',
                    'selectionStart': 8,
                    'selectionEnd': 8,
                })
                page.wait_for_timeout(60)
                baseline = ime_state(page)
                assert baseline['active'], baseline
                assert baseline['imeAnchor'] == 'committed-cursor', baseline

                fragments = [
                    '\x1b[?2026h',
                    '\x1b[5;1H• Working (4s • esc to interrupt)',
                    '\x1b[7;1H› temporary prompt row end',
                    '\x1b[9;1Htemporary status row end',
                ]
                composition_text = ['zhongwe', 'zhongw', 'zhong', 'zhon']
                intermediate = []
                for fragment, text in zip(fragments, composition_text):
                    write_and_paint(page, fragment)
                    cdp.send('Input.imeSetComposition', {
                        'text': text,
                        'selectionStart': len(text),
                        'selectionEnd': len(text),
                    })
                    page.wait_for_timeout(35)
                    intermediate.append(ime_state(page))

                assert all(state['active'] for state in intermediate), intermediate
                assert all(state['synchronized'] for state in intermediate), intermediate
                assert all(same_anchor(baseline, state) for state in intermediate), intermediate
                assert all(state['rendered'] == baseline['rendered'] for state in intermediate), intermediate

                write_and_paint(page, '\x1b[?2026l')
                page.wait_for_timeout(250)
                final_position = ime_state(page)
                assert not final_position['synchronized'], final_position
                assert final_position['rendered'] == final_position['buffer'], final_position

                # Commit normal Chinese text through Chromium's real IME protocol.
                cdp.send('Input.insertText', {'text': '中文'})
                page.wait_for_timeout(120)
                data_after_chinese = page.evaluate(
                    "() => document.querySelector('.terminal-tab.active').__omeetyImeData.join('')"
                )
                assert '中文' in data_after_chinese, data_after_chinese

                # The physical Shift+Quote path must remain unmodified.
                page.keyboard.press('Shift+Quote')
                page.wait_for_timeout(80)
                data_after_quote = page.evaluate(
                    "() => document.querySelector('.terminal-tab.active').__omeetyImeData.join('')"
                )
                assert '"' in data_after_quote, data_after_quote

                # Chinese paired quotation marks committed by the IME must pass through verbatim.
                for mark in ('“', '”'):
                    cdp.send('Input.imeSetComposition', {
                        'text': mark,
                        'selectionStart': 1,
                        'selectionEnd': 1,
                    })
                    cdp.send('Input.insertText', {'text': mark})
                    page.wait_for_timeout(80)
                all_data = page.evaluate(
                    "() => document.querySelector('.terminal-tab.active').__omeetyImeData.join('')"
                )
                assert '“' in all_data and '”' in all_data, all_data
                assert not errors, errors

                result = {
                    'baselineAnchor': {
                        'left': round(baseline['composition']['left'], 1),
                        'top': round(baseline['composition']['top'], 1),
                    },
                    'intermediateAnchorsStable': True,
                    'intermediateBufferPositions': [state['buffer'] for state in intermediate],
                    'renderedDuringComposition': baseline['rendered'],
                    'finalRendered': final_position['rendered'],
                    'forwardedData': all_data,
                    'pageErrors': errors,
                }
                print('IME_COMPOSITION=' + json.dumps(result, ensure_ascii=False))
            finally:
                context.close()
    finally:
        resolved = profile.resolve()
        if PROFILE_ROOT.resolve() in resolved.parents:
            shutil.rmtree(resolved, ignore_errors=True)


if __name__ == '__main__':
    main()
