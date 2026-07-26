// 设置（chrome.storage.local，持久）

const SETTINGS_KEY = "settings"
const DEFAULT_SETTINGS = {
  shell: "auto", // auto | zsh | bash | fish | powershell | cmd | pwsh | gitbash | 自定义路径
  cols: 80,
  rows: 24,
  fontSize: 12, // 终端字号，Ctrl+滚轮/Ctrl+=/Ctrl+- 调整后自动记住
  acknowledged: false, // 安全确认（真终端=整机权限）
}

export async function loadSettings() {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY)
  return { ...DEFAULT_SETTINGS, ...(s || {}) }
}

export async function saveSettings(patch) {
  const cur = await loadSettings()
  const next = { ...cur, ...patch }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}
