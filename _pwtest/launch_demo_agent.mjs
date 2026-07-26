// Deterministic MCP client used only by the public launch-demo capture.
// It exercises the same Streamable HTTP tools used by Codex/Claude Code/Kimi
// Code, but avoids network/model variance so the demo can be reproduced.
import { setTimeout as sleep } from "node:timers/promises"
import { Client } from "../host/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"
import { StreamableHTTPClientTransport } from "../host/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"

const url = process.env.OMEETY_MCP_URL || "http://127.0.0.1:49475/mcp"
const client = new Client({ name: "omeety-launch-demo", version: "0.1.0" })
const transport = new StreamableHTTPClientTransport(new URL(url))

function line(text = "") {
  process.stdout.write(text + "\r\n")
}

function toolPayload(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text || "{}"
  return JSON.parse(text)
}

try {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H\x1b]0;Omeety browser demo\x07")
  line("\x1b[1;38;2;255;255;255mOMEETY TERMINAL\x1b[0m")
  line("\x1b[38;2;132;148;170mOne browser exoskeleton for every CLI agent\x1b[0m")
  line()
  line("  \x1b[38;2;120;203;255mCodex\x1b[0m  ·  \x1b[38;2;205;161;255mClaude Code\x1b[0m  ·  \x1b[38;2;96;232;186mKimi Code\x1b[0m")
  line("  same active tab · same MCP tools · real local shell")
  line()
  await sleep(1800)

  line("\x1b[38;2;255;190;92m→\x1b[0m Inspecting the active browser tab…")
  await client.connect(transport)
  const snapshot = toolPayload(await client.callTool({
    name: "omeety_get_page_snapshot",
    arguments: { mode: "light", maxTextLength: 4000 },
  }))
  line(`\x1b[38;2;96;232;186m✓\x1b[0m Found page: ${snapshot.title || "Omeety Launch Lab"}`)
  line("\x1b[38;2;132;148;170m  tool: omeety_get_page_snapshot\x1b[0m")
  await sleep(1500)

  line()
  line("\x1b[38;2;255;190;92m→\x1b[0m Acting on ‘Connect browser’…")
  const clicked = toolPayload(await client.callTool({
    name: "omeety_click",
    arguments: {
      selector: "#connect-browser",
      waitForText: "Browser linked",
      waitForTimeoutMs: 8000,
    },
  }))
  if (!clicked.clicked || !clicked.waited?.found) {
    throw new Error("The demo target did not reach its linked state")
  }
  line("\x1b[38;2;96;232;186m✓\x1b[0m Browser action completed through MCP")
  line("\x1b[38;2;132;148;170m  tool: omeety_click · current logged-in tab\x1b[0m")
  line()
  line("\x1b[1;38;2;255;255;255mDemo complete — the terminal stayed a terminal.\x1b[0m")
  await sleep(8000)
} catch (error) {
  line(`\x1b[38;2;255;105;120mDemo failed: ${error?.message || error}\x1b[0m`)
  process.exitCode = 1
} finally {
  try {
    await client.close()
  } catch {
    // The temporary Edge profile may close the native host first.
  }
}
