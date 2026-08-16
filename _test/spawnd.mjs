// spawnd 协议回归：守护握手、spawn/写/退出码回传、kill、守护崩溃后的合成退出与回退。
// 说明：守护作为测试的子进程运行（仍是浏览器责任链），所以这里只验证协议与生命周期，
// 「launchd 责任链下下载不带 quarantine」的端到端断言见 README（需真实 LaunchAgent）。
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"

const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spawnd-test-"))
const sockPath = path.join(tmpDir, "spawnd.sock")
const logPath = path.join(tmpDir, "spawnd.log")

process.env.OMEETY_SPAWND_SOCK = sockPath
process.env.OMEETY_SPAWND_LOG = logPath
process.env.OMEETY_LOG_PATH = path.join(tmpDir, "host-debug.log")

const { warmSpawnd, spawndReady, startPtyViaDaemon, initSpawndClient } = await import("../host/src/spawn-client.js")
const { startPty } = await import("../host/src/pty.js")

const daemon = spawn(process.execPath, [new URL("../host/src/spawnd.js", import.meta.url).pathname], {
  stdio: "ignore",
  env: process.env,
})

async function waitFor(predicate, { timeoutMs = 8000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await delay(stepMs)
  }
  return false
}

test.after(async () => {
  daemon.kill("SIGTERM")
  await rm(tmpDir, { recursive: true, force: true })
})

function runInPty(shell, args, script, { cwd = "/tmp", env } = {}) {
  return new Promise((resolve) => {
    let out = ""
    let code = null
    const api = startPtyViaDaemon({
      shell,
      args,
      cols: 80,
      rows: 24,
      cwd,
      env: env || { HOME: os.homedir(), USER: os.userInfo().username, PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
      onOutput: (d) => { out += d },
      onExit: (c) => { code = c },
    })
    ;(async () => {
      await delay(200)
      api.write(script)
      await waitFor(() => code !== null, { timeoutMs: 15000 })
      resolve({ out, code, api })
    })()
  })
}

test("守护握手就绪", async () => {
  await waitFor(() => stat(sockPath).then(() => true, () => false))
  warmSpawnd()
  assert.ok(await waitFor(() => spawndReady()), "握手应在超时前完成")
})

test("spawn/写/输出/退出码回传", { skip: process.platform === "win32" ? "unix shell only" : false }, async () => {
  const { out, code } = await runInPty("/bin/sh", [], "echo spawnd-echo-marker; exit 7\r")
  assert.match(out, /spawnd-echo-marker/)
  assert.equal(code, 7)
})

test("kill 终止会话", { skip: process.platform === "win32" ? "unix shell only" : false }, async () => {
  const result = await new Promise((resolve) => {
    let exited = false
    const api = startPtyViaDaemon({
      shell: "/bin/sh",
      args: [],
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
      onOutput: () => {},
      onExit: () => { exited = true },
    })
    ;(async () => {
      await delay(300)
      api.write("sleep 30\r")
      await delay(300)
      api.kill()
      assert.ok(await waitFor(() => exited), "kill 后应收到 exit")
      resolve(true)
    })()
  })
  assert.ok(result)
})

test("守护崩溃后合成 exit、且新 startPty 回退 inline", { skip: process.platform === "win32" ? "unix shell only" : false }, async () => {
  let exited = false
  startPtyViaDaemon({
    shell: "/bin/sh",
    args: [],
    cols: 80,
    rows: 24,
    cwd: "/tmp",
    env: { HOME: os.homedir(), PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
    onOutput: () => {},
    onExit: () => { exited = true },
  })
  await delay(300)
  assert.equal(spawndReady(), true, "崩溃前应处于就绪态")
  daemon.kill("SIGKILL")
  assert.ok(await waitFor(() => exited), "守护死后活跃会话应收到合成 exit")
  assert.equal(spawndReady(), false)
  // 冷却期内 startPty 应直接回退 inline 而不是卡住。
  const api = startPty({ shell: "/bin/sh", args: ["-c", "exit 0"], cols: 80, rows: 24, cwd: "/tmp", onOutput: () => {}, onExit: () => {} })
  assert.equal(api.via, "inline")
})
