# Omeety Terminal 安装器：注册 native messaging host（Edge+Chrome）+ 把 MCP 写进各 AI 配置。
# 用法：  powershell -ExecutionPolicy Bypass -File install.ps1
# 仅写 HKCU（免管理员）。固定扩展 ID = fjhjkmpldbepgcpfkhpolnnheccjaamg（由 manifest key 派生）。

param(
  [string] $ProjectRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [int]    $McpPort  = 49171,
  [string] $NmName   = "com.omeety.terminal",
  [string] $ExtId    = "fjhjkmpldbepgcpfkhpolnnheccjaamg",
  [switch] $Force
)

$ErrorActionPreference = "Stop"
$HostDir      = Join-Path $ProjectRoot "host"
$IndexJs      = Join-Path $HostDir "src\index.js"
$ManifestPath = Join-Path $HostDir "host-manifest.json"
$McpUrl       = "http://127.0.0.1:$McpPort/mcp"

function Write-Step($m){ Write-Host "» $m" -ForegroundColor Cyan }
function Write-Ok($m){ Write-Host "  ✓ $m" -ForegroundColor Green }

# ---------- 0. 前置检查 ----------
Write-Step "检查 Node"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node -or -not (Test-Path $node)) { $node = "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $node)) { throw "找不到 node.exe。请先装 Node.js（LTS）。" }
Write-Ok "node = $node"

Write-Step "安装 host 依赖（node-pty / MCP SDK / express / undici）"
$requiredModules = @("node-pty", "@modelcontextprotocol\sdk", "express", "undici")
$missingModule = $requiredModules | Where-Object { -not (Test-Path (Join-Path $HostDir "node_modules\$_")) } | Select-Object -First 1
if ($missingModule) {
  Push-Location $HostDir
  try { & $node (Join-Path (Split-Path $node) "npm.cmd") install --no-audit --no-fund 2>&1 | Out-Null }
  finally { Pop-Location }
  if (-not (Test-Path (Join-Path $HostDir "node_modules"))) { throw "npm install 失败" }
  Write-Ok "依赖已安装"
} else { Write-Ok "依赖已存在，跳过" }

# ---------- 1. 生成 run-host.bat（包装脚本）+ host-manifest.json ----------
# 关键：Chromium/Edge 的 native messaging host manifest **不支持 args 字段**。
# 若 path=node.exe + args=[xxx.js]，浏览器会启动“裸 node”（拿不到脚本）→ 立即退出 →
# “Error when communicating with the native messaging host”(-101)。
# 正解：path 指向一个把启动命令写死的包装脚本（.bat），浏览器用 cmd /c 启动它。
Write-Step "生成 run-host.bat（native host 包装脚本，命令写死）"
$RunBat = Join-Path $HostDir "run-host.bat"
$batLines = @(
  '@echo off',
  'REM Omeety Terminal native messaging host launcher.',
  'REM Chrome/Edge launch this .bat via cmd /c as the native host path.',
  'REM Native messaging host manifest has no args field, so the command is baked here.',
  "`"$node`" `"%~dp0src\bootstrap.cjs`""
)
# WriteAllLines：CRLF、UTF-8 无 BOM（cmd 按 OEM 代码页读 .bat，ASCII 内容最稳）
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($RunBat, $batLines, $utf8NoBom)
Write-Ok $RunBat

Write-Step "生成 host-manifest.json（path=run-host.bat，无 args）"
$manifest = [ordered]@{
  name            = $NmName
  description     = "Omeety Terminal native host (PTY + browser-control MCP)"
  path            = $RunBat
  type            = "stdio"
  allowed_origins = @("chrome-extension://$ExtId/")
}
$json = $manifest | ConvertTo-Json -Depth 6
# .NET 写 UTF-8 无 BOM（PS5.1 的 Out-File -Encoding utf8 会带 BOM）
[System.IO.File]::WriteAllText($ManifestPath, $json, $utf8NoBom)
Write-Ok $ManifestPath

# ---------- 2. 注册表（Edge + Chrome）----------
Write-Step "注册 native messaging host（HKCU，Edge + Chrome）"
$hosts = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NmName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$NmName"
)
foreach ($k in $hosts) {
  New-Item -Path $k -Force | Out-Null
  Set-ItemProperty -Path $k -Name "(default)" -Value $ManifestPath
  Write-Ok $k
}

# ---------- 3. 写各 agent 的 MCP 配置（交给 node，PS 5.1 的 JSON 解析对大 .claude.json 不稳）----------
Write-Step "配置 Claude / Codex / Kimi 的 MCP（Streamable HTTP $McpUrl）"
$cfg = & $node (Join-Path $PSScriptRoot "configure-agents.cjs") $McpUrl
Write-Host $cfg

# ---------- 4. 完成 ----------
Write-Host ""
Write-Host "安装完成。" -ForegroundColor Green
Write-Host "下一步："
Write-Host "  1) edge://extensions 开发者模式 → 加载已解压 → 选 $ProjectRoot\extension"
Write-Host "  2) 扩展 ID 应为 $ExtId（manifest key 固定）"
Write-Host "  3) 点扩展图标开侧栏 → 终端里敲 claude / codex / kimi"
Write-Host "  4) MCP 地址：$McpUrl"
Write-Host "  5) Omeety 终端内可用：omeety download <URL>（开始前仍需在侧栏确认）"
