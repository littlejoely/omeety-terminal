// 临时调试日志：写到文件（异步批量，避免阻塞 host 事件循环）。
// 原因：stdout 被 native messaging 协议占用（只能写 4 字节长度前缀帧），stderr 在 Edge 拉起的隐藏进程里常常被吞。
// 所以 host 崩在哪、走到哪一步，只能落盘才知道。用完可删，或保留作可选诊断。
// 性能：早期版本每次 log() 都 fs.appendFileSync（同步），relay 每个 tool_call 进/出各一条，
// 高频工具调用时同步 IO 阻塞事件循环 → host 响应卡顿。改为 writeStream + 100ms 批刷。
// 路径：host/host-debug.log
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_PATH = process.env.OMEETY_LOG_PATH || path.join(__dirname, "..", "host-debug.log")
const MAX_LOG_BYTES = Math.max(1024, Number(process.env.OMEETY_LOG_MAX_BYTES) || 20 * 1024 * 1024)
const LOG_BACKUPS = Math.max(1, Math.min(10, Number(process.env.OMEETY_LOG_BACKUPS) || 2))
const FLUSH_INTERVAL_MS = 100

let currentBytes = (() => {
  try { return fs.statSync(LOG_PATH).size } catch { return 0 }
})()

let stream = createStream()
let pending = []
let flushTimer = null
let rotating = false

function createStream() {
  const s = fs.createWriteStream(LOG_PATH, { flags: "a" })
  // 日志绝不能反过来搞崩 host：吞掉所有写错误（盘满/权限/文件被占用）。
  s.on("error", () => { /* 静默 */ })
  return s
}

function flushNow() {
  if (!pending.length || rotating) return
  const block = pending.join("")
  pending.length = 0
  try { stream.write(block) } catch { /* ignore */ }
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushNow()
  }, FLUSH_INTERVAL_MS)
  flushTimer.unref?.() // 不阻塞进程退出
}

function rotateIfNeeded(incomingBytes) {
  if (rotating) return
  if (currentBytes + incomingBytes <= MAX_LOG_BYTES) return
  rotating = true
  // 先把缓冲刷掉 → 关旧 stream → rename 滚动 → 开新 stream。
  // 期间 rotating=true，flushNow 被 guard 跳过，新日志暂存 pending，rotate 完下个 tick 刷进新 stream。
  flushNow()
  stream.end(() => {
    try {
      for (let index = LOG_BACKUPS; index >= 1; index -= 1) {
        const source = index === 1 ? LOG_PATH : `${LOG_PATH}.${index - 1}`
        const target = `${LOG_PATH}.${index}`
        try { fs.rmSync(target, { force: true }) } catch { /* ignore */ }
        try { fs.renameSync(source, target) } catch { /* source may not exist */ }
      }
    } catch { /* ignore */ }
    currentBytes = 0
    stream = createStream()
    rotating = false
    scheduleFlush() // rotate 期间累积的 pending 刷进新 stream
  })
}

function ts() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`
  )
}

export function log(...args) {
  try {
    const parts = args.map((a) => {
      if (a instanceof Error) return a.stack || String(a)
      if (typeof a === "object" && a !== null) {
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      }
      return String(a)
    })
    const line = `[${ts()}] ${parts.join(" ")}\n`
    const bytes = Buffer.byteLength(line, "utf8")
    rotateIfNeeded(bytes)
    currentBytes += bytes
    pending.push(line)
    scheduleFlush()
  } catch {
    /* 日志本身绝不能影响 host 运行 */
  }
}

// 进程退出前同步把剩余缓冲落盘（exit 回调只允许同步 API）。
process.on("exit", () => {
  if (!pending.length) return
  try { fs.appendFileSync(LOG_PATH, pending.join(""), "utf8") } catch { /* ignore */ }
})
