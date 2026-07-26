# Omeety Terminal

[简体中文](README.md) | **English**

A **real terminal in the Edge/Chrome side panel**, preconfigured with a
**browser-control MCP server**. Run `claude`, `codex`, `kimi`, or any other
MCP-capable CLI inside it, and the agent can inspect and operate the web page
currently open in your browser.

This is an independently developed experimental project. It is not an official
product of OpenAI, Anthropic, Moonshot AI, Microsoft, or xterm.js.

![Omeety Terminal running in the Microsoft Edge side panel](docs/images/omeety-terminal.png)

There is no special mode switch: it is a real shell (PowerShell, cmd, or a
custom shell), so you can run normal commands such as `git`, `npm`, `claude`,
`codex`, and `kimi`. The installer adds the browser MCP endpoint to supported
agent configurations once, making the browser tools available automatically.

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

- The browser starts the host when the terminal panel opens; closing the panel
  stops the host.
- One local process handles terminal I/O, the PTY, and the MCP server.

## Prerequisite: a local Native Messaging host

A browser extension cannot start local programs by itself. Omeety Terminal
therefore uses a one-time Native Messaging host installation. It does not need
a separate always-on service, token, or handshake.

Install **Node.js (LTS recommended)** first. The installer configures browser
tools for any detected Claude Code, Codex CLI, and Kimi Code installations.

## Install once

```powershell
# From the repository root
powershell -ExecutionPolicy Bypass -File installer\install.ps1
```

The installer:

1. Installs host dependencies (`node-pty`, the MCP SDK, and Express).
2. Generates `host/host-manifest.json` and registers it for Edge and Chrome
   under HKCU, without administrator privileges.
3. Adds `http://127.0.0.1:49171/mcp` to the Claude Code, Codex CLI, and Kimi
   Code configurations, creating timestamped backups first.

The public key in `manifest.json` fixes the extension ID as
`fjhjkmpldbepgcpfkhpolnnheccjaamg`, keeping Native Messaging
`allowed_origins` stable across reloads and machines.

Then load the extension:

1. Open `edge://extensions` or `chrome://extensions` and enable **Developer
   mode**.
2. Choose **Load unpacked** and select `omeety-terminal\extension`.
3. Confirm that the extension ID is
   `fjhjkmpldbepgcpfkhpolnnheccjaamg`.

## Use

1. Click the extension icon to open the side panel. On first use, acknowledge
   that a real terminal has full local user permissions.
2. At the PowerShell prompt, run `claude`, `codex`, or `kimi`.
3. Inside an agent, verify that `omeety_terminal` and its 28 `omeety_*` tools
   are connected, then ask the agent to describe or operate the active page.
4. Use the settings button to select PowerShell, cmd, pwsh, Git Bash, or a
   custom shell executable.

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

## Browser tools (28)

**Inspect and retrieve:** `omeety_get_page_snapshot`,
`omeety_get_selected_context`, `omeety_capture_visible_tab`,
`omeety_fetch_with_cookie`, `omeety_get_user_pick`, `omeety_list_tabs`, and
`omeety_get_console_logs`.

**Operate:** `omeety_click`, `omeety_click_text`, `omeety_click_at`,
`omeety_fill`, `omeety_type_text`, `omeety_press_key`, `omeety_select`,
`omeety_scroll`, `omeety_hover`, `omeety_upload_file`, `omeety_open_tab`,
`omeety_switch_tab`, `omeety_navigate`, `omeety_reload`, `omeety_go_back`,
`omeety_close_tab`, `omeety_wait_for`, `omeety_execute_js`,
`omeety_apply_preview_patch`, `omeety_rollback_preview_patch`, and
`omeety_request_user_confirmation`.

Actions that submit, save, delete, agree, or send non-GET requests require an
in-page confirmation. For rich-text editors that ignore synthetic events, set
`cdp: true` on `click_at`, `fill`, `type_text`, or `press_key` to use trusted
browser input.

## Troubleshooting

| Symptom | Resolution |
|---|---|
| Terminal status remains disconnected | Run `install.ps1`, confirm the extension ID matches `allowed_origins`, and verify Node.js is installed. |
| `omeety_terminal` is missing from `/mcp` | Run `install.ps1` again. For Codex, you can also run `codex mcp add omeety_terminal --url http://127.0.0.1:49171/mcp`. |
| Codex or Kimi cannot connect to MCP | Confirm the URL is `http://127.0.0.1:49171/mcp` and inspect `~/.codex/config.toml` or `~/.kimi-code/config.toml`. |
| The shell cannot find Claude, Codex, or Kimi | The host inherits PATH from the browser. Add the CLI directory to the system PATH and restart the browser, or use the full executable path. |
| Screenshots or tool calls fail intermittently | Keep the terminal panel open; closing it stops the host. |

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File installer\uninstall.ps1
```

This removes the registry entries and the `omeety_terminal` blocks from agent
configurations while preserving backups. Remove the unpacked extension from
`edge://extensions` afterward.

## Project layout

```text
extension/    MV3 extension: terminal, Native Messaging port, and content tools
host/         Native Messaging host: PTY + Streamable HTTP MCP + legacy SSE
installer/    install.ps1 and uninstall.ps1
shared/       Protocol documentation
tools/        gen-key.js for a fixed extension key and ID
_test/        Browser-free mock-native smoke tests
_pwtest/      Headed Edge regression probes safe for public reproduction
```

## Known limitations and security

- **A real terminal has full local user permissions.** The MCP server binds only
  to `127.0.0.1`; dangerous browser actions still require in-page confirmation.
- Closing the terminal panel stops the host and ends shell sessions. Reopening
  it creates a new shell.
- Only Windows ConPTY has been verified. macOS and Linux require adapting the
  shell selection in `pty.js`.
- Codex cursor and Chinese IME compatibility in browser side-panel terminals is
  tracked in [openai/codex#35438](https://github.com/openai/codex/issues/35438).
- Except for reviewed public images under `docs/images`, local private keys,
  browser profiles, logs, diagnostic screenshots, and installer-generated files
  are not committed. See [`SECURITY.md`](SECURITY.md).

## License

Omeety Terminal is released under the [MIT License](LICENSE). Third-party
components retain their respective copyrights and licenses; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
