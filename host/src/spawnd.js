// spawnd：由 launchd 拉起的 PTY 守护进程。
// 为什么需要它：macOS 会把 Chrome 进程树下任何进程写的网络文件打上
// com.apple.quarantine（责任进程归因），native host 及其 PTY 子进程全部中招——
// brew/npm 下载的可执行二进制会被 Gatekeeper 直接 SIGKILL，且在 Chrome 责任链
// 内连 xattr -d 都会 EPERM、双 fork 孤儿化也洗不掉归因。唯一干净的出路是让
// PTY 由 launchd 拉起的守护进程（launchd 责任链）来 spawn：实测同一文件下载后
// 不再带隔离标记，行为与系统 Terminal.app 一致。
// 协议：unix socket 上的 NDJSON（每行一个 JSON 对象）。数据帧是 utf8 字符串，
// 与 host 转发给扩展的 output 帧同构。每个连接独享自己的 PTY 集合：
// 连接断开 = 宿主死了 = 杀掉该连接的全部 PTY（与旧架构 host 死亡语义一致）。
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pty from "node-pty"

const SOCK_PATH = process.env.OMEETY_SPAWND_SOCK || path.join(os.homedir(), ".omeety", "spawnd.sock")
const OMEETY_DIR = path.dirname(SOCK_PATH)
const LOG_PATH = process.env.OMEETY_SPAWND_LOG || path.join(OMEETY_DIR, "spawnd.log")
const startedAt = Date.now()

function log(...args) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] pid=${process.pid} ${args.join(" ")}\n`)
  } catch {
    /* 日志不能影响守护 */
  }
}

function ensureDir() {
  fs.mkdirSync(OMEETY_DIR, { recursive: true })
  try { fs.chmodSync(OMEETY_DIR, 0o700) } catch { /* 非 POSIX 或权限不足时忽略 */ }
}

function send(conn, obj) {
  try {
    conn.write(JSON.stringify(obj) + "\n")
  } catch {
    /* 连接已坏，等 close 事件统一清理 */
  }
}

function handleSpawn(conn, msg) {
  const { sid, shell, args, cols, rows, cwd, env } = msg
  if (!sid || typeof shell !== "string") {
    send(conn, { t: "err", sid, msg: "spawn needs sid and shell" })
    return
  }
  if (conn.ptys.has(sid)) {
    // 同一宿主对同一 sid 重复 spawn：先杀旧再建新，对齐 host 侧 session_reset 语义。
    try { conn.ptys.get(sid).kill() } catch { /* ignore */ }
    conn.ptys.delete(sid)
  }
  try {
    const term = pty.spawn(shell, Array.isArray(args) ? args : [], {
      name: "xterm-256color",
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || os.homedir(),
      env: env && typeof env === "object" ? env : { ...process.env },
    })
    conn.ptys.set(sid, term)
    term.onData((d) => send(conn, { t: "d", sid, s: d }))
    term.onExit(({ exitCode }) => {
      if (conn.ptys.get(sid) === term) conn.ptys.delete(sid)
      send(conn, { t: "exit", sid, code: exitCode })
    })
    send(conn, { t: "ok", sid })
    log("spawn", sid, shell, "live=" + conn.ptys.size)
  } catch (e) {
    send(conn, { t: "err", sid, msg: String(e?.message || e) })
    log("spawn FAILED", sid, String(e?.message || e))
  }
}

function onLine(conn, line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    send(conn, { t: "err", msg: "bad json" })
    return
  }
  switch (msg.t) {
    case "ping":
      send(conn, { t: "pong", v: 1, uptimeMs: Date.now() - startedAt, ptys: countPtys() })
      return
    case "spawn":
      handleSpawn(conn, msg)
      return
    case "w":
      try { conn.ptys.get(msg.sid)?.write(String(msg.s ?? "")) } catch { /* ignore */ }
      return
    case "resize":
      try { conn.ptys.get(msg.sid)?.resize(msg.c || 80, msg.r || 24) } catch { /* ignore */ }
      return
    case "kill":
      try { conn.ptys.get(msg.sid)?.kill() } catch { /* ignore */ }
      return
    default:
      send(conn, { t: "err", msg: "unknown t: " + msg.t })
  }
}

function countPtys() {
  let n = 0
  for (const conn of conns) n += conn.ptys.size
  return n
}

function killConnPtys(conn) {
  for (const [sid, term] of conn.ptys) {
    try { term.kill() } catch { /* ignore */ }
    log("conn close kill", sid)
  }
  conn.ptys.clear()
}

const conns = new Set()
const server = net.createServer((conn) => {
  conn.ptys = new Map()
  conns.add(conn)
  log("conn open", "live=" + conns.size)
  let buf = ""
  conn.on("data", (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.trim()) onLine(conn, line)
    }
    if (buf.length > 4 * 1024 * 1024) {
      // 单行超过 4MB 视为协议异常，丢弃该连接而不是 OOM。
      log("conn oversized frame, dropping")
      conn.destroy()
    }
  })
  conn.on("close", () => {
    conns.delete(conn)
    killConnPtys(conn)
    log("conn close", "live=" + conns.size)
  })
  conn.on("error", () => {
    /* close 会跟着触发，统一在 close 清理 */
  })
})

function killAllAndExit(code) {
  for (const conn of conns) killConnPtys(conn)
  conns.clear()
  try { server.close() } catch { /* ignore */ }
  try { fs.unlinkSync(SOCK_PATH) } catch { /* ignore */ }
  log("exit", code)
  process.exit(code)
}

process.on("SIGTERM", () => killAllAndExit(0))
process.on("SIGINT", () => killAllAndExit(0))
process.on("uncaughtException", (e) => {
  log("UNCAUGHT", e?.stack || String(e))
})
process.on("unhandledRejection", (e) => {
  log("UNHANDLED", e?.stack || String(e))
})

ensureDir()

// 单实例保护：socket 文件存在时先探测是否真的有活着的守护。活着就退出让位，
// 死文件（上次异常退出的残留）才 unlink 后重新 bind。
function probeExisting() {
  return new Promise((resolve) => {
    let sockPath
    try {
      sockPath = fs.statSync(SOCK_PATH)
    } catch {
      resolve("missing")
      return
    }
    if (!sockPath.isSocket()) {
      resolve("not-socket")
      return
    }
    const probe = net.connect(SOCK_PATH)
    const done = (result) => {
      probe.destroy()
      resolve(result)
    }
    probe.setTimeout(500, () => done("dead"))
    probe.on("connect", () => {
      probe.write(JSON.stringify({ t: "ping" }) + "\n")
      probe.on("data", () => done("alive"))
    })
    probe.on("error", () => done("dead"))
  })
}

const existing = await probeExisting()
if (existing === "alive") {
  log("another spawnd owns the socket, exiting")
  process.exit(0)
}
try { fs.unlinkSync(SOCK_PATH) } catch { /* ignore */ }

server.listen(SOCK_PATH, () => {
  try { fs.chmodSync(SOCK_PATH, 0o600) } catch { /* ignore */ }
  log("listening", SOCK_PATH)
})
server.on("error", (e) => {
  log("server error", e?.stack || String(e))
  process.exit(1)
})
