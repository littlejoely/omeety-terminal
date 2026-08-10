# Changelog / 更新日志

All notable public changes to Omeety Terminal are recorded here.

Omeety Terminal 的重要公开变更记录在此处。

## [Unreleased]

### Added / 新增

- `omeety_hover` now auto-detects menus/tooltips that appear on hover: after dispatching hover events it waits ~220ms, diffs interactive elements before/after, and returns the newly-revealed items with center coordinates, so the agent can click them directly without an extra `get_page_snapshot`.
- `omeety_navigate` accepts an optional `waitUntil: "load"`: when set, it polls `chrome.tabs.status` until `complete` (browser-native load detection, no CDP attach needed), so the agent can navigate and continue without a separate `wait_for`.
- `omeety_hover` 自动探测 hover 才出现的菜单/提示：发完 hover 事件后等待约 220ms，对比前后可交互元素，把新浮现的项（带中心坐标）直接返回，agent 无需再额外 `get_page_snapshot`。
- `omeety_navigate` 新增可选 `waitUntil: "load"`：传入则轮询 `chrome.tabs.status` 至 `complete`（浏览器原生 load 判定，无需 attach CDP），agent 导航后可直接继续，省一次 `wait_for`。

### Performance / 性能

- Snapshot element collection (`forms`/`buttons`/`inputs`/`links`/`tables`) now batches all selectors into a single shadow/iframe root traversal (`queryAllDeepBatch`), replacing five separate `querySelectorAll("*")` full-document walks — fewer repeated scans on shadow-DOM-heavy pages (Feishu/POM).
- `sinceSnapshotId` digest now covers only stable fields (url + interactive uid/role/text), excluding scroll/selection/visibleText. Previously the digest changed on every scroll so the `unchanged` fast path never hit; now it actually returns `unchanged` when the page hasn't changed, saving a full snapshot round-trip.
- 快照元素采集（`forms`/`buttons`/`inputs`/`links`/`tables`）改为一次遍历 shadow/iframe 根批量查询（`queryAllDeepBatch`），替代原先五次各自 `querySelectorAll("*")` —— 在飞书/POM 这类 shadow DOM 重的页面减少重复全文档扫描。
- `sinceSnapshotId` 摘要改为只覆盖稳定字段（url + interactive 的 uid/role/text），排除 scroll/selection/visibleText。此前摘要随滚动就变，`unchanged` 快路径永不命中；现在页面没变时真能返回 `unchanged`，省一整次快照往返。

### Fixed / 修复

- Switch terminal tabs only after the target renderer and scrollbar metrics have
  settled off-screen, preventing the terminal content from briefly filling the panel
  and then shrinking a few pixels.
- 切换终端 Tab 时，先在后台完成目标终端的渲染器恢复与滚动条尺寸计算，再一次性显示，
  避免终端内容先铺满侧栏、随后横向收缩几个像素。
- Reject stale UID actions before dispatch when the remembered tab, document
  epoch, origin, or document ID no longer matches the current page.
- Verify normalized `contenteditable` text, expose icon-only SVG semantics, and
  support target-level selected/class/text postconditions for SPA workflows.
- 在派发动作前校验旧 UID 的标签页、文档代次、origin 与 document ID，阻止跨页面误点击。
- 修复 `contenteditable` 验证假失败，补充纯图标控件语义与 SPA 目标级状态校验。
- Keep the visible terminal cursor on the real input column while narrow Agent TUI
  layouts (including Codex and Claude Code) redraw elapsed time, token usage, the composer, and status animations;
  vertical composer movement stays responsive and typed input retains its fast path.
- 修复窄侧栏中 Agent 重绘运行时间、Token、输入框和状态动画时，终端光标在多行之间
  来回跳动的问题；输入框纵向移动仍保持顺滑，用户键入继续走低延迟通道。

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
- Make the macOS offline installer reuse bundled dependencies and clear the
  browser quarantine attribute from bundled `node-pty` binaries before launch.
- Preserve terminal sessions when browser background scheduling or system sleep
  delays extension heartbeats; Native Messaging EOF/error now owns disconnect
  detection, while ping/pong reports health without terminating live PTYs.

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
