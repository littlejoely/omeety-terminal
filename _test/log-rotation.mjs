import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omeety-log-rotation-"))
const logPath = path.join(dir, "host-debug.log")
process.env.OMEETY_LOG_PATH = logPath
process.env.OMEETY_LOG_MAX_BYTES = "1024"
process.env.OMEETY_LOG_BACKUPS = "2"

try {
  const { log } = await import(`../host/src/log.js?rotation-test=${Date.now()}`)
  for (let index = 0; index < 120; index += 1) log("rotation-test", index, "x".repeat(80))

  const files = fs.readdirSync(dir).sort()
  assert.deepEqual(files, ["host-debug.log", "host-debug.log.1", "host-debug.log.2"])
  for (const file of files) {
    assert.ok(fs.statSync(path.join(dir, file)).size <= 1200, `${file} should stay near the configured limit`)
  }
  console.log("PASS host log rotation: 3 capped files total")
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
