// PTY：Windows 使用 ConPTY，macOS/Linux 使用系统 PTY，I/O 桥到 native 通道。
// macOS 上优先经 spawnd 守护（launchd 责任链）spawn，避免 PTY 内下载的文件
// 被 macOS 按 Chrome 责任进程打隔离标记；守护不可用时回退进程内 spawn。
import pty from "node-pty"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { spawndReady, startPtyViaDaemon, initSpawndClient } from "./spawn-client.js"
import { log } from "./log.js"

const OMEETY_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin")

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
    OMEETY_BIN,
    home && path.join(home, ".kimi-code", "bin"),
    home && path.join(home, ".local", "bin"),
    home && path.join(home, ".cargo", "bin"),
    env.APPDATA && path.join(env.APPDATA, "npm"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"),
    path.dirname(process.execPath),
    process.platform === "darwin" && "/opt/homebrew/bin",
    process.platform === "darwin" && "/opt/homebrew/sbin",
    process.platform !== "win32" && "/usr/local/bin",
    process.platform !== "win32" && "/usr/bin",
    process.platform !== "win32" && "/bin",
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

// Native Host 会继承启动 Chrome/Edge 的环境。浏览器若由带 NO_COLOR 的自动化终端启动，
// 这个禁色标志原先会继续泄漏给所有 PTY，导致 Codex 即使运行在 xterm-256color 中也主动
// 退化成黑白。PTY 是 Omeety 自己创建的终端边界，因此在这里声明真实能力并清除父进程的
// 偶然禁色标志；用户仍可在 shell 启动文件里显式重新设置 NO_COLOR。
export function createPtyEnv(baseEnv = process.env) {
  const locale = baseEnv.LC_ALL || baseEnv.LC_CTYPE || baseEnv.LANG || ""
  const needsUtf8Locale = process.platform !== "win32" && !/utf-?8/i.test(locale)
  const env = augmentPath({
    ...baseEnv,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "Omeety",
    LANG: needsUtf8Locale ? (process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8") : (baseEnv.LANG || locale),
  })
  if (needsUtf8Locale) {
    // LC_ALL overrides LANG/LC_CTYPE. Browsers launched from test runners or
    // service managers often inherit LC_ALL=C, which makes zsh/readline echo
    // Chinese IME and picked-page context as escaped bytes.
    delete env.LC_ALL
    env.LC_CTYPE = env.LANG
  }
  delete env.NO_COLOR
  // 不沿用其他终端（例如启动 Chrome 的 Ghostty）的版本号，避免能力探测误判。
  delete env.TERM_PROGRAM_VERSION
  return env
}

export function startPty({ shell, args, cols, rows, cwd, onOutput, onExit }) {
  if (spawndReady()) {
    try {
      const env = createPtyEnv()
      const api = startPtyViaDaemon({ shell, args, cols, rows, cwd, env, onOutput, onExit })
      log("startPty via spawnd shell=" + shell)
      return api
    } catch (e) {
      log("startPty spawnd FAILED, fallback inline", e?.stack || String(e))
    }
  } else {
    // 未就绪（守护未装/未启动）：本次走进程内，同时后台重试握手（带冷却）。
    initSpawndClient()
  }
  const env = createPtyEnv()
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
    via: "inline",
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
