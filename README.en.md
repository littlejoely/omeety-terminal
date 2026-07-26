# Omeety Terminal

[简体中文](README.md) | **English**

[![Release](https://img.shields.io/github/v/release/littlejoely/omeety-terminal?display_name=tag&style=flat-square)](https://github.com/littlejoely/omeety-terminal/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-7dd3fc?style=flat-square)](LICENSE)
[![Platform: Windows/macOS](https://img.shields.io/badge/platform-Windows_%7C_macOS-8aa4ff?style=flat-square)](#known-limitations-and-security)
[![MCP tools: 29](https://img.shields.io/badge/MCP_tools-29-5ee7b1?style=flat-square)](#browser-tools-29)

**Omeety Terminal is a browser exoskeleton for CLI agents: a real local
terminal in the Edge/Chrome side panel that gives Codex, Claude Code, Kimi Code,
and any MCP-capable CLI the same eyes and hands for your active web page.**

[3-minute quick start](#3-minute-quick-start) · [Why Omeety](#why-omeety) ·
[How it works](#how-it-works) · [29 browser tools](#browser-tools-29) ·
[Security](#known-limitations-and-security) · [Contributing](CONTRIBUTING.md)

![Omeety inspecting and operating the active tab through the real MCP path](docs/images/omeety-demo.gif)

> This reproducible demo uses a deterministic local MCP client and the real
> extension, Native Messaging, ConPTY, and browser-tool path. Codex, Claude Code,
> and Kimi Code use the same browser tools. No model account or prerecorded model
> response is involved.

There is no dedicated chat mode or model switch. Omeety remains a real shell:
run `git`, `npm`, `claude`, `codex`, `kimi`, or any local command as usual. The
difference is that agents inside it automatically gain reliable perception and
control of the browser tab you are already using.

This is an independently developed Windows/macOS beta. It is not an official product
of OpenAI, Anthropic, Moonshot AI, Microsoft, or xterm.js.

## Why Omeety

| Capability | Omeety Terminal | Typical standalone Browser MCP | Integrated desktop agent |
|---|:---:|:---:|:---:|
| Operates the browser tab you are already using and logged into | ✅ | Varies | Varies |
| Real local PTY and ordinary shell | ✅ | — | Usually no |
| One browser layer for Codex, Claude Code, and Kimi Code | ✅ | Partial | Usually vendor-bound |
| Agent- and model-neutral MCP contract | ✅ | ✅ | Usually no |
| Element picker, screenshots, Console, and trusted CDP input | ✅ | Varies | Varies |
| Local bridge; MCP binds only to `127.0.0.1` | ✅ | Varies | Varies |
| Confirmation boundary for submit/delete/save actions | ✅ | Varies | Varies |

## 3-minute quick start

The current release is verified on **Windows 11 with Microsoft Edge** and
**macOS with Google Chrome**. Install Node.js LTS and at least one CLI you plan
to use: `codex`, `claude`, or `kimi`.

macOS:

```bash
git clone https://github.com/littlejoely/omeety-terminal.git
cd omeety-terminal
./installer/install.sh
```

Windows:

```powershell
git clone https://github.com/littlejoely/omeety-terminal.git
cd omeety-terminal
powershell -ExecutionPolicy Bypass -File installer\install.ps1
```

Then:

1. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select the repository's `extension` directory.
3. Open Omeety from the toolbar and run `codex`, `claude`, or `kimi` in the real terminal.
4. Ask the agent to **“describe the current page”**, or click **Pick**, select
   multiple elements, then press Enter/click **Finish picking**. Omeety inserts
   the context into the current agent input line.

Continue below for the full installation model, configuration locations, and
uninstall steps, or download the [latest Release](https://github.com/littlejoely/omeety-terminal/releases/latest).

## Product role: a browser exoskeleton for agents

Think of the LLM as the operator and CLI agents such as Codex, Claude Code,
and Kimi Code as specialized suits. **Omeety is the browser exoskeleton around
those agents.** It does not replace the agent inside; it gives any model-agent
combination the same browser eyes, hands, and real-terminal channel.

Another useful description is **a browser-track telemetry and control system
that works with different cars and drivers**. Omeety is not tied to GPT,
Claude, GLM, Kimi, or a particular CLI. Any MCP-capable agent should be able to
reuse the same browser capabilities without an Omeety-specific model build.

That role establishes these development principles:

- **Agent-neutral:** use open protocols and stable tool contracts instead of
  locking browser capabilities to one model or CLI.
- **Keep the terminal pure:** the core remains a real PTY plus xterm.js, not a
  second chat agent, file explorer, or full IDE in the side panel.
- **Strengthen the eyes and hands:** prioritize reliable page perception,
  element targeting, trusted input, cross-navigation actions, screenshots, and
  context handoff.
- **Local-first with visible authority:** the terminal has local-user
  permissions; browser control is bridged locally and dangerous actions retain
  confirmation boundaries.
- **Progressive enhancement:** an agent can work entirely through MCP without
  knowing Omeety's UI; advanced capabilities stay optional and preserve the
  normal shell experience.

### Directions for clones and forks

Extensions should reinforce the exoskeleton instead of turning the core into
another closed agent:

1. Improve PTY, keyboard, IME, rendering, and session recovery until behavior
   approaches a native system terminal.
2. Expand browser telemetry (DOM, Console, Network, screenshots) and reliable,
   auditable browser actions.
3. Package selected elements, page fragments, and images into a standard
   Context Bundle that different CLI agents can consume.
4. Add thin adapters for more MCP agents, browsers, and operating systems while
   preserving one core tool contract.
5. Add permission groups, read-only mode, and domain boundaries as optional
   safety layers rather than model-specific policy.

The immediate priorities are **reliability and measurable performance**:
terminal I/O and browser tools must report real outcomes, survive navigation,
and retain their resource/throughput baseline. Continuous selection now has
stable references and terminal context injection; a standard Context Bundle is
the next step.

## How it works

```text
Side-panel extension [ xterm.js terminal ]  <- Native Messaging ->  local Node host
                                                                  |- PTY: real shell I/O
                                                                  `- MCP Streamable HTTP
                                                                     http://127.0.0.1:49171/mcp
                                                                            ^
                                                       claude / codex / kimi connect here
                                                       tool calls -> content.js -> active tab
```

- The browser starts the host when the terminal panel first opens. An offscreen
  keepalive then keeps the host and PTYs running while the side panel is closed.
- Reopening the panel reuses the sessions and replays a limited recent-output
  buffer. Exiting the browser, reloading the extension, or a host failure ends
  the sessions.
- One local process handles terminal I/O, the PTY, and the MCP server.

## Prerequisite: a local Native Messaging host

A browser extension cannot start local programs by itself. Omeety Terminal
therefore uses a one-time Native Messaging host installation. It does not need
a separate always-on service, token, or handshake.

Install **Node.js (LTS recommended)** first. The installer configures browser
tools for any detected Claude Code, Codex CLI, and Kimi Code installations.

## Full installation details

### macOS (Chrome)

```bash
# Run from the repository root in macOS Terminal or iTerm
./installer/install.sh
```

If macOS asks whether `node` may use developer tools, choose **Allow**. Denying
the request prevents the native `node-pty` module from loading; it can be
enabled again under **System Settings → Privacy & Security → Developer Tools**.

### Windows (Edge / Chrome)

```powershell
# From the repository root
powershell -ExecutionPolicy Bypass -File installer\install.ps1
```

The installer:

1. Installs host dependencies (`node-pty`, the MCP SDK, and Express).
2. Generates `host/host-manifest.json`. Windows registers it under HKCU;
   macOS installs it in each detected browser's user-level
   `NativeMessagingHosts` directory. Neither path needs administrator access.
3. Adds `http://127.0.0.1:49171/mcp` to the Claude Code, Codex CLI, and Kimi
   Code configurations, creating timestamped backups first.

The public key in `manifest.json` fixes the extension ID as
`fjhjkmpldbepgcpfkhpolnnheccjaamg`, keeping Native Messaging
`allowed_origins` stable across reloads and machines.

Then load the extension:

1. Open `chrome://extensions` or `edge://extensions` and enable **Developer
   mode**.
2. Choose **Load unpacked** and select the repository's `extension` directory.
3. Confirm that the extension ID is
   `fjhjkmpldbepgcpfkhpolnnheccjaamg`.

## Use

1. Click the extension icon to open the side panel. On first use, acknowledge
   that a real terminal has full local user permissions.
2. At the system shell prompt (PowerShell on Windows, zsh on macOS), run
   `claude`, `codex`, or `kimi`.
3. Inside an agent, verify that `omeety_terminal` and its 29 `omeety_*` tools
   are connected, then ask the agent to describe or operate the active page.
4. Use the settings button to select the system shell, zsh/bash/fish,
   PowerShell/cmd/Git Bash, or a custom shell executable.

## Terminal shortcuts and features

- **Ctrl+F** searches terminal output; Enter finds the next match,
  Shift+Enter the previous match, and Esc closes search.
- **Ctrl+click** opens a terminal URL in a browser tab.
- Selecting text copies it; **Ctrl+V** and right-click paste with bracketed
  paste support.
- **Ctrl+wheel**, **Ctrl+=**, **Ctrl+-**, and **Ctrl+0** adjust or reset the
  persistent font size.
- **Ctrl+Alt+T** opens a terminal tab, **Ctrl+Alt+W** closes the active tab, and
  **Ctrl+Alt+Left/Right** changes tabs.
- Click a tab to switch, middle-click to close, or right-click to rename it.
  Shell window titles automatically become tab titles.
- OSC 52 lets programs such as Claude Code, tmux, and Vim write to the system
  clipboard.
- **Continuous picking:** click Pick, select several page elements (click one
  again to remove it), then press Enter or Finish picking. Stable `pick-1..N`
  references and a compact summary are inserted without an Enter keystroke.

## Browser tools (29)

**Inspect and retrieve:** `omeety_get_page_snapshot`,
`omeety_get_selected_context`, `omeety_capture_visible_tab`,
`omeety_fetch_with_cookie`, `omeety_get_user_pick`,
`omeety_get_user_picks`, `omeety_list_tabs`, and
`omeety_get_console_logs`.

**Operate:** `omeety_click`, `omeety_click_text`, `omeety_click_at`,
`omeety_fill`, `omeety_type_text`, `omeety_press_key`, `omeety_select`,
`omeety_scroll`, `omeety_hover`, `omeety_upload_file`, `omeety_open_tab`,
`omeety_switch_tab`, `omeety_navigate`, `omeety_reload`, `omeety_go_back`,
`omeety_close_tab`, `omeety_wait_for` (navigation-resilient),
`omeety_execute_js` (CDP-based for strict-CSP pages),
`omeety_apply_preview_patch`, `omeety_rollback_preview_patch`, and
`omeety_request_user_confirmation`.

Actions that submit, save, delete, agree, or send non-GET requests require an
in-page confirmation. For rich-text editors that ignore synthetic events, set
`cdp: true` on `click_at`, `fill`, `type_text`, or `press_key` to use trusted
browser input.

## Troubleshooting

| Symptom | Resolution |
|---|---|
| Terminal status remains disconnected | Run the platform installer (`install.sh` on macOS, `install.ps1` on Windows), confirm the extension ID matches `allowed_origins`, and verify Node.js is installed. |
| `omeety_terminal` is missing from `/mcp` | Run the installer again. For Codex, you can also run `codex mcp add omeety_terminal --url http://127.0.0.1:49171/mcp`. |
| Codex or Kimi cannot connect to MCP | Confirm the URL is `http://127.0.0.1:49171/mcp` and inspect `~/.codex/config.toml` or `~/.kimi-code/config.toml`. |
| The shell cannot find Claude, Codex, or Kimi | The host inherits PATH from the browser. Add the CLI directory to the system PATH and restart the browser, or use the full executable path. |
| A small amount of old output is missing after reopening the panel | The session is still running, but Omeety only replays the most recent 64 KB. Continue typing; applications should persist any complete history they require. |
| A browser debugging banner appears after `execute_js` | The tool uses CDP to work on strict-CSP pages. This is Chromium's visible notice for the `debugger` permission and does not affect ordinary terminal use. |

## Uninstall

macOS:

```bash
./installer/uninstall.sh
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File installer\uninstall.ps1
```

This removes the Native Messaging registration and the `omeety_terminal`
blocks from agent configurations while preserving backups. Remove the unpacked
extension from the browser's extension management page afterward.

## Project layout

```text
extension/    MV3 extension: terminal, Native Messaging port, and content tools
host/         Native Messaging host: PTY + Streamable HTTP MCP + legacy SSE
installer/    Windows PowerShell and macOS zsh install/uninstall scripts
shared/       Protocol documentation
tools/        gen-key.js for a fixed extension key and ID
_test/        Browser-free mock-native smoke tests
_pwtest/      Headed Edge regression probes safe for public reproduction
```

## Known limitations and security

- **A real terminal has full local user permissions.** The MCP server binds only
  to `127.0.0.1`; dangerous browser actions still require in-page confirmation.
- An offscreen document attempts to keep the host and PTYs alive after the side
  panel closes, with only the most recent 64 KB of output buffered. Exiting the
  browser, reloading the extension, a Native Messaging host crash, or OS
  reclamation still ends the sessions.
- Windows ConPTY and macOS Chrome with a zsh PTY have been verified. Linux has
  not yet completed a headed-browser regression pass.
- Safari is not currently supported. It lacks the Chromium combination of
  `sidePanel`, `offscreen`, and `chrome.debugger`/CDP, and its Native Messaging
  bridge must go through a containing macOS app. A Safari port therefore needs
  a separate container app and browser adapter instead of loading this folder directly.
- Codex cursor and Chinese IME compatibility in browser side-panel terminals is
  tracked in [openai/codex#35438](https://github.com/openai/codex/issues/35438).
- Except for reviewed public images under `docs/images`, local private keys,
  browser profiles, logs, diagnostic screenshots, and installer-generated files
  are not committed. See [`SECURITY.md`](SECURITY.md).

## License

Omeety Terminal is released under the [MIT License](LICENSE). Third-party
components retain their respective copyrights and licenses; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

If Omeety saves you a browser/tool-switching step, consider starring the
repository. Bug reports and focused pull requests are welcome; see
[`CONTRIBUTING.md`](CONTRIBUTING.md).
