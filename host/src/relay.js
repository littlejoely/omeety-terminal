// tool_call ↔ tool_result 关联表。MCP 工具调用经 native 通道转发到扩展，等 tool_result 回来。
import { randomUUID } from "node:crypto"
import { log } from "./log.js"

const pending = new Map() // id -> { resolve, timer }

export function relayCall(nmSend, name, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const id = randomUUID()
    log("relay OUT tool_call", name, "id=" + id)
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        log("relay TIMEOUT", name, "id=" + id)
        resolve({ ok: false, error: `tool_call timeout: ${name}` })
      }
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    nmSend({ type: "tool_call", id, name, args })
  })
}

export function resolveResult({ id, ok, result, error }) {
  const entry = pending.get(id)
  log("relay IN tool_result", "id=" + id, "ok=" + ok, "err=" + (error === undefined ? "<undef>" : String(error).slice(0, 80)), "resultType=" + (result === undefined ? "undef" : Array.isArray(result) ? "array" : typeof result), "found=" + !!entry)
  if (!entry) return // 已超时丢弃
  clearTimeout(entry.timer)
  pending.delete(id)
  entry.resolve({ ok: !!ok, result, error })
}
