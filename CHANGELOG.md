# Changelog / 更新日志

All notable public changes to Omeety Terminal are recorded here.

Omeety Terminal 的重要公开变更记录在此处。

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

[0.1.0]: https://github.com/littlejoely/omeety-terminal/releases/tag/v0.1.0
