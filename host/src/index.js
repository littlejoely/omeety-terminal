// Omeety Terminal native messaging host 入口。
// 三件事：① native stdio（与扩展通信）② PTY（真实 shell）③ MCP HTTP（agent 连它用浏览器工具）。
import { nmSend, startNmReader } from "./nm-stdio.js"
import { startPty, resolveShell } from "./pty.js"
import { resolveResult } from "./relay.js"
import { startMcpHttp } from "./mcp-server.js"
import { TOOLS } from "./tools.meta.js"
import { log } from "./log.js"

const MCP_PORT = Number(process.env.OMEETY_MCP_PORT) || 49171
const ptys = new Map() // sid(会话 id) -> ptyApi。多终端 tab：每个 tab 一个独立 PTY。
const sessionMeta = new Map() // sid -> 可恢复的 tab 元数据（标题、shell、兼容开关、创建时间）
let lastMsgAt = Date.now() // 最近一次收到 native 消息的时间；心跳保活的判据
const sidOf = (msg) => (msg && msg.sid) || "default" // 无 sid 走默认会话（兼容旧的单 tab 行为）
let panelOpen = true // host 由首次打开侧栏触发，后续由 panel_state 精确更新
let panelDetachedAt = 0
let keepAliveMode = "always"
let cleaningUp = false

function normalizeKeepAliveMode(value) {
  return ["always", "30m", "close"].includes(value) ? value : "always"
}

function updateSessionMeta(sid, patch = {}) {
  const current = sessionMeta.get(sid) || {
    sid,
    title: `终端 ${sessionMeta.size + 1}`,
    shell: "auto",
    renamed: false,
    punctCompat: false,
    createdAt: Date.now(),
  }
  const next = {
    ...current,
    ...(typeof patch.shell === "string" && patch.shell ? { shell: patch.shell } : {}),
    ...(typeof patch.title === "string" && patch.title.trim() ? { title: patch.title.trim().slice(0, 80) } : {}),
    ...(typeof patch.renamed === "boolean" ? { renamed: patch.renamed } : {}),
    ...(typeof patch.punctCompat === "boolean" ? { punctCompat: patch.punctCompat } : {}),
  }
  sessionMeta.set(sid, next)
  return next
}

function listSessions() {
  return [...ptys.keys()].map((sid) => ({ ...updateSessionMeta(sid), sid }))
}

// 兜底：native messaging 是黑盒，任何未捕获异常都要落盘，否则看不到崩溃栈。
process.on("uncaughtException", (e) => {
  log("UNCAUGHT", e?.stack || String(e))
  try {
    nmSend({ type: "status", state: "mcp_error", msg: "host 崩溃：" + (e?.message || e) })
  } catch {
    /* stdout 可能也坏了 */
  }
  cleanup(1)
})
process.on("unhandledRejection", (e) => {
  log("UNHANDLED REJECTION", e?.stack || String(e))
})

log("boot", {
  pid: process.pid,
  node: process.version,
  argv: process.argv,
  cwd: process.cwd(),
  stdinIsTTY: process.stdin.isTTY,
  stdoutIsTTY: process.stdout.isTTY,
})

startMcpHttp({ port: MCP_PORT, nmSend })

// 静默看门狗：扩展每 8s 发 ping。若 25s 没收到任何 native 消息，说明 SW 已回收 / 面板已关，
// 但本进程没拿到 stdin EOF（Edge 有时不及时关管道）→ 主动退出，释放 49171，避免变僵尸坑下次连接。
setInterval(() => {
  if (Date.now() - lastMsgAt > 25000) {
    log("silence watchdog: 25s 无 native 消息，判定连接已断，退出")
    cleanup(0)
    return
  }
  if (!panelOpen && keepAliveMode === "30m" && panelDetachedAt && Date.now() - panelDetachedAt >= 30 * 60 * 1000) {
    log("session idle watchdog: 侧栏关闭超过 30 分钟，结束保活会话")
    cleanup(0)
  }
}, 5000)

