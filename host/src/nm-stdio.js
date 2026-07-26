// Native messaging 的 4 字节小端长度前缀 JSON 帧读写。
// 重要：host 绝不能用 console.log（污染 stdout）—— 日志一律 console.error → stderr。
import { stdin, stdout } from "node:process"

export function nmSend(obj) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8")
  if (buf.length > 1024 * 1024) {
    console.error(`[nm] 拒绝发送 >1MB 的消息 (type=${obj?.type}, ${buf.length}B)`)
    return
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(buf.length, 0)
  stdout.write(Buffer.concat([header, buf]))
}

export function startNmReader(onMessage) {
  let queue = Buffer.alloc(0)
  stdin.on("data", (chunk) => {
    queue = Buffer.concat([queue, chunk])
    while (queue.length >= 4) {
      const len = queue.readUInt32LE(0)
      if (queue.length < 4 + len) break // 半包，等更多
      const raw = queue.subarray(4, 4 + len)
      queue = queue.subarray(4 + len)
      let msg
      try {
        msg = JSON.parse(raw.toString("utf8"))
      } catch (e) {
        console.error("[nm] JSON 解析失败", e)
        continue
      }
      onMessage(msg)
    }
  })
}
