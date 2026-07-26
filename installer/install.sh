#!/bin/zsh
# Omeety Terminal macOS 安装器：安装 host 依赖、注册 Chrome Native Messaging、配置 Agent MCP。

set -eu

script_dir="${0:A:h}"
project_root="${OMEETY_PROJECT_ROOT:-${script_dir:h}}"
user_home="${OMEETY_HOME:-${HOME}}"
host_dir="${project_root}/host"
bootstrap="${host_dir}/src/bootstrap.cjs"
run_host="${host_dir}/run-host.sh"
manifest_source="${host_dir}/host-manifest.json"
mcp_port="${OMEETY_MCP_PORT:-49171}"
nm_name="com.omeety.terminal"
extension_id="fjhjkmpldbepgcpfkhpolnnheccjaamg"
mcp_url="http://127.0.0.1:${mcp_port}/mcp"

step() { print -P "%F{cyan}» $1%f" }
ok() { print -P "%F{green}  ✓ $1%f" }

step "检查 Node.js"
node_bin="$(command -v node 2>/dev/null || true)"
npm_bin="$(command -v npm 2>/dev/null || true)"
if [[ -z "${node_bin}" || -z "${npm_bin}" ]]; then
  print -u2 "未找到 node/npm。请先安装 Node.js（建议 LTS）。"
  exit 1
fi
ok "node = ${node_bin} ($(${node_bin} --version))"

step "安装 host 依赖"
(cd "${host_dir}" && "${npm_bin}" install --no-audit --no-fund)
ok "node-pty / MCP SDK / Express 已就绪"

step "生成 Native Messaging 启动脚本"
{
  print '#!/bin/zsh'
  printf 'exec %q %q\n' "${node_bin}" "${bootstrap}"
} > "${run_host}"
chmod 755 "${run_host}"
ok "${run_host}"

step "生成 Native Messaging manifest"
"${node_bin}" -e '
const fs = require("node:fs")
const [out, name, hostPath, extensionId] = process.argv.slice(1)
fs.writeFileSync(out, JSON.stringify({
  name,
  description: "Omeety Terminal native host (PTY + browser-control MCP)",
  path: hostPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, 2) + "\n")
' "${manifest_source}" "${nm_name}" "${run_host}" "${extension_id}"

registered=0
for browser_dir in \
  "${user_home}/Library/Application Support/Google/Chrome" \
  "${user_home}/Library/Application Support/Microsoft Edge" \
  "${user_home}/Library/Application Support/Chromium"; do
  if [[ -d "${browser_dir}" ]]; then
    target_dir="${browser_dir}/NativeMessagingHosts"
    mkdir -p "${target_dir}"
    cp "${manifest_source}" "${target_dir}/${nm_name}.json"
    ok "${target_dir}/${nm_name}.json"
    registered=$((registered + 1))
  fi
done
if (( registered == 0 )); then
  print -u2 "未检测到 Chrome、Edge 或 Chromium 用户目录。请先启动浏览器一次后重试。"
  exit 1
fi

step "配置 Claude / Codex / Kimi 的 MCP"
"${node_bin}" "${script_dir}/configure-agents.cjs" "${mcp_url}"

print ""
print -P "%F{green}安装完成。%f"
print "下一步："
print "  1) 打开 chrome://extensions 并启用开发者模式"
print "  2) 加载已解压的扩展：${project_root}/extension"
print "  3) 确认扩展 ID：${extension_id}"
print "  4) 点击扩展图标打开侧栏，默认使用系统 zsh"
