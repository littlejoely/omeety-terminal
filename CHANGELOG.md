# Changelog / 更新日志

All notable public changes to Omeety Terminal are recorded here.

Omeety Terminal 的重要公开变更记录在此处。

## [Unreleased]

## [0.2.0] - 2026-07-30

Browser Core v2, durable browser actions, and cross-frame reliability / Browser Core v2、可靠浏览器操作与跨 Frame 能力。

### Added / 新增

- Add Browser Core v2 in the existing Native Host: a tab/Target/Frame registry,
  policy engine, high-level tool mapping, runtime metrics, and redacted rotating audit.
- Add seven compatible `omeety_browser_*` high-level tools for observe, query,
  action, transaction, wait, tab management, and status; all 31 existing browser
  tools remain available.
- Add an extension Browser Adapter that recursively auto-attaches CDP targets and
  merges DOMSnapshot, Accessibility, and frame topology across out-of-process iframes.
- Recover stale element UIDs with composite role/label/text/attribute/parent/geometry
  locators, bounded retry, ambiguity rejection, and recovery metrics.
- Add side-panel read/act/submit permission modes, plus
  Browser Core health and target status through MCP.
- Add deterministic Host tests and a real Chromium/OOPIF regression. The controlled
  rerender fixture improves stale-reference hits from 0/100 to 100/100; see
  `docs/browser-core-v2.md` for the complete before/after report.
- Add durable action completion levels (`dispatched`, `applied`, `committed`),
  optional post-reload verification, modifier-key chords, and inactive-tab CDP capture.

### Fixed / 修复

- Promote matched text leaves to likely clickable parent cards and use compact
  query/snapshot payloads, improving SPA contact/menu accuracy while reducing transfer work.
- Gate navigation and reload postconditions on a new document epoch so text left in
  the old document cannot produce a false success.

- Let browser tools pin an explicit `tabId`, so a user's mid-task tab switch no
  longer redirects a pending action or wait to the wrong page.
- Extend `omeety_act_and_verify` with 1-20 step transactions. Click, trusted
  input, navigation, reload, wait, and JavaScript assertions can now run in one
  MCP round trip with fail-fast semantics and per-step results.
- Verify editor clearing instead of treating one Backspace as success. Omeety
  now establishes a DOM selection, dispatches trusted deletion, reads the active
  editor back, and safely falls back to bounded per-character Backspace.
- Count timeouts, failed postconditions, and incomplete transactions as semantic
  failures in runtime reliability metrics.
- Make trusted CDP editing reliable in Canvas and controlled grids: printable
  ASCII/numeric input now uses correct `KeyA`/`Digit1` key codes and full
  keydown/char/keyup sequences, transient editors can retain focus with
  `refocus:false`, and `commitKey` can finish an edit atomically.
- Use Cmd+A when clearing an editor on macOS and Ctrl+A on other platforms;
  `clickCount` now supports double-click entry into grid editors.

## [0.1.2] - 2026-07-26

Browser intelligence, terminal session, and resource lifecycle / 浏览器智能、终端会话与资源生命周期优化。

### Added / 新增

- Add Context Bundle v1 with target semantics, nearby controls, iframe/Shadow
  DOM context, diagnostics, and a cropped screenshot returned as MCP image content.
- Add `omeety_act_and_verify` for action + navigation-resilient postcondition transactions.
- Add incremental light snapshots and `omeety_get_runtime_metrics` latency/reliability reporting.
- Three MCP-first persistent download tools (`start`, `status`, and `cancel`)
  backed by one Native Host download core, with explicit side-panel approval,
  direct/proxy probing, ranged concurrency, retry/resume, optional SHA-256
  verification, atomic publishing, and a thin `omeety download` CLI wrapper.
- Continuous multi-element picking with stable `pick-1..N` references,
  `omeety_get_user_picks`, and safe no-Enter context injection into the active
  terminal/Agent input line.
- Add a real Edge/Native Messaging/ConPTY/WebGL performance baseline covering
  idle main-thread cost, output throughput, heap/DOM size, and terminal-tab cleanup.
- Restore every live terminal tab from the Native Host after reopening the side panel.
- Add configurable per-tab scrollback: 3,000 / 5,000 / 10,000 / 20,000 lines.
- Add side-panel close policies: keep indefinitely, reclaim after 30 idle
  minutes, or end immediately.
- Add a supported `npm test` entry with a 30-second hard timeout and guaranteed
  Host/PTY cleanup.

### Changed / 优化

- Keep WebGL only on the active terminal tab; inactive tabs continue running
  while releasing their GPU renderer.
