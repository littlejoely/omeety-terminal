#!/bin/zsh
# Omeety Terminal macOS 卸载器：移除 Native Messaging 注册和 Agent MCP 配置。

set -eu

script_dir="${0:A:h}"
node_bin="$(command -v node 2>/dev/null || true)"
nm_name="com.omeety.terminal"
user_home="${OMEETY_HOME:-${HOME}}"

for browser_dir in \
  "${user_home}/Library/Application Support/Google/Chrome" \
  "${user_home}/Library/Application Support/Microsoft Edge" \
  "${user_home}/Library/Application Support/Chromium"; do
  manifest="${browser_dir}/NativeMessagingHosts/${nm_name}.json"
  if [[ -f "${manifest}" ]]; then
    rm "${manifest}"
    echo "✓ 已移除 ${manifest}"
  fi
done

if [[ -n "${node_bin}" ]]; then
  "${node_bin}" - "${user_home}" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")
const home = process.argv[2]
const id = "omeety_terminal"

const claude = path.join(home, ".claude.json")
if (fs.existsSync(claude)) {
  try {
    const data = JSON.parse(fs.readFileSync(claude, "utf8"))
    if (data.mcpServers && Object.hasOwn(data.mcpServers, id)) {
      delete data.mcpServers[id]
      fs.writeFileSync(claude, JSON.stringify(data, null, 2) + "\n")
      console.log("✓ 已从 ~/.claude.json 移除 omeety_terminal")
    }
  } catch (error) { console.error("! .claude.json 处理失败：" + error.message) }
}

for (const dir of [".codex", ".kimi-code"]) {
  const file = path.join(home, dir, "config.toml")
  if (!fs.existsSync(file)) continue
  const text = fs.readFileSync(file, "utf8")
  const next = text.replace(/\n?\[mcp_servers\.omeety_terminal\][\s\S]*?(?=^\[|\s*$)/m, "")
  if (next !== text) {
    fs.writeFileSync(file, next)
    console.log(`✓ 已从 ~/${dir}/config.toml 移除 omeety_terminal`)
  }
}
NODE
fi

echo "卸载完成。扩展目录、依赖和备份文件均已保留。"
