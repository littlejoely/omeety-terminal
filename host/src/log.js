// 临时调试日志：写到文件。
// 原因：stdout 被 native messaging 协议占用（只能写 4 字节长度前缀帧），stderr 在 Edge 拉起的隐藏进程里常常被吞。
// 所以 host 崩在哪、走到哪一步，只能落盘才知道。用完可删，或保留作可选诊断。
// 路径：host/host-debug.log
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_PATH = process.env.OMEETY_LOG_PATH || path.join(__dirname, "..", "host-debug.log")
const MAX_LOG_BYTES = Math.max(1024, Number(process.env.OMEETY_LOG_MAX_BYTES) || 20 * 1024 * 1024)
const LOG_BACKUPS = Math.max(1, Math.min(10, Number(process.env.OMEETY_LOG_BACKUPS) || 2))
let currentBytes = (() => {
  try { return fs.statSync(LOG_PATH).size } catch { return 0 }
})()

function rotateIfNeeded(incomingBytes) {
  if (currentBytes + incomingBytes <= MAX_LOG_BYTES) return
  for (let index = LOG_BACKUPS; index >= 1; index -= 1) {
    const source = index === 1 ? LOG_PATH : `${LOG_PATH}.${index - 1}`
    const target = `${LOG_PATH}.${index}`
    try { fs.rmSync(target, { force: true }) } catch { /* ignore */ }
    try { fs.renameSync(source, target) } catch { /* source may not exist */ }
  }
  currentBytes = 0
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
    fs.appendFileSync(LOG_PATH, line, "utf8")
    currentBytes += bytes
  } catch {
    /* 日志本身绝不能影响 host 运行 */
  }
}