startNmReader((msg) => {
  lastMsgAt = Date.now()
  // ping and dynamic terminal-title metadata are high-frequency bookkeeping.
  // Logging either one creates needless disk writes while a CLI spinner is
  // updating the window title; state changes remain visible in explicit logs.
  if (msg?.type !== "ping" && msg?.type !== "session_meta") {
    log("nm in", msg?.type, msg?.shell ? "shell=" + msg.shell : "", msg?.cols ?? "", msg?.rows ?? "")
  }
  switch (msg?.type) {
    case "hello": {
      // 扩展连上后第一条：带 sid + shell + 尺寸。据此 spawn 该 tab 的 PTY（已存在则只 resize）。
      const sid = sidOf(msg)
      updateSessionMeta(sid, msg)
      let ready = true
      if (!ptys.has(sid)) ready = spawnShell(sid, msg.shell, msg.cols, msg.rows)
      else if (msg.cols && msg.rows) ptys.get(sid).resize(msg.cols, msg.rows)
      if (ready) nmSend({ type: "status", state: "ready", sid })
      break
    }
    case "list_sessions":
      nmSend({ type: "sessions_list", sessions: listSessions() })
      break
    case "session_meta":
      if (ptys.has(sidOf(msg))) updateSessionMeta(sidOf(msg), msg)
      break
    case "panel_state": {
      keepAliveMode = normalizeKeepAliveMode(msg.keepAliveMode)
      panelOpen = !!msg.open
      panelDetachedAt = panelOpen ? 0 : Date.now()
      log("panel state", panelOpen ? "open" : "closed", "keepAlive=" + keepAliveMode)
      if (!panelOpen && keepAliveMode === "close") cleanup(0)
      break
    }
    case "input":
      ptys.get(sidOf(msg))?.write(msg.data || "")
      break
    case "resize":
      ptys.get(sidOf(msg))?.resize(msg.cols || 80, msg.rows || 24)
      break
    case "tool_result":
      resolveResult(msg)
      break
    case "list_tools":
      // 设置面板"查看工具"子菜单：返回 omeety 注册的全部工具（name + description）。
      nmSend({ type: "tools_list", tools: TOOLS.map((t) => ({ name: t.name, description: t.description })) })
      break
    case "restart": {
      // 设置页切换 shell：在同一条 native 连接上原子替换 PTY，避免 panel
      // 断连/重连和 shutdown → hello 之间的竞态。先从 map 移除旧实例，
      // 这样它稍后到达的 onExit 不会误删新 PTY。
      const sid = sidOf(msg)
      const oldPty = ptys.get(sid)
      if (oldPty) {
        ptys.delete(sid)
        try {
          oldPty.kill()
        } catch {
          /* ignore */
        }
      }
      if (spawnShell(sid, msg.shell, msg.cols, msg.rows)) {
        updateSessionMeta(sid, { ...msg, shell: msg.shell })
        nmSend({ type: "status", state: "ready", sid })
      }
      break
    }
    case "shutdown": {
      const sid = msg && msg.sid
      if (sid) {
        if (ptys.has(sid)) {
          // 关单个 tab：杀该 PTY
          try {
            ptys.get(sid).kill()
          } catch {
            /* ignore */
          }
          ptys.delete(sid)
        }
        sessionMeta.delete(sid)
      } else {
        cleanup(0) // 无 sid = 整体退出（面板全关）
      }
      break
    }
  }
})

function cleanup(code) {
  if (cleaningUp) return
  cleaningUp = true
  log("cleanup", code)
  for (const [, pty] of ptys) {
    try {
      pty.kill()
    } catch {
      /* ignore */
    }
  }
  ptys.clear()
  sessionMeta.clear()
  process.exit(code)
}

function spawnShell(sid, shellChoice, cols, rows) {
  try {
    const { cmd, args } = resolveShell(shellChoice)
    log("spawnShell start sid=" + sid, cmd, JSON.stringify(args), "cols=" + cols, "rows=" + rows)
    const ptyApi = startPty({
      shell: cmd,
      args,
      cols,
      rows,
      cwd: process.env.USERPROFILE || process.env.HOME,
      onOutput: (d) => nmSend({ type: "output", sid, data: d }),
      onExit: (code) => {
        // 切换 shell 时旧 PTY 的退出事件可能晚于新 PTY 的 spawn。只允许当前
        // map 中仍指向本实例的回调删除 sid，避免旧 PowerShell 把新 CMD 误删。
        if (ptys.get(sid) !== ptyApi) {
          log("stale pty exit ignored sid=" + sid, code)
          return
        }
        log("pty exit sid=" + sid, code)
        ptys.delete(sid)
        sessionMeta.delete(sid)
        nmSend({ type: "status", state: "pty_exit", sid, msg: String(code) })
      },
    })
    ptys.set(sid, ptyApi)
    updateSessionMeta(sid, { shell: shellChoice || "auto" })
    log("spawnShell OK sid=" + sid)
    return true
  } catch (e) {
    log("spawnShell FAILED sid=" + sid, e?.stack || String(e))
    nmSend({ type: "status", state: "mcp_error", sid, msg: "shell 启动失败：" + (e?.message || e) })
    return false
  }
}

// 浏览器关闭端口时，stdout 写会 EPIPE；stdin EOF → 先杀 PTY 再干净退出。
process.stdout.on("error", (e) => {
  log("stdout error", e?.message || String(e))
  cleanup(0)
})
process.stdin.on("end", () => {
  log("stdin END（浏览器关闭了 native 端口 / EOF）")
  cleanup(0)
})
process.stdin.on("error", (e) => {
  log("stdin ERROR", e?.message || String(e))
  cleanup(0)
})

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    log("signal", signal)
    cleanup(0)
  })
}
