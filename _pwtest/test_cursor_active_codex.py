import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from test_cursor_probe import EXT, EXT_ID, PROFILE_ROOT


os.environ['OMEETY_MCP_PORT'] = '49473'
TEST_AGENT = os.environ.get('OMEETY_TEST_AGENT', 'codex').strip().lower()
TEST_SHELL = os.environ.get('OMEETY_TEST_SHELL', 'powershell').strip().lower()
if TEST_AGENT not in {'codex', 'claude'}:
    raise ValueError(f'unsupported OMEETY_TEST_AGENT={TEST_AGENT!r}')
if TEST_SHELL not in {'powershell', 'cmd'}:
    raise ValueError(f'unsupported OMEETY_TEST_SHELL={TEST_SHELL!r}')


def buffer_text(page):
    return page.evaluate(
        """() => {
          const t = document.querySelector('.terminal-tab.active').__omeetyTerm;
          const b = t.buffer.active;
          // A fresh 47-row terminal writes its prompt near row 0. Reading only
          // the last 40 rows silently drops that output and makes a live PTY
          // look blank before any scrollback exists.
          const first = Math.max(0, b.length - 100);
          const out = [];
          for (let i = first; i < b.length; i++) {
            out.push(b.getLine(i)?.translateToString(true) || '');
          }
          return out.join('\\n');
        }"""
    )


def wait_for_working(page, timeout=45):
    end = time.time() + timeout
    last = ''
    while time.time() < end:
        last = buffer_text(page)
        if 'esc to interrupt' in last or ('Bash(' in last and 'ACTIVE_CURSOR_TICK' in last):
            return last
        try:
            page.wait_for_timeout(100)
        except Exception as error:
            raise AssertionError(f'page closed while waiting for Working; tail={last!r}') from error
    raise AssertionError(f'{TEST_AGENT} never entered active state; tail={last!r}')


def wait_for_text(page, markers, timeout=30):
    end = time.time() + timeout
    last = ''
    while time.time() < end:
        last = buffer_text(page)
        if any(marker in last for marker in markers):
            return last
        page.wait_for_timeout(100)
    raise AssertionError(f'timed out waiting for {markers!r}; tail={last!r}')


def wait_for_text_count(page, marker, count=2, timeout=30):
    end = time.time() + timeout
    last = ''
    while time.time() < end:
        last = buffer_text(page)
        if last.count(marker) >= count:
            return last
        page.wait_for_timeout(100)
    raise AssertionError(
        f'timed out waiting for {count} occurrences of {marker!r}; tail={last!r}'
    )


