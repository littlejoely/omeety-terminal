# Headed browser regression probes

These regression probes use isolated Microsoft Edge or Chromium profiles and
exercise the extension, Native Messaging, Windows ConPTY, and macOS terminal
paths as appropriate. Most probes require Python + Playwright; the Browser Core
v2 probe is a Node `.mjs` script. Install the host first, then follow the
requirements of the individual script.

- `test_cursor_sync_rows.py` simulates Codex synchronized-output frames.
- `test_cursor_active_codex.py` samples the cursor while a real Codex command is
  actively producing output. Set `OMEETY_TEST_VPN_COMMAND` only if Codex needs a
  proxy command in the test shell.
- `test_ime_composition.py` checks the xterm textarea and IME composition anchor.
- `test_settings_reconnect.py` switches shells through Settings and verifies the
  atomic PTY restart, the restored settings icon, and custom-shell persistence.
- `test_tab_render_budget.py` is a headless six-tab regression that verifies
  inactive terminals release WebGL and rapid switching keeps exactly one GPU renderer.
- `test_tab_width_stability.py` verifies a tab becomes visible only after its renderer
  and scrollbar metrics settle, so terminal content does not shrink after switching.
- `test_paste_protocol.py` is a headless macOS/terminal paste regression that verifies
  Cmd+V and right-click deliver long content once as one bracketed-paste event.
- `test_context_bundle.py` verifies Context Bundle v1, real Shadow DOM and
  same-origin iframe discovery, incremental snapshots, and compound postconditions.
- `test_performance_baseline.py` records idle main-thread cost, real PTY output
  throughput, JS heap/DOM size, and xterm/WebGL cleanup after terminal-tab churn.
- `test_multi_pick.py` continuously selects multiple real page elements, proves
  their clicks are intercepted, and verifies context injection into the PTY.
- `test_cursor_probe.py` contains shared setup and cursor-state inspection.
- `test_browser_tool_reliability.py` uses a temporary profile and local strict-CSP
  pages to verify CDP `execute_js` and click/wait recovery across navigation. It
  uses a test-only MCP port and does not touch the normal Edge profile.
- `test_browser_core_v2.mjs` uses a temporary Playwright Chromium profile and
  local main/cross-origin pages to verify composite-locator recovery, incremental
  snapshots, recursive OOPIF DOMSnapshot/Accessibility observation, and the
  420px side-panel permission/status layout. It does not read a personal profile.
- `capture_launch_assets.py` records the public README GIF and social preview
  through the real extension/Native Messaging/ConPTY/MCP path. Its deterministic
  demo client is `launch_demo_agent.mjs`; no model account or network is needed.

Persistent browser profiles, screenshots, and logs produced by these probes are
intentionally ignored because they may contain account or page data.
