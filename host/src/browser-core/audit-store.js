import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { redactAuditValue } from "./policy-engine.js"

function defaultAuditPath() {
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "Omeety Terminal", "browser-audit.jsonl")
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Omeety Terminal", "browser-audit.jsonl")
  }
  return path.join(os.homedir(), ".local", "state", "omeety-terminal", "browser-audit.jsonl")
}

const DEFAULT_PATH = defaultAuditPath()

export class AuditStore {
  constructor({ filePath = process.env.OMEETY_BROWSER_AUDIT_PATH || DEFAULT_PATH, maxBytes = 5 * 1024 * 1024 } = {}) {
    this.filePath = filePath
    this.maxBytes = maxBytes
    this.recent = []
  }

  append(entry) {
    const safe = redactAuditValue({ ...entry, at: entry.at || new Date().toISOString() })
    this.recent.push(safe)
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200)
    try {
      const line = `${JSON.stringify(safe)}\n`
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
      let size = 0
      try { size = fs.statSync(this.filePath).size } catch { /* first write */ }
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        try { fs.rmSync(`${this.filePath}.1`, { force: true }) } catch { /* ignore */ }
        try { fs.renameSync(this.filePath, `${this.filePath}.1`) } catch { /* ignore */ }
      }
      fs.appendFileSync(this.filePath, line, { encoding: "utf8", mode: 0o600 })
    } catch {
      /* Auditing must never break browser control. */
    }
  }

  list(limit = 50) {
    return this.recent.slice(-Math.min(Math.max(Number(limit) || 50, 1), 200))
  }
}
