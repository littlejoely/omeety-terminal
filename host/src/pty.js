// PTY：node-pty + ConPTY 起一个真实 shell，I/O 桥到 native 通道。
import pty from "node-pty"
import path from "node:path"
import fs from "node:fs"

const SHELLS = {
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  cmd: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
  gitbash: "C:\\Program Files\\Git\\bin\\bash.exe",
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
    env.APPDATA && path.join(env.APPDATA, "npm"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"),
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
  const sep = process.platform === "win32" ? ";" : ":"
  const cur = env[pathKey] ? String(env[pathKey]).split(sep) : []
  const merged = [...exists, ...cur.filter((p) => !exists.includes(p))]
  env[pathKey] = merged.join(sep)
  return env
}

export function resolveShell(choice) {
  if (choice === "cmd") return { cmd: SHELLS.cmd, args: [] }
  if (choice === "pwsh") return { cmd: SHELLS.pwsh, args: ["-NoLogo"] }
  if (choice === "gitbash") {
    // Git for Windows 默认装在这；不在就明确报错（比 spawn 失败的模糊错误好排查）
    if (!shellExists(SHELLS.gitbash)) throw new Error(`未找到 Git Bash：${SHELLS.gitbash}（安装 Git for Windows，或到设置里换自定义路径）`)
    return { cmd: SHELLS.gitbash, args: ["--login", "-i"] } // login shell 才读 /etc/profile 拿到完整 PATH
  }
  if (choice && choice !== "powershell") {
    // 自定义路径
    return { cmd: choice, args: [] }
  }
  return { cmd: SHELLS.powershell, args: ["-NoLogo"] }
}

export function startPty({ shell, args, cols, rows, cwd, onOutput, onExit }) {
  const env = augmentPath({ ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" })
  const term = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || process.env.USERPROFILE,
    env,
    useConpty: true,
  })
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
