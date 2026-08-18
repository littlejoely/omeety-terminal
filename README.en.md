# Omeety Terminal

[简体中文](README.md) · **English**

[![Release](https://img.shields.io/github/v/release/littlejoely/omeety-terminal?display_name=tag&style=flat-square)](https://github.com/littlejoely/omeety-terminal/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-7dd3fc?style=flat-square)](LICENSE)
[![Platform: Windows/macOS](https://img.shields.io/badge/platform-Windows_%7C_macOS-8aa4ff?style=flat-square)](#support)

## Let AI actually do the work

**Omeety Terminal puts a real local terminal in the Chrome / Edge side panel and gives the
CLI agents you already use eyes and hands in your current browser.**

It is not another AI, and it does not replace Codex, Claude Code, or Kimi Code. You keep
working in a familiar terminal; your agent can now see, understand, and operate the tabs you
are already using, including their existing signed-in state.

![Omeety reads and operates the current tab through the real MCP path](docs/images/omeety-demo.gif)

> The demo runs through the real extension, Native Messaging, PTY, and MCP path. It is not a
> prerecorded model response.

[Download the latest release](https://github.com/littlejoely/omeety-terminal/releases/latest) ·
[Start in 3 minutes](#start-in-3-minutes) ·
[Security boundaries](#security-boundaries) ·
[Contribute](CONTRIBUTING.md)

## What it connects

AI is already capable. Real work is still fragmented across web pages, terminals, and
copy-paste loops.

Omeety connects that workflow:

- **See the page:** inspect the active tab, structured content, screenshots, Console output,
  and iframe content.
- **Act on it:** click, type, select, scroll, upload files, and verify whether the action
  actually took effect.
- **Work with local tools:** the side panel contains a real PTY, so `git`, `npm`, `codex`,
  `claude`, `kimi`, and ordinary shell commands work as expected.
- **Keep the loop visible:** you and the agent share the same browser and terminal; targets,
  actions, and results remain in view.
- **Stay model-neutral:** browser capabilities are exposed through MCP, so compatible CLI
  agents can reuse the same contract.

In one line: **a normal terminal controls the computer; Omeety can also see the browser.**

## What it is useful for

| Workflow | Examples |
|---|---|
| Web operations | Forms, approvals, admin panels, and repetitive data entry |
| Cross-system tasks | Export from one site, transform locally, upload to another |
| Browser + local files | Save page data, process it locally, then write results back |
| Information collection | Traverse lists, extract structured data, and create local outputs |
| Complex interfaces | Use element picking, screenshots, or real CDP input for icons, Canvas, and rich editors |

High-impact actions such as submit, save, delete, consent, and non-GET requests retain an
explicit user confirmation. Omeety supplies execution capability; it does not decide your
permission boundary for you.

## Start in 3 minutes

Verified environments: **Windows 11 + Microsoft Edge** and **macOS + Google Chrome**.
Install Node.js LTS and the CLI agent you intend to use first.

### 1. Get Omeety

Download the dependency-complete
[latest offline release](https://github.com/littlejoely/omeety-terminal/releases/latest), or clone the repository:

```bash
git clone https://github.com/littlejoely/omeety-terminal.git
cd omeety-terminal
```

### 2. Install the local host

macOS:

```bash
./installer/install.sh
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File installer\install.ps1
```

The installer prepares the Native Messaging host and adds the local MCP endpoint to detected
Codex, Claude Code, and Kimi Code configurations. It creates timestamped backups before edits.

### 3. Load the extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode and choose **Load unpacked**.
3. Select the repository's `extension` directory.
4. Open the Omeety side panel and launch your agent in the terminal.
5. Ask it: **“Describe the current page.”**

For unlabeled icons or complex controls, choose **Pick** in the side panel, select one or more
elements, and press Enter. Omeety sends stable references and concise summaries to the active
agent without submitting the command automatically.

## How it differs from a standalone Browser MCP

| | Omeety Terminal | Standalone Browser MCP / automation process |
|---|---|---|
| Browser | The tabs you already use and are signed into | Often a separate browser or context |
| Entry point | A real local terminal | Usually a tool server only |
| Agents | Codex, Claude Code, Kimi Code, and other MCP agents | Depends on each integration |
| Interaction | Terminal and page stay visible together | Often split across windows |
| Security boundary | Local bridge with confirmation for risky web actions | Depends on the implementation |

Omeety is **addition, not replacement**: keep the agent, shell, browser session, and habits you
already have; add reliable browser perception and action.

## How it works

```text
Chrome / Edge side panel
┌──────────────────────────────┐
│ xterm.js · real local PTY    │
└────────── Native Messaging ──┘
                 │
                 ▼
Local Node host (loopback only)
├─ PTY and session recovery
├─ Browser Core: targets, policy, verification, and redacted audit
├─ Browser Adapter / CDP: observation and real input
├─ Download Core: resume, proxy routing, and SHA-256 verification
└─ MCP · http://127.0.0.1:49171/mcp
                 ▲
       Codex / Claude Code / Kimi Code / other MCP agents
```

Browser Core exposes seven high-level tools plus compatible low-level browser tools, alongside
three persistent download tools: 41 MCP tools in total. High-level calls handle target pinning,
policy checks, stale-element recovery, post-action verification, metrics, and redacted audit.
See [Browser Core v2](docs/browser-core-v2.md) and the [protocol notes](shared/protocol.md) for
implementation and test details.

## Terminal experience

- Multiple terminal tabs, renaming, recovery of live sessions, and bounded output replay.
- Search, link opening, selection copy, bracketed paste, OSC52, and True Color.
- Only the active tab keeps a WebGL renderer; background sessions keep running without holding
  their GPU renderer.
- Configurable keep-alive: persistent, 30-minute idle timeout, or close with the side panel.
- Windows uses ConPTY; macOS uses a real zsh PTY.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Red terminal status | Re-run the installer, confirm Node is installed, and verify the extension ID matches the Native Host configuration |
| No `omeety_terminal` in the agent | Re-run the installer and restart the agent; the MCP URL is `http://127.0.0.1:49171/mcp` |
| Agent command not found | Add its directory to the system PATH and fully restart the browser, or use the absolute path |
| Browser cannot communicate with the native host | Move the project to an ASCII-only path without spaces and reinstall |
| Extension fails to load | Select the `extension` directory containing `manifest.json`, not the repository root or zip file |
| macOS blocks a native module | Allow the relevant Node binary in System Settings → Privacy & Security → Developer Tools, then reinstall |

## Security boundaries

- **A real terminal has the permissions of your current system user.** Use only agents and tasks
  you trust.
- The MCP server listens only on `127.0.0.1`; it is not directly exposed to the LAN or internet.
- Risky browser actions require in-page confirmation, with `read`, `act`, and `submit` policy levels.
- Downloads show their source, name, destination, and verification data before starting; downloaded
  content is never executed automatically.
- Audit records redact entered values, authentication headers, URL credentials, and sensitive query
  parameters.
- Omeety can reuse browser login state, so page content may be sent to the model provider used by
  your agent. The complete data boundary also depends on that agent, model, and target website.
- Local private keys, browser profiles, logs, debug screenshots, generated installation files, and
  backups are not committed. See [SECURITY.md](SECURITY.md).

## Support

- Verified: Windows 11 + Edge and macOS + Chrome.
- Other Chromium browsers may work but have not all completed real-device regression testing.
- Linux has not completed formal browser validation.
- Safari is not supported; its extension, side-panel, CDP, and Native Messaging model requires a
  separate adapter.
- Omeety is an independently developed beta project. It is not an official product of OpenAI,
  Anthropic, Moonshot AI, Microsoft, or xterm.js.

## Development and uninstall

```bash
cd host
npm test
```

Uninstall on macOS:

```bash
./installer/uninstall.sh
```

Uninstall on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File installer\uninstall.ps1
```

Main directories: `extension/` (MV3 extension), `host/` (PTY, Browser Core, downloads, and MCP),
`installer/` (installers), `shared/` (protocol), and `_test/` / `_pwtest/` (regression tests).

## License

[MIT](LICENSE) · Third-party licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

If Omeety reduces the switching cost between your browser and local tools, consider giving the
project a Star.