def main():
    PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix='cursor-active-codex-', dir=PROFILE_ROOT))
    # Keep the command short enough that its marker is not split differently by
    # narrow and wide terminal geometries.
    run_root = Path(r'C:\tmp')
    run_root.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix='omeety-cursor-codex-', dir=run_root))
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                str(profile),
                channel='msedge',
                headless=False,
                # Match the real Edge side-panel geometry from the regression report.
                # Narrow wrapping changes Codex's row layout and cursor transactions.
                viewport={'width': 387, 'height': 952},
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
                page.on('crash', lambda: print('PAGE_EVENT=crash', flush=True))
                page.on('close', lambda: print('PAGE_EVENT=close', flush=True))
                page.goto(
                    f'chrome-extension://{EXT_ID}/sidepanel.html',
                    wait_until='domcontentloaded',
                )
                try:
                    page.click('#ackBtn', timeout=3000)
                except Exception:
                    pass
                page.click('.terminal-tab.active')
                page.wait_for_function(
                    "() => document.getElementById('statusText').textContent.includes('已连接')",
                    timeout=15000,
                )
                # ConPTY may emit the initial PowerShell prompt before the freshly opened
                # side-panel listener receives its first output frame.  The end-to-end
                # modified-enter probe uses the reliable handshake: wait for PTY ready,
                # give it one paint turn, then type a command and wait for that command's
                # own marker instead of depending on the optional shell prompt.
                page.wait_for_timeout(2500)
                if TEST_SHELL == 'cmd':
                    page.click('#settingsToggle')
                    page.select_option('#shellSelect', 'cmd')
                    page.click('#saveBtn')
                    page.wait_for_timeout(2500)
                vpn_command = os.environ.get('OMEETY_TEST_VPN_COMMAND', '').strip()
                if vpn_command:
                    page.keyboard.type(
                        f'{vpn_command}; Write-Output OMEETY_VPN_READY',
                        delay=1,
                    )
                    page.keyboard.press('Enter')
                    vpn_stage = wait_for_text_count(
                        page, 'OMEETY_VPN_READY', count=2, timeout=30
                    )
                    print(
                        'VPN_STAGE=' + json.dumps(vpn_stage[-1200:], ensure_ascii=False),
                        flush=True,
                    )
                if TEST_SHELL == 'cmd':
                    workdir_command = f'cd /d "{run_dir}" && echo OMEETY_WORKDIR_READY'
                    workdir_prompt = f'{run_dir}>'
                else:
                    workdir_command = f"Set-Location -LiteralPath '{run_dir}'; Write-Output OMEETY_WORKDIR_READY"
                    workdir_prompt = f'PS {run_dir}>'
                page.keyboard.type(workdir_command, delay=1)
                page.keyboard.press('Enter')
                wait_for_text_count(page, 'OMEETY_WORKDIR_READY', count=1, timeout=10)
                workdir_stage = wait_for_text(page, [workdir_prompt], timeout=10)
                print(f'MATRIX={TEST_AGENT}+{TEST_SHELL} WORKDIR={run_dir}', flush=True)
                assert str(run_dir) in workdir_stage, workdir_stage

                task = (
                    'Run a PowerShell loop that prints ACTIVE_CURSOR_TICK once per second '
                    'for 18 seconds. Wait for the command to finish before replying.'
                )
                if TEST_AGENT == 'claude':
                    command = f'claude --dangerously-skip-permissions --no-chrome "{task}"'
                else:
                    command = (
                        'codex --no-alt-screen --disable apps -a never -s workspace-write '
                        '-c mcp_servers.omeety_terminal.enabled=false '
                        f'"{task}"'
                    )
                page.keyboard.type(command, delay=1)
                page.keyboard.press('Enter')
                startup = wait_for_text(
                    page,
                    ['Do you trust the contents of this directory?', 'Yes, I trust this folder', 'esc to interrupt'],
                    timeout=35,
                )
                if 'Do you trust the contents of this directory?' in startup or 'Yes, I trust this folder' in startup:
                    # The directory is a newly-created empty test sandbox. The first option
                    # (Yes, continue) is selected by default.
                    page.keyboard.press('Enter')
                wait_for_working(page, timeout=60)

                samples = page.evaluate(
                    """duration => new Promise((resolve) => {
                      const host = document.querySelector('.terminal-tab.active');
                      const t = host.__omeetyTerm;
                      const out = [];
                      const started = performance.now();
                      const frame = (now) => {
                        const core = t._core;
                        const renderer = core?._renderService?._renderer?.value;
                        const cursor = renderer?._model?.cursor;
                        const b = t.buffer.active;
                        const first = Math.max(0, b.length - 100);
                        const tail = [];
                        for (let i = first; i < b.length; i++) {
                          tail.push(b.getLine(i)?.translateToString(true) || '');
                        }
                        const text = tail.join('\\n');
                        out.push({
                          ms: Math.round(now - started),
                          rendered: cursor ? [cursor.x, cursor.y] : null,
                          buffer: [b.cursorX, b.cursorY],
                          pending: host.dataset.omeetyCursorPinned,
                          committed: host.dataset.omeetyCursorCommitted || null,
                          cursorHidden: Boolean(core?.coreService?.isCursorHidden),
                          synchronized: Boolean(core?.coreService?.decPrivateModes?.synchronizedOutput),
                          working: text.includes('esc to interrupt') ||
                            (text.includes('Bash(') && text.includes('ACTIVE_CURSOR_TICK')),
                        });
                        if (now - started < duration) requestAnimationFrame(frame);
                        else resolve(out);
                      };
                      requestAnimationFrame(frame);
                    })""",
                    8000,
                )

                # Sampling starts only after wait_for_working() succeeds and the probe
                # command runs for 18 seconds, so this entire 8-second interval is active
                # execution. The literal Working row may be redrawn/scroll out meanwhile.
                active = samples
                marker_frames = [sample for sample in samples if sample['working']]
                rendered = {
                    tuple(sample['rendered'])
                    for sample in active
                    if sample['rendered'] is not None
                }
                buffers = {tuple(sample['buffer']) for sample in active}
                committed = {sample['committed'] for sample in active if sample['committed']}
                changes = []
                previous = None
                for sample in active:
                    current = tuple(sample['rendered']) if sample['rendered'] else None
                    if current != previous:
                        changes.append({
                            'ms': sample['ms'],
                            'rendered': current,
                            'buffer': sample['buffer'],
                            'committed': sample['committed'],
                        })
                        previous = current

                summary = {
                    'totalFrames': len(samples),
                    'workingMarkerFrames': len(marker_frames),
                    'cursorHiddenFrames': sum(1 for sample in samples if sample['cursorHidden']),
                    'uniqueRenderedPositions': len(rendered),
                    'uniqueBufferPositions': len(buffers),
                    'uniqueCommittedPositions': len(committed),
                    'renderedChanges': changes[:20],
                    'rapidTransitions': [
                        changes[index]['ms'] - changes[index - 1]['ms']
                        for index in range(1, len(changes))
                        if changes[index]['ms'] - changes[index - 1]['ms'] < 500
                    ],
                    'pageErrors': errors,
                }
                print('ACTIVE_AGENT=' + json.dumps({'agent': TEST_AGENT, 'shell': TEST_SHELL, **summary}, ensure_ascii=False))
                assert len(active) >= 120, summary
                # Repeated command output legitimately pushes the empty composer down. The
                # regression is horizontal movement to temporary Working/status line ends;
                # throughout this probe the real empty-composer column is x=2.
                # Codex keeps a visible caret on the empty composer; Claude Code
                # intentionally hides it while a tool is active. If an Agent makes
                # the cursor visible, it must stay on the real input column.
                if rendered:
                    assert {position[0] for position in rendered} == {2}, summary
                assert len(summary['rapidTransitions']) <= 1, summary
                assert all(
                    change['committed'] == f"{change['rendered'][0]},{change['rendered'][1]}"
                    for change in changes
                ), summary
                assert not errors, summary

                page.keyboard.press('Control+c')
                page.wait_for_timeout(300)
                page.keyboard.press('Control+c')
            finally:
                context.close()
    finally:
        resolved = profile.resolve()
        if PROFILE_ROOT.resolve() in resolved.parents:
            shutil.rmtree(resolved, ignore_errors=True)
        resolved_run = run_dir.resolve()
        if run_root.resolve() in resolved_run.parents:
            shutil.rmtree(resolved_run, ignore_errors=True)


if __name__ == '__main__':
    main()
