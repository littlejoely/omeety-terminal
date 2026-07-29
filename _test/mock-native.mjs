// Mock native messaging + MCP SSE：冒烟测试 host（无需浏览器）。
// 验证：① 帧编解码 ② PTY echo ③ MCP 双协议握手 + tools/list ④ tools/call 中继与 host 本地工具。
// 端口用随机高位端口（OMEETY_MCP_PORT 传给 host），避免和正在运行的真实 host 抢 49171。
import { spawn } from "node:child_process"
import { once } from "node:events"
import { rm } from "node:fs/promises"
import { createServer } from "node:net"
import os from "node:os"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Client } from "../host/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"
import { StreamableHTTPClientTransport } from "../host/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"
import { TOOLS } from "../host/src/tools.meta.js"

async function findAvailablePort() {
  const probe = createServer()
  probe.listen(0, "127.0.0.1")
  await once(probe, "listening")
  const port = probe.address().port
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

const PORT = await findAvailablePort()
const HOST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "host")
const DOWNLOAD_TEST_ROOT = join(os.tmpdir(), `omeety-mock-download-${process.pid}`)
const EXPECTED_TOOL_COUNT = TOOLS.length
const child = spawn(process.execPath, ["src/index.js"], {
  cwd: HOST_DIR,
  stdio: ["pipe", "pipe", "inherit"],
  // 模拟浏览器由禁色终端启动：Host 可以继承 NO_COLOR，但它创建的 Omeety PTY 不得继承。
  env: {
    ...process.env,
    OMEETY_MCP_PORT: String(PORT),
    OMEETY_DOWNLOAD_STATE_DIR: join(DOWNLOAD_TEST_ROOT, "state"),
    OMEETY_DOWNLOAD_DIR: join(DOWNLOAD_TEST_ROOT, "downloads"),
    OMEETY_BROWSER_AUDIT_PATH: join(DOWNLOAD_TEST_ROOT, "browser-audit.jsonl"),
    NO_COLOR: "1",
    LC_ALL: "C",
    TERM_PROGRAM: "parent-terminal",
    TERM_PROGRAM_VERSION: "9.9.9",
  },
})

const TEST_TIMEOUT_MS = Math.max(1000, Number(process.env.OMEETY_TEST_TIMEOUT_MS) || 30_000)
let timedOut = false
let stopPromise = null
let forceExitTimer = null

function stopChild() {
  if (stopPromise) return stopPromise
  stopPromise = (async () => {
    try { child.stdin.end() } catch {}
    if (child.exitCode !== null || child.signalCode) return
    try { child.kill("SIGTERM") } catch {}
    await Promise.race([once(child, "exit").catch(() => {}), sleep(1500)])
    if (child.exitCode === null && !child.signalCode) {
      try { child.kill("SIGKILL") } catch {}
    }
  })()
  return stopPromise
}

const testTimeout = setTimeout(() => {
  timedOut = true
  console.error(`❌ mock 测试超过 ${TEST_TIMEOUT_MS / 1000}s，正在清理 Host/PTY`)
  void stopChild()
  // 即使某个网络请求没有因 Host 退出而结束，也不允许测试进程永久挂住。
  forceExitTimer = setTimeout(() => process.exit(1), 2500)
}, TEST_TIMEOUT_MS)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    timedOut = true
    void stopChild().finally(() => process.exit(1))
  })
}

function frame(obj) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8")
  const h = Buffer.allocUnsafe(4)
  h.writeUInt32LE(buf.length, 0)
  return Buffer.concat([h, buf])
}
function send(obj) {
  if (stopPromise || child.stdin.destroyed || child.stdin.writableEnded) return
  try { child.stdin.write(frame(obj)) } catch { /* timeout/signal cleanup may close stdin concurrently */ }
}
child.stdin.on("error", () => { /* cleanup races are expected in the timeout regression */ })

