// 给各 CLI agent 写入 omeety_terminal MCP（Streamable HTTP）。
// 由 install.ps1 调用：node configure-agents.cjs <mcpUrl>
// 用 node 做 JSON（PS 5.1 的 ConvertFrom-Json 对大 .claude.json 不稳）。
const fs = require("fs")
const path = require("path")
const os = require("os")

const url = process.argv[2]
const ID = "omeety_terminal"
const HOME = process.env.OMEETY_HOME || os.homedir() // 测试用：OMEETY_HOME 指向临时目录
if (!url) {
  console.error("用法: node configure-agents.cjs <mcpUrl>")
  process.exit(2)
}

function ts() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
function backup(p) {
  try {
    fs.copyFileSync(p, `${p}.bak-${ts()}`)
  } catch {
    /* ignore */
  }
}

// ---- Claude：.claude.json 顶层 mcpServers ----
const claude = path.join(HOME, ".claude.json")
if (fs.existsSync(claude)) {
  try {
    backup(claude)
    const j = JSON.parse(fs.readFileSync(claude, "utf8"))
    j.mcpServers = j.mcpServers || {}
    j.mcpServers[ID] = { type: "http", url }
    fs.writeFileSync(claude, JSON.stringify(j, null, 2))
    console.log(`claude: ok -> mcpServers.${ID} = {type:http, url}`)
  } catch (e) {
    console.error("claude: FAILED", e.message)
  }
} else {
  console.log("claude: ~/.claude.json 不存在，跳过（先运行一次 claude）")
}

// ---- TOML（codex / kimi）：[mcp_servers.omeety_terminal] url=...  幂等 ----
function setToml(text, blockLines) {
  const lines = text.split(/\r?\n/)
  const out = []
  let i = 0
  let replaced = false
  while (i < lines.length) {
    if (lines[i].trim() === `[mcp_servers.${ID}]`) {
      // 跳过旧块（到下一个 [section] 或 EOF）
      i++
      while (i < lines.length && !/^\s*\[.+\]/.test(lines[i])) i++
      out.push(...blockLines)
      replaced = true
      continue
    }
    out.push(lines[i])
    i++
  }
  let res = out.join("\r\n")
  if (!replaced) {
    if (res && !res.endsWith("\r\n")) res += "\r\n"
    res += "\r\n" + blockLines.join("\r\n") + "\r\n"
  }
  return res
}

for (const [label, dir] of [["codex", ".codex"], ["kimi", ".kimi-code"]]) {
  const toml = path.join(HOME, dir, "config.toml")
  if (!fs.existsSync(toml)) {
    console.log(`${label}: ${dir}\\config.toml 不存在，跳过`)
    continue
  }
  try {
    backup(toml)
    const block = [`[mcp_servers.${ID}]`, `url = "${url}"`]
    const next = setToml(fs.readFileSync(toml, "utf8"), block)
    fs.writeFileSync(toml, next)
    console.log(`${label}: ok -> [mcp_servers.${ID}] url=${url}`)
  } catch (e) {
    console.error(`${label}: FAILED`, e.message)
  }
}
