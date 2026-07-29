// npm/ZIP 在部分 macOS 环境解包 node-pty 预编译包后会丢失 spawn-helper 的
// 可执行位；浏览器下载的离线包还会继承 quarantine，导致 pty.node 被系统拒绝
// 加载。安装时仅对随包提供的 node-pty 目录主动修正这两项。
if (process.platform !== "win32") {
  const { spawnSync } = require("node:child_process")
  const fs = require("node:fs")
  const path = require("node:path")
  const nodePty = path.join(__dirname, "..", "node_modules", "node-pty")
  const prebuilds = path.join(nodePty, "prebuilds")

  try {
    for (const platformDir of fs.readdirSync(prebuilds)) {
      if (!platformDir.startsWith("darwin-")) continue
      const helper = path.join(prebuilds, platformDir, "spawn-helper")
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
    }
  } catch (error) {
    console.warn(`[omeety] 无法修正 node-pty spawn-helper 权限：${error.message}`)
  }

  if (process.platform === "darwin" && fs.existsSync(nodePty)) {
    const result = spawnSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", nodePty], {
      encoding: "utf8",
    })
    if (result.error || result.status !== 0) {
      const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`
      console.warn(`[omeety] 无法清理 node-pty quarantine：${detail}`)
    }
  }
}