// native 帧读取
const outputs = []
const nativeMessages = []
const relayedTools = []
let q = Buffer.alloc(0)
child.stdout.on("data", (c) => {
  q = Buffer.concat([q, c])
  while (q.length >= 4) {
    const len = q.readUInt32LE(0)
    if (q.length < 4 + len) break
    const m = JSON.parse(q.subarray(4, 4 + len).toString())
    q = q.subarray(4 + len)
    if (m.type === "output") outputs.push(m.data)
    else if (m.type === "tool_call") {
      relayedTools.push(m.name)
      send({ type: "tool_result", id: m.id, ok: true, result: { mocked: true, tool: m.name } })
    }
    else {
      nativeMessages.push(m)
      console.log("← host:", JSON.stringify(m).slice(0, 100))
    }
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

  const colorProbe = `node -e "console.log('OMEETY_COLOR_ENV:'+Buffer.from(JSON.stringify({TERM:process.env.TERM,COLORTERM:process.env.COLORTERM,NO_COLOR:process.env.NO_COLOR||null,TERM_PROGRAM:process.env.TERM_PROGRAM,TERM_PROGRAM_VERSION:process.env.TERM_PROGRAM_VERSION||null,LANG:process.env.LANG||null,LC_ALL:process.env.LC_ALL||null,LC_CTYPE:process.env.LC_CTYPE||null})).toString('base64'))"\r\n`
  send({ type: "input", data: colorProbe })
  await sleep(800)
  const colorMatches = [...outputs.join("").matchAll(/OMEETY_COLOR_ENV:([A-Za-z0-9+/]+={0,2})/g)]
  let ptyColorEnv = null
  try {
    ptyColorEnv = JSON.parse(Buffer.from(colorMatches.at(-1)?.[1] || "", "base64").toString("utf8"))
  } catch {
    /* ok() below reports a readable failure */
  }
  ok(
    ptyColorEnv?.TERM === "xterm-256color" &&
      ptyColorEnv?.COLORTERM === "truecolor" &&
      ptyColorEnv?.NO_COLOR === null &&
      ptyColorEnv?.TERM_PROGRAM === "Omeety" &&
      ptyColorEnv?.TERM_PROGRAM_VERSION === null &&
      (process.platform === "win32" || (
        /utf-?8/i.test(ptyColorEnv?.LANG || "") &&
        ptyColorEnv?.LC_ALL === null &&
        /utf-?8/i.test(ptyColorEnv?.LC_CTYPE || "")
      )),
    "PTY 清除 NO_COLOR/非 UTF-8 locale 并声明 256 色/True Color 能力",
  )

  send({ type: "session_meta", sid: "default", title: "恢复测试", renamed: true, punctCompat: true })
  send({ type: "hello", sid: "second", shell: "auto", cols: 90, rows: 30, title: "第二终端" })
  await sleep(300)
  send({ type: "list_sessions" })
  await sleep(200)
  const restored = nativeMessages.filter((m) => m.type === "sessions_list").at(-1)?.sessions || []
  ok(restored.length === 2, `会话清单恢复 2 个 PTY（实际 ${restored.length}）`)
  ok(restored.some((s) => s.sid === "default" && s.title === "恢复测试" && s.punctCompat), "会话标题与兼容设置可恢复")
  send({ type: "shutdown", sid: "second" })

  const httpClient = new Client({ name: "omeety-mock-client", version: "1.0.0" })
  const httpTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`))
  await httpClient.connect(httpTransport)
  const httpList = await httpClient.listTools()
  ok(httpList?.tools?.length === EXPECTED_TOOL_COUNT, `Streamable HTTP tools/list = ${EXPECTED_TOOL_COUNT} (实际 ${httpList?.tools?.length})`)
  const httpCall = await httpClient.callTool({ name: "omeety_get_page_snapshot", arguments: {} })
  ok(httpCall?.content?.[0]?.text?.includes("mocked"), "Streamable HTTP tools/call 中继往返")
  const coreCall = await httpClient.callTool({ name: "omeety_browser_act", arguments: { action: "click", uid: "u1", tabId: 7 } })
  ok(coreCall?.content?.[0]?.text?.includes("omeety_act_and_verify") && relayedTools.includes("omeety_act_and_verify"), "Browser Core 高层动作映射到兼容事务工具")
  const coreStatus = await httpClient.callTool({ name: "omeety_browser_status", arguments: {} })
  ok(coreStatus?.content?.[0]?.text?.includes('"version":2'), "Browser Core 状态由 Host 本地返回")
  const downloadStatus = await httpClient.callTool({ name: "omeety_download_status", arguments: {} })
  ok(downloadStatus?.content?.[0]?.text?.includes('\"count\":0'), "Streamable HTTP host 本地下载工具")
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
  ok(list?.result?.tools?.length === EXPECTED_TOOL_COUNT, `MCP tools/list = ${EXPECTED_TOOL_COUNT} (实际 ${list?.result?.tools?.length})`)
  ok(list?.result?.tools?.some((t) => t.name === "omeety_browser_observe"), "工具含 Browser Core 统一观察")
  ok(list?.result?.tools?.some((t) => t.name === "omeety_browser_transaction"), "工具含 Browser Core 事务")
  ok(list?.result?.tools?.some((t) => t.name === "omeety_capture_visible_tab"), "工具含 omeety_capture_visible_tab")
  ok(list?.result?.tools?.some((t) => t.name === "omeety_execute_js"), "工具含 omeety_execute_js（新增）")
  ok(list?.result?.tools?.some((t) => t.name === "omeety_wait_for"), "工具含 omeety_wait_for（新增）")
  ok(list?.result?.tools?.some((t) => t.name === "omeety_get_user_picks"), "工具含 omeety_get_user_picks（连续选取）")
  ok(list?.result?.tools?.some((t) => t.name === "omeety_download_start"), "工具含 omeety_download_start（持久化下载）")

  await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "omeety_get_page_snapshot", arguments: {} } })
  await sleep(1500)
  const call = sseMessages.find((m) => m.id === 2)
  ok(call?.result?.content?.[0]?.text?.includes("mocked"), "MCP tools/call 中继往返 → mocked 结果")

  const hostExit = once(child, "exit")
  send({ type: "panel_state", open: false, keepAliveMode: "close" })
  const exitResult = await Promise.race([hostExit.then(() => true), sleep(2000).then(() => false)])
  ok(exitResult, "关闭侧栏=立即结束策略会清理 Host/PTY")

  console.log(`\n=== mock 测试：${pass} 通过 / ${fail} 失败 ===`)
} catch (e) {
  fail++
  console.log("测试异常:", e)
} finally {
  clearTimeout(testTimeout)
  if (forceExitTimer) clearTimeout(forceExitTimer)
  await stopChild()
  await rm(DOWNLOAD_TEST_ROOT, { recursive: true, force: true })
  process.exit(fail || timedOut ? 1 : 0)
}
