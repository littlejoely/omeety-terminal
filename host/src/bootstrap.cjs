// native messaging host 入口（CJS 包装）。
// 为什么需要它：native messaging 是黑盒——stdout 被协议占用、stderr 在浏览器拉起的进程里常被吞，
// 一旦 ESM import（如 node-pty）失败，进程静默退出、日志全空、无从排查。
// 所以用 CJS（无 import 提升）先动态加载 ESM 的 index.js 并 try/catch，把失败栈落盘。
// 精简版：只记启动/异常，不 dump 环境。
const fs = require("node:fs")
const path = require("node:path")
const LOG = path.join(__dirname, "..", "host-debug.log")
function log(s) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${s}\n`)
  } catch {
    /* 落盘不能影响 host */
  }
}
process.on("uncaughtException", (e) => {
  log("UNCAUGHT " + (e && (e.stack || e)))
  process.exit(1)
})
process.on("unhandledRejection", (e) => {
  log("UNHANDLED " + (e && (e.stack || e)))
})
log("boot pid=" + process.pid + " node=" + process.version)
import("./index.js").catch((e) => {
  log("index.js FAILED " + (e && (e.stack || e)))
  process.exit(1)
})
