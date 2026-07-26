// Mock native messaging + MCP SSE：冒烟测试 host（无需浏览器）。
// 验证：① 帧编解码 ② PTY echo ③ MCP SSE 握手 + tools/list(27) ④ tools/call 中继往返。
// 端口用随机高位端口（OMEETY_MCP_PORT 传给 host），避免和正在运行的真实 host 抢 49171。
import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Client } from "../host/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"
import { StreamableHTTPClientTransport } from "../host/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"

const PORT = 49200 + (process.pid % 300)
const HOST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "host")
const child = spawn(process.execPath, ["src/index.js"], {
  cwd: HOST_DIR,
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, OMEETY_MCP_PORT: String(PORT) },
})

function frame(obj) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8")
  const h = Buffer.allocUnsafe(4)
  h.writeUInt32LE(buf.length, 0)
  return Buffer.concat([h, buf])
}
function send(obj) {
  child.stdin.write(frame(obj))
}

// native 帧读取
const outputs = []
let q = Buffer.alloc(0)
child.stdout.on("data", (c) => {
  q = Buffer.concat([q, c])
  while (q.length >= 4) {
    const len = q.readUInt32LE(0)
    if (q.length < 4 + len) break
    const m = JSON.parse(q.subarray(4, 4 + len).toString())
    q = q.subarray(4 + len)
    if (m.type === "output") outputs.push(m.data)
    else if (m.type === "tool_call") send({ type: "tool_result", id: m.id, ok: true, result: { mocked: true, tool: m.name } })
    else console.log("← host:", JSON.stringify(m).slice(0, 100))
  }
})

// SSE 事件流
const sseMessages = []
let sessionId = null
async function pumpSse(res) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const lines = block.split("\n")
      const ev = (lines.find((l) => l.startsWith("event:")) || "").replace(/^event:\s?/, "")
      const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.replace(/^data:\s?/, "")).join("")
      if (ev === "endpoint") {
        const mm = data.match(/sessionId=([^&\s]+)/)
        if (mm) sessionId = mm[1]
        console.log("← sse endpoint sessionId:", sessionId)
      } else if (data) {
        try {
          sseMessages.push(JSON.parse(data))
        } catch {
          /* ignore */
        }
      }
    }
  }
}

let pass = 0,
  fail = 0
const ok = (c, m) => (c ? (pass++, console.log("✅", m)) : (fail++, console.log("❌", m)))

async function post(msg) {
  await fetch(`http://127.0.0.1:${PORT}/messages?sessionId=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  })
}

try {
  await sleep(1000)
  send({ type: "hello", shell: "powershell", cols: 80, rows: 24 })
  await sleep(1500)
  send({ type: "input", data: "echo omeety_mock_test_42\r\n" })
  await sleep(1800)
  ok(outputs.join("").toLowerCase().includes("omeety_mock_test_42"), "PTY echo 回显")

  const httpClient = new Client({ name: "omeety-mock-client", version: "1.0.0" })
  const httpTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`))
  await httpClient.connect(httpTransport)
  const httpList = await httpClient.listTools()
  ok(httpList?.tools?.length === 27, `Streamable HTTP tools/list = 27 (实际 ${httpList?.tools?.length})`)
  const httpCall = await httpClient.callTool({ name: "omeety_get_page_snapshot", arguments: {} })
  ok(httpCall?.content?.[0]?.text?.includes("mocked"), "Streamable HTTP tools/call 中继往返")
  await httpClient.close()

  const sseRes = await fetch(`http://127.0.0.1:${PORT}/sse`)
  pumpSse(sseRes).catch(() => {
    /* SSE is expected to close when the mock host is killed. */
  })
  await sleep(800)
  ok(!!sessionId, "SSE 握手拿到 sessionId")

  await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  await sleep(800)
  const list = sseMessages.find((m) => m.id === 1)
  ok(list?.result?.tools?.length === 27, `MCP tools/list = 27 (实际 ${list?.result?.tools?.length})`)
  ok(list?.result?.tools?.some((t) => t.name === "omeety_capture_visible_tab"), "工具含 omeety_capture_visible_tab")
  ok(list?.result?.tools?.some((t) => t.name === "omeety_execute_js"), "工具含 omeety_execute_js（新增）")
  ok(list?.result?.tools?.some((t) => t.name === "omeety_wait_for"), "工具含 omeety_wait_for（新增）")

  await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "omeety_get_page_snapshot", arguments: {} } })
  await sleep(1500)
  const call = sseMessages.find((m) => m.id === 2)
  ok(call?.result?.content?.[0]?.text?.includes("mocked"), "MCP tools/call 中继往返 → mocked 结果")

  console.log(`\n=== mock 测试：${pass} 通过 / ${fail} 失败 ===`)
} catch (e) {
  console.log("测试异常:", e)
} finally {
  child.stdin.end()
  await sleep(500)
  try { child.kill() } catch {}
  process.exit(fail ? 1 : 0)
}
