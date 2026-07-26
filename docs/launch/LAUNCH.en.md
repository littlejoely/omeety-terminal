# Omeety Terminal launch copy

Repository: https://github.com/littlejoely/omeety-terminal

Demo: `docs/images/omeety-demo.gif`

## Show HN title

Show HN: Omeety – a real terminal in Edge that gives any CLI agent control of your active tab

## Show HN / Reddit body

I built **Omeety Terminal**, an open-source real local terminal in the
Edge/Chrome side panel with a browser-control MCP server already wired in.

Run Codex, Claude Code, Kimi Code, or another MCP-capable CLI inside it and the
agent can inspect and operate the browser tab you are already using and logged
into.

I think of Omeety as a **browser exoskeleton for CLI agents**. It does not
replace the agent, pick the model, or turn the side panel into another chat UI.
It keeps a real PTY and ordinary shell while giving different model-agent
combinations the same browser eyes and hands.

The first public Windows beta includes:

- a real ConPTY terminal with multiple tabs and side-panel session keepalive;
- 32 browser MCP tools over Streamable HTTP, plus legacy SSE compatibility;
- snapshots with stable element IDs, element picking, screenshots, Console
  capture, and navigation-resilient waits;
- trusted CDP input, file uploads, and reversible page previews;
- automatic MCP configuration for Codex CLI, Claude Code, and Kimi Code;
- localhost-only bridging and browser confirmation for dangerous actions.

It is currently verified on Windows 11 with Edge. Chrome has installer support,
while macOS/Linux still need a shell adapter. Feedback, focused issues, and
contributions are welcome.

https://github.com/littlejoely/omeety-terminal

## X / Bluesky short version

I open-sourced Omeety Terminal: a real local terminal in the Edge/Chrome side
panel that acts as a browser exoskeleton for Codex, Claude Code, Kimi Code, and
any MCP CLI. Same active tab, same 32 browser tools, no agent lock-in.

Windows beta · MIT
https://github.com/littlejoely/omeety-terminal

## Launch checklist

- Attach the animated demo, not only the repository URL.
- Say “Windows beta” prominently.
- Stay available for installation and security questions after posting.
- Adapt the text to each community's rules; do not cross-post identical spam.
