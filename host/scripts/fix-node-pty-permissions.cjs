// npm 在部分 macOS 环境解包 node-pty 预编译包后会丢失 spawn-helper 的可执行位，
// 随后所有 PTY spawn 都只报模糊的 `posix_spawnp failed`。安装后主动修正。
if (process.platform !== "win32") {
  const fs = require("node:fs")
  const path = require("node:path")
  const prebuilds = path.join(__dirname, "..", "node_modules", "node-pty", "prebuilds")

  try {
    for (const platformDir of fs.readdirSync(prebuilds)) {
      if (!platformDir.startsWith("darwin-")) continue
      const helper = path.join(prebuilds, platformDir, "spawn-helper")
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
    }
  } catch (error) {
    console.warn(`[omeety] 无法修正 node-pty spawn-helper 权限：${error.message}`)
  }
}
