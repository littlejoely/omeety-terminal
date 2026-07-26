// 临时调试日志：写到文件。
// 原因：stdout 被 native messaging 协议占用（只能写 4 字节长度前缀帧），stderr 在 Edge 拉起的隐藏进程里常常被吞。
// 所以 host 崩在哪、走到哪一步，只能落盘才知道。用完可删，或保留作可选诊断。
// 路径：host/host-debug.log
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_PATH = path.join(__dirname, "..", "host-debug.log")

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
    fs.appendFileSync(LOG_PATH, `[${ts()}] ${parts.join(" ")}\n`, "utf8")
  } catch {
    /* 日志本身绝不能影响 host 运行 */
  }
}
