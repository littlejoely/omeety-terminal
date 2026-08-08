// 临时调试日志：写到文件（异步批量，避免阻塞 host 事件循环）。
// 原因：stdout 被 native messaging 协议占用（只能写 4 字节长度前缀帧），stderr 在 Edge 拉起的隐藏进程里常常被吞。
// 所以 host 崩在哪、走到哪一步，只能落盘才知道。用完可删，或保留作可选诊断。
// 性能：早期版本每次 log() 都 fs.appendFileSync（同步），relay 每个 tool_call 进/出各一条，
// 高频工具调用时同步 IO 阻塞事件循环 → host 响应卡顿。改为异步队列 + 100ms 批刷。
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

let pending = []
let flushTimer = null
let writeQueue = Promise.resolve()

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    enqueuePending()
  }, FLUSH_INTERVAL_MS)
  flushTimer.unref?.() // 不阻塞进程退出
}

async function rotateFiles() {
  for (let index = LOG_BACKUPS; index >= 1; index -= 1) {
    const source = index === 1 ? LOG_PATH : `${LOG_PATH}.${index - 1}`
    const target = `${LOG_PATH}.${index}`
    try { await fs.promises.rm(target, { force: true }) } catch { /* ignore */ }
    try { await fs.promises.rename(source, target) } catch { /* source may not exist */ }
  }
  currentBytes = 0
}

async function writeBatch(entries) {
  let index = 0
  while (index < entries.length) {
    if (currentBytes > 0 && currentBytes + entries[index].bytes > MAX_LOG_BYTES) {
      await rotateFiles()
    }

    const block = []
    let blockBytes = 0
    while (index < entries.length) {
      const entry = entries[index]
      const wouldOverflow = currentBytes + blockBytes > 0 && currentBytes + blockBytes + entry.bytes > MAX_LOG_BYTES
      if (wouldOverflow) break
      block.push(entry.line)
      blockBytes += entry.bytes
      index += 1
    }

    // 单行若大于上限，仍完整保留；下一行写入前会先轮转，避免拆坏 UTF-8/堆栈信息。
    if (!block.length) {
      const entry = entries[index]
      block.push(entry.line)
      blockBytes = entry.bytes
      index += 1
    }

    await fs.promises.appendFile(LOG_PATH, block.join(""), "utf8")
    currentBytes += blockBytes
    if (index < entries.length) await rotateFiles()
  }
}

function enqueuePending() {
  if (!pending.length) return writeQueue
  const batch = pending
  pending = []
  // 所有批次严格串行：轮转、重命名和追加不会交叉，日志本身的错误也不会影响 Host。
  writeQueue = writeQueue.then(() => writeBatch(batch)).catch(() => {})
  return writeQueue
}

export async function flushLogs() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  do {
    await enqueuePending()
    await writeQueue
  } while (pending.length)
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
    pending.push({ line, bytes })
    scheduleFlush()
  } catch {
    /* 日志本身绝不能影响 host 运行 */
  }
}

// 进程退出前同步把剩余缓冲落盘（exit 回调只允许同步 API）。
process.on("exit", () => {
  if (!pending.length) return
  try { fs.appendFileSync(LOG_PATH, pending.map((entry) => entry.line).join(""), "utf8") } catch { /* ignore */ }
})
