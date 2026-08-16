// spawnd 客户端：host 启动时与守护握手，握手完成的 PTY 走守护（launchd 责任链，
// 下载不再被 macOS 打隔离标记），守护不存在则回退到进程内 spawn（与旧行为一致）。
// startPty 必须保持同步签名，因此就绪探测在 host 启动时异步完成；spawn 帧的
// 写入先缓冲，等守护回 ok 再 flush。
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { log } from "./log.js"

const SOCK_PATH = process.env.OMEETY_SPAWND_SOCK || path.join(os.homedir(), ".omeety", "spawnd.sock")
const CONNECT_TIMEOUT_MS = 400
const PONG_TIMEOUT_MS = 400
const RETRY_COOLDOWN_MS = 5000
const WRITE_BUFFER_CAP = 1024 * 1024

let sock = null
let state = "init" // init | ready | disabled
let initPromise = null
let lastAttempt = 0
let buf = ""

// sid -> { onOutput, onExit, buffered: string[], flushed: boolean }
const sessions = new Map()

function setState(next, reason) {
  if (state === next) return
  log("spawnd client", state, "->", next, reason || "")
  state = next
}

function send(obj) {
  try {
    sock.write(JSON.stringify(obj) + "\n")
  } catch {
    /* 连接已坏，close 事件会统一清理 */
  }
}

function handleFrame(msg) {
  if (msg.t === "d") {
    const s = sessions.get(msg.sid)
    if (s && s.flushed) s.onOutput(String(msg.s ?? ""))
    return
  }
  if (msg.t === "exit") {
    const s = sessions.get(msg.sid)
    if (s) {
      sessions.delete(msg.sid)
      s.flushed = true
      s.onExit(Number(msg.code) || 0)
    }
    return
  }
  if (msg.t === "ok") {
    const s = sessions.get(msg.sid)
    if (s && !s.flushed) {
      s.flushed = true
      for (const chunk of s.buffered) send({ t: "w", sid: msg.sid, s: chunk })
      s.buffered = null
    }
    return
  }
  if (msg.t === "err") {
    const s = sessions.get(msg.sid)
    if (s) {
      log("spawnd spawn err", msg.sid, String(msg.msg || ""))
      sessions.delete(msg.sid)
      s.flushed = true
      s.onExit(1)
    }
  }
}

function onSocketClose() {
  // 守护消失或连接断开：该连接上的 PTY 已被守护杀掉，向 host 补发退出事件，
  // 并允许下次 startPty 在冷却期后重新握手。
  sock = null
  buf = ""
  setState("disabled", "socket closed")
  for (const [sid, s] of sessions) {
    s.flushed = true
    try { s.onExit(1) } catch { /* ignore */ }
    log("spawnd conn lost, synthetic exit", sid)
  }
  sessions.clear()
}

export function initSpawndClient() {
  if (state === "ready") return Promise.resolve(true)
  if (initPromise) return initPromise
  if (Date.now() - lastAttempt < RETRY_COOLDOWN_MS) return Promise.resolve(false)
  lastAttempt = Date.now()
  initPromise = new Promise((resolve) => {
    let settled = false
    const finish = (result, reason) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(pongTimer)
      if (!result) {
        setState("disabled", reason)
        try { conn.destroy() } catch { /* ignore */ }
        resolve(false)
      } else {
        resolve(true)
      }
    }
    let conn
    try {
      conn = net.connect(SOCK_PATH)
    } catch {
      finish(false, "connect threw")
      return
    }
    const connectTimer = setTimeout(() => finish(false, "connect timeout"), CONNECT_TIMEOUT_MS)
    const pongTimer = setTimeout(() => finish(false, "pong timeout"), PONG_TIMEOUT_MS + CONNECT_TIMEOUT_MS)
    conn.on("connect", () => {
      conn.write(JSON.stringify({ t: "ping" }) + "\n")
    })
    conn.on("data", (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.t === "pong" && !settled && state !== "ready") {
          sock = conn
          conn.on("close", onSocketClose)
          conn.on("error", () => { /* close 统一清理 */ })
          setState("ready", "handshake ok")
          finish(true)
        } else if (state === "ready") {
          handleFrame(msg)
        }
      }
    })
    conn.on("error", (e) => {
      if (!settled) finish(false, "connect error: " + (e?.code || e?.message))
    })
  }).finally(() => {
    initPromise = null
  })
  return initPromise
}

// host 启动时调用一次：尽快完成握手，让第一批 spawnShell 就能走守护。
export function warmSpawnd() {
  try {
    fs.statSync(SOCK_PATH).isSocket()
  } catch {
    setState("disabled", "no socket file")
    return
  }
  initSpawndClient()
}

export function spawndReady() {
  return state === "ready" && sock && !sock.destroyed
}

export function startPtyViaDaemon({ shell, args, cols, rows, cwd, env, onOutput, onExit }) {
  const sid = "c" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36)
  const session = { onOutput, onExit, buffered: [], flushed: false }
  sessions.set(sid, session)
  send({
    t: "spawn",
    sid,
    shell,
    args: args || [],
    cols,
    rows,
    cwd,
    env,
  })
  return {
    via: "spawnd",
    write: (s) => {
      if (session.flushed) send({ t: "w", sid, s })
      else if (session.buffered) {
        // 守护还没回 ok：先缓冲，ok 帧到达后按序 flush。
        if (session.buffered.join("").length + s.length <= WRITE_BUFFER_CAP) session.buffered.push(s)
      }
    },
    resize: (c, r) => send({ t: "resize", sid, c, r }),
    kill: () => send({ t: "kill", sid }),
  }
}
