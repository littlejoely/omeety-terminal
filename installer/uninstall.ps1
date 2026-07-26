# Omeety Terminal 卸载：移除 native host 注册表项 + 从各 AI 配置移除 omeety_terminal（不动备份）。
param(
  [string] $NmName = "com.omeety.terminal"
)
$ErrorActionPreference = "Continue"

Write-Host "» 移除 native messaging host 注册表项" -ForegroundColor Cyan
foreach ($k in @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NmName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$NmName"
)) {
  if (Test-Path $k) { Remove-Item $k -Recurse -Force; Write-Host "  ✓ $k" }
}

# Claude
$claudeCfg = Join-Path $env:USERPROFILE ".claude.json"
if (Test-Path $claudeCfg) {
  try {
    $j = Get-Content $claudeCfg -Raw | ConvertFrom-Json
    if ($j.mcpServers.PSObject.Properties.Name -contains "omeety_terminal") {
      $j.mcpServers.PSObject.Properties.Remove("omeety_terminal")
      ($j | ConvertTo-Json -Depth 30) | Out-File $claudeCfg -Encoding utf8
      Write-Host "  ✓ 从 .claude.json 移除 omeety_terminal" -ForegroundColor Green
    }
  } catch { Write-Host "  ! .claude.json 处理失败：$_" -ForegroundColor Yellow }
}

# Codex / Kimi（TOML：正则删块）
foreach ($label in @(".codex", ".kimi-code")) {
  $toml = Join-Path $env:USERPROFILE "$label\config.toml"
  if (Test-Path $toml) {
    $text = Get-Content $toml -Raw
    $new = [regex]::Replace($text, "(?ms)\r?\n?\[mcp_servers\.omeety_terminal\].*?(?=^\[|\z)", "")
    if ($new -ne $text) { $new | Out-File $toml -Encoding utf8 -NoNewline; Write-Host "  ✓ 从 $label 移除 omeety_terminal" -ForegroundColor Green }
  }
}

Write-Host "完成。扩展文件夹与备份文件保留。" -ForegroundColor Green
