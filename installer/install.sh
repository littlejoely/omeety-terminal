#!/bin/zsh
# Omeety Terminal macOS 安装器：准备 host 依赖、注册 Chrome/Edge/Chromium Native Messaging、配置 Agent MCP。

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

clear_project_quarantine() {
  # 从浏览器/聊天工具解压的源码目录可能携带 quarantine。若不清理，
  # 后续通过真实 PTY 执行 npm/pip 时，新生成的原生依赖也会继承该标记，
  # macOS 就会反复弹出安全审查。这里只处理 Omeety 自己的项目目录。
  if command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "${project_root}" 2>/dev/null || true
  fi
}

step "清理浏览器下载隔离标记"
clear_project_quarantine
ok "Omeety 项目目录已就绪"

step "检查 Node.js"
node_bin="$(command -v node 2>/dev/null || true)"
npm_bin="$(command -v npm 2>/dev/null || true)"
if [[ -z "${node_bin}" || -z "${npm_bin}" ]]; then
  print -u2 "未找到 node/npm。请先安装 Node.js（建议 LTS）。"
  exit 1
fi
ok "node = ${node_bin} ($(${node_bin} --version))"

step "准备 host 依赖"
missing_module=""
for module_path in \
  "node-pty" \
  "@modelcontextprotocol/sdk" \
  "express" \
  "undici"; do
  if [[ ! -d "${host_dir}/node_modules/${module_path}" ]]; then
    missing_module="${module_path}"
    break
  fi
done
if [[ -n "${missing_module}" ]]; then
  (cd "${host_dir}" && "${npm_bin}" install --no-audit --no-fund)
  clear_project_quarantine
  ok "依赖已安装"
else
  ok "离线依赖已存在，跳过 npm install"
fi
"${node_bin}" "${host_dir}/scripts/fix-node-pty-permissions.cjs"
ok "node-pty / MCP SDK / Express / undici 已就绪"

if [[ "$(uname -s)" == "Darwin" ]]; then
  step "安装 PTY 守护（spawnd）"
  # macOS 会给 Chrome 进程树下写出的网络文件打 com.apple.quarantine（责任进程归因），
  # host 与其 PTY 子进程全部中招：brew/npm 下载的二进制会被 Gatekeeper 击杀。
  # spawnd 由 launchd 拉起（launchd 责任链），PTY 内下载不再带标记，与 Terminal.app 一致。
  spawnd_entry="${host_dir}/src/spawnd.js"
  omeety_dir="${user_home}/.omeety"
  spawnd_plist="${user_home}/Library/LaunchAgents/com.omeety.spawnd.plist"
  mkdir -p "${omeety_dir}"
  {
    print '<?xml version="1.0" encoding="UTF-8"?>'
    print '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    print '<plist version="1.0"><dict>'
    print '  <key>Label</key><string>com.omeety.spawnd</string>'
    printf '  <key>ProgramArguments</key><array><string>%s</string><string>%s</string></array>\n' "${node_bin}" "${spawnd_entry}"
    print '  <key>RunAtLoad</key><true/>'
    print '  <key>KeepAlive</key><true/>'
    print '  <key>ProcessType</key><string>Interactive</string>'
    print '</dict></plist>'
  } > "${spawnd_plist}"
  spawnd_label="com.omeety.spawnd"
  if ! plutil -lint "${spawnd_plist}" >/dev/null 2>&1; then
    print -u2 "spawnd plist 生成异常，跳过守护安装。终端仍可用（走进程内 PTY）。"
  else
    launchctl bootout "gui/$(id -u)/${spawnd_label}" 2>/dev/null || true
    if ! launchctl bootstrap "gui/$(id -u)" "${spawnd_plist}"; then
      print -u2 "spawnd bootstrap 失败（日志：${omeety_dir}/spawnd.log）。终端仍可用（走进程内 PTY）。"
    else
      launchctl kickstart -k "gui/$(id -u)/${spawnd_label}" 2>/dev/null || true
      spawnd_sock="${omeety_dir}/spawnd.sock"
      spawnd_up=0
      for i in 1 2 3 4 5 6 7 8 9 10; do
        [[ -S "${spawnd_sock}" ]] && { spawnd_up=1; break; }
        sleep 0.5
      done
      if (( spawnd_up )); then
        ok "spawnd 已运行（${spawnd_sock}）"
      else
        print -u2 "spawnd 未就绪（日志：${omeety_dir}/spawnd.log）。终端仍可用（走进程内 PTY）。"
      fi
    fi
  fi
fi

step "生成 Native Messaging 启动脚本"
{
  print '#!/bin/zsh'
  printf 'exec %q %q\n' "${node_bin}" "${bootstrap}"
} > "${run_host}"
chmod 755 "${run_host}"
chmod 755 "${host_dir}/bin/omeety.js"
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
print "  1) Chrome/Chromium 打开 chrome://extensions；Edge 打开 edge://extensions，并启用开发者模式"
print "  2) 加载已解压的扩展：${project_root}/extension"
print "  3) 确认扩展 ID：${extension_id}"
print "  4) 点击扩展图标打开侧栏，默认使用系统 zsh"
print "  5) Omeety 终端内可用：omeety download <URL>（开始前仍需在侧栏确认）"