- Change the default per-tab scrollback from 10,000 to 5,000 lines.
- Rotate Host diagnostics as three capped 20 MB files and omit heartbeat and
  high-frequency dynamic-title metadata traffic.
- Reconnect the offscreen keepalive port after every service-worker restart,
  including repeated disconnects.
- Traverse open Shadow DOM and same-origin iframes when collecting visible text,
  controls, UIDs, and compound wait conditions.
- Replace replay-buffer `Array.shift()` eviction with an amortized O(1) bounded queue.
- Limit picker hit-testing and layout reads to once per animation frame and
  remove lagging highlight-position transitions.

### Fixed / 修复

- Prevent hidden PTYs from becoming unreachable after a multi-tab side panel is closed and reopened.
- Clean up PTYs on Host signals and test interruption/timeout.
- Avoid treating shutdown of an already-exited tab as a request to terminate the entire Host.
- Deliver Cmd+V, Ctrl+V, Shift+Insert, and right-click through xterm's canonical
  paste path so Codex can collapse long pasted content instead of rendering it inline.
- Prevent a browser-launcher `NO_COLOR` value from leaking into PTYs; advertise
  xterm-256color/truecolor and Omeety as the terminal so Codex keeps its color UI.
- Commit the final WebGL cursor model and IME textarea anchor when an xterm
  synchronized-output transaction ends; the buffer no longer advances while
  the rendered cursor remains at its pre-transaction position.

## [0.1.1] - 2026-07-26

macOS Chrome support / macOS Chrome 支持。

### Added / 新增

- Verified macOS support in Google Chrome with a real zsh PTY.
- Added macOS install and uninstall scripts that register Native Messaging for
  Chrome, Edge, or Chromium and configure Codex CLI, Claude Code, and Kimi Code.
- Added automatic shell selection plus zsh, bash, fish, and custom executable
  choices on macOS.
- Added macOS PATH discovery for Homebrew, local user tools, Cargo, and Kimi.
- Added macOS Developer Tools permission guidance for the native `node-pty`
  module.

### Fixed / 修复

- Repair the executable bit of `node-pty`'s macOS `spawn-helper` after npm
  installation when required.
- Preserve existing LF or CRLF line endings when writing Agent TOML configs.
- Use the user's home directory as the PTY working directory on macOS.
- Avoid manifest references to icon files that are not present in the public
  repository.

### Compatibility / 兼容性

- Verified on Windows 11 + Microsoft Edge and macOS + Google Chrome.
- Safari is not included in this release because it requires a separate macOS
  container app and browser adapter.

## [0.1.0] - 2026-07-26

First public beta / 首个公开测试版。

### Highlights / 主要能力

- Real Windows ConPTY terminal in the Edge/Chrome side panel.
- Agent-neutral browser-control MCP server with 28 tools.
- Automatic MCP configuration for Codex CLI, Claude Code, and Kimi Code.
- Multiple terminal tabs, session keepalive, recent-output replay, search,
  OSC 52 clipboard, link opening, font scaling, and configurable shells.
- Page snapshots with stable element UIDs, element picker, screenshots,
  Console/exception capture, navigation-resilient waits, CDP input, file
  upload, reversible preview patches, and confirmation gates for dangerous
  browser actions.
- Streamable HTTP at `/mcp`, with legacy SSE compatibility at `/sse`.
- Bilingual documentation, reproducible demo, MIT license, security policy,
  and headed Edge regression probes.

### Fixes / 修复

- Guard xterm's WebGL cursor during synchronized output redraws.
- Preserve modified-Enter and IME composition behavior through terminal input.
- Keep Native Messaging, PTYs, and limited output replay alive while the side
  panel is closed.
- Make Settings shell changes use an atomic PTY restart instead of disconnecting
  the panel communication port.
- Restore the Settings toggle from `×` to `⚙` after saving or leaving Settings.
- Preserve custom shell executable paths after the panel reloads.
- Report shell spawn failures as failures instead of also emitting a false
  “connected” state.

### Known limitations / 已知限制

- Verified on Windows 11 with Microsoft Edge; Chrome is supported by the
  installer but has less real-world coverage.
- macOS and Linux need a platform shell-selection adapter.
- Codex cursor and Chinese IME punctuation compatibility in browser-hosted
  terminals is tracked in [openai/codex#35438](https://github.com/openai/codex/issues/35438).

[0.1.1]: https://github.com/littlejoely/omeety-terminal/releases/tag/v0.1.1
[0.1.0]: https://github.com/littlejoely/omeety-terminal/releases/tag/v0.1.0
[0.1.2]: https://github.com/littlejoely/omeety-terminal/releases/tag/v0.1.2
[0.2.0]: https://github.com/littlejoely/omeety-terminal/releases/tag/v0.2.0
