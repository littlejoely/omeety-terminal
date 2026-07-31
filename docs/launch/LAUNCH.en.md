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

The current Windows/macOS beta includes:

- real Windows ConPTY and macOS Unix PTY terminals with multiple tabs and
  side-panel session keepalive;
- 41 MCP tools (38 browser tools and 3 local download tools) over Streamable
  HTTP, plus legacy SSE compatibility;
- Browser Core v2 with pinned tabs, same-origin stale-UID recovery, deep
  cross-frame observation, post-action verification, and redacted auditing;
- snapshots with stable element IDs, element picking, screenshots, Console
  capture, and navigation-resilient waits;
- trusted CDP input, file uploads, and reversible page previews;
- persistent downloads with resume, route selection, and SHA-256 verification;
- automatic MCP configuration for Codex CLI, Claude Code, and Kimi Code;
- localhost-only bridging and browser confirmation for dangerous actions.

It is verified on Windows 11 with Microsoft Edge and macOS with Google Chrome.
Linux has not completed a real-browser regression pass. Feedback, focused
issues, and contributions are welcome.

https://github.com/littlejoely/omeety-terminal

## X / Bluesky short version

I open-sourced Omeety Terminal: a real local terminal in the Edge/Chrome side
panel that acts as a browser exoskeleton for Codex, Claude Code, Kimi Code, and
any MCP CLI. Same browser, 41 MCP tools, Browser Core v2, no agent lock-in.

Windows/macOS beta · MIT
https://github.com/littlejoely/omeety-terminal

## Launch checklist

- Attach the animated demo, not only the repository URL.
- State the verified combinations precisely: Windows 11 + Edge and macOS + Chrome.
- Stay available for installation and security questions after posting.
- Adapt the text to each community's rules; do not cross-post identical spam.
