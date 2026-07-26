// PTY：Windows 使用 ConPTY，macOS/Linux 使用系统 PTY，I/O 桥到 native 通道。
import pty from "node-pty"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

const WINDOWS_SHELLS = {
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  cmd: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
  gitbash: "C:\\Program Files\\Git\\bin\\bash.exe",
}

const UNIX_SHELLS = {
  zsh: "/bin/zsh",
  bash: "/bin/bash",
  fish: ["/opt/homebrew/bin/fish", "/usr/local/bin/fish", "/usr/bin/fish"].find(shellExists),
}

function shellExists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

// 一些 CLI 装在固定目录但未必在 PATH 里：kimi → ~/.kimi-code/bin、claude(及 npm 全局) → %APPDATA%/npm、
// codex → %LOCALAPPDATA%/Programs/OpenAI/Codex/bin。把它们补到 PATH 最前，终端里敲 kimi/claude/codex 都能直接找到。
function augmentPath(env) {
  const home = env.USERPROFILE || env.HOME
  const candidates = [
    home && path.join(home, ".kimi-code", "bin"),
    home && path.join(home, ".local", "bin"),
    home && path.join(home, ".cargo", "bin"),
    env.APPDATA && path.join(env.APPDATA, "npm"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"),
    process.platform === "darwin" && "/opt/homebrew/bin",
    process.platform === "darwin" && "/opt/homebrew/sbin",
    process.platform !== "win32" && "/usr/local/bin",
    process.platform !== "win32" && "/usr/bin",
    process.platform !== "win32" && "/bin",
    process.platform !== "win32" && path.dirname(process.execPath),
  ].filter(Boolean)
  const exists = candidates.filter((d) => {
    try {
      return fs.existsSync(d)
    } catch {
      return false
    }
  })
  if (!exists.length) return env
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH"
  const sep = path.delimiter
  const cur = env[pathKey] ? String(env[pathKey]).split(sep) : []
  const merged = [...exists, ...cur.filter((p) => !exists.includes(p))]
  env[pathKey] = merged.join(sep)
  return env
}

export function resolveShell(choice) {
  if (process.platform !== "win32") {
    if (choice === "zsh") return { cmd: UNIX_SHELLS.zsh, args: ["-l"] }
    if (choice === "bash") return { cmd: UNIX_SHELLS.bash, args: ["--login"] }
    if (choice === "fish") {
      if (!UNIX_SHELLS.fish) throw new Error("未找到 fish（可改用系统默认 shell、zsh 或 bash）")
      return { cmd: UNIX_SHELLS.fish, args: ["-l"] }
    }
    if (choice && !["auto", "powershell", "cmd", "pwsh", "gitbash"].includes(choice)) {
      return { cmd: choice, args: [] }
    }
    const detected = process.env.SHELL && shellExists(process.env.SHELL) ? process.env.SHELL : UNIX_SHELLS.zsh
    return { cmd: detected, args: ["-l"] }
  }

  if (choice === "cmd") return { cmd: WINDOWS_SHELLS.cmd, args: [] }
  if (choice === "pwsh") return { cmd: WINDOWS_SHELLS.pwsh, args: ["-NoLogo"] }
  if (choice === "gitbash") {
    // Git for Windows 默认装在这；不在就明确报错（比 spawn 失败的模糊错误好排查）
    if (!shellExists(WINDOWS_SHELLS.gitbash)) throw new Error(`未找到 Git Bash：${WINDOWS_SHELLS.gitbash}（安装 Git for Windows，或到设置里换自定义路径）`)
    return { cmd: WINDOWS_SHELLS.gitbash, args: ["--login", "-i"] } // login shell 才读 /etc/profile 拿到完整 PATH
  }
  if (choice && !["auto", "powershell"].includes(choice)) {
    // 自定义路径
    return { cmd: choice, args: [] }
  }
  return { cmd: WINDOWS_SHELLS.powershell, args: ["-NoLogo"] }
}

export function startPty({ shell, args, cols, rows, cwd, onOutput, onExit }) {
  const env = augmentPath({
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "en_US.UTF-8",
  })
  const options = {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || process.env.USERPROFILE || process.env.HOME || os.homedir(),
    env,
  }
  if (process.platform === "win32") options.useConpty = true
  const term = pty.spawn(shell, args, options)
  term.onData((d) => onOutput(d))
  term.onExit(({ exitCode }) => onExit(exitCode))
  return {
    write: (s) => term.write(s),
    resize: (c, r) => {
      try {
        term.resize(c, r)
      } catch {
        /* ignore */
      }
    },
    kill: () => term.kill(),
  }
}
