import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { DownloadManager } from "../host/src/download-manager.js"

const payload = Buffer.alloc(9 * 1024 * 1024 + 137)
for (let index = 0; index < payload.length; index++) payload[index] = index % 251
const sha256 = createHash("sha256").update(payload).digest("hex")

function rangeFrom(request) {
  const match = String(request.headers.range || "").match(/^bytes=(\d+)-(\d*)$/)
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] ? Math.min(payload.length - 1, Number(match[2])) : payload.length - 1
  return { start, end }
}

async function serve(request, response) {
  const range = rangeFrom(request)
  const start = range?.start ?? 0
  const end = range?.end ?? payload.length - 1
  const body = payload.subarray(start, end + 1)
  response.writeHead(range ? 206 : 200, {
    "Accept-Ranges": "bytes",
    "Content-Length": body.length,
    "Content-Disposition": 'attachment; filename="fixture.bin"',
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${payload.length}` } : {}),
  })
  if (request.url !== "/slow") {
    response.end(body)
    return
  }
  for (let offset = 0; offset < body.length && !response.destroyed; offset += 32 * 1024) {
    response.write(body.subarray(offset, offset + 32 * 1024))
    await delay(8)
  }
  if (!response.destroyed) response.end()
}

async function waitFor(manager, taskId, states, timeoutMs = 15000, pollMs = 30) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { task } = await manager.status(taskId)
    if (states.includes(task.state)) return task
    await delay(pollMs)
  }
  throw new Error(`task ${taskId} did not reach ${states.join("/")}`)
}

test("DownloadManager downloads ranges, verifies SHA-256 and atomically publishes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omeety-download-test-"))
  const server = http.createServer((request, response) => { void serve(request, response) })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const confirmations = []
  const manager = new DownloadManager({
    stateDirectory: path.join(root, "state"),
    downloadsDirectory: path.join(root, "downloads"),
    confirm: async (value) => { confirmations.push(value); return true },
    requestTimeoutMs: 5000,
  })
  t.after(async () => {
    await manager.shutdown()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })

  const started = await manager.start({
    url: `http://127.0.0.1:${port}/file?secret=not-exposed`,
    sha256,
    networkMode: "direct",
    concurrency: 4,
  })
  assert.equal(started.started, true)
  assert.equal(confirmations.length, 1)
  assert.match(confirmations[0].detail, /并发：4/)
  const completed = await waitFor(manager, started.task.id, ["completed"])
  assert.equal(completed.verified, true)
  assert.equal(completed.actualSha256, sha256)
  assert.equal(completed.url.includes("secret="), false)
  assert.deepEqual(await readFile(completed.destination), payload)
  await assert.rejects(readFile(`${completed.destination}.omeety-${started.task.id}.tmp`))
})

test("DownloadManager reports checksum failure and honours cancellation during assembly", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omeety-download-failure-"))
  const server = http.createServer((request, response) => { void serve(request, response) })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const manager = new DownloadManager({
    stateDirectory: path.join(root, "state"),
    downloadsDirectory: path.join(root, "downloads"),
    confirm: async () => true,
    requestTimeoutMs: 5000,
  })
  t.after(async () => {
    await manager.shutdown()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })

  const bad = await manager.start({ url: `http://127.0.0.1:${port}/file`, sha256: "0".repeat(64), networkMode: "direct" })
  const failed = await waitFor(manager, bad.task.id, ["failed"])
  assert.match(failed.error, /SHA-256 校验失败/)

  const slow = await manager.start({ url: `http://127.0.0.1:${port}/slow`, networkMode: "direct", fileName: "slow.bin" })
  await waitFor(manager, slow.task.id, ["assembling"], 15000, 1)
  const cancelled = await manager.cancel(slow.task.id)
  assert.equal(cancelled.cancelled, true)
  assert.equal((await waitFor(manager, slow.task.id, ["cancelled"])).state, "cancelled")
  await assert.rejects(readFile(slow.task.destination))
})

test("DownloadManager reserves concurrent filenames and releases a denied reservation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omeety-download-reservation-"))
  const server = http.createServer((request, response) => { void serve(request, response) })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  let approve = false
  const manager = new DownloadManager({
    stateDirectory: path.join(root, "state"),
    downloadsDirectory: path.join(root, "downloads"),
    confirm: async () => approve,
  })
  t.after(async () => {
    await manager.shutdown()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })

  const denied = await manager.start({ url: `http://127.0.0.1:${port}/file?denied=1`, fileName: "same.bin", networkMode: "direct" })
  assert.equal(denied.approved, false)
  assert.equal((await manager.status()).count, 0)
  approve = true
  const [first, second] = await Promise.all([
    manager.start({ url: `http://127.0.0.1:${port}/file?task=1`, fileName: "same.bin", networkMode: "direct" }),
    manager.start({ url: `http://127.0.0.1:${port}/file?task=2`, fileName: "same.bin", networkMode: "direct" }),
  ])
  assert.notEqual(first.task.destination, second.task.destination)
  assert.equal((await waitFor(manager, first.task.id, ["completed"])).state, "completed")
  assert.equal((await waitFor(manager, second.task.id, ["completed"])).state, "completed")
})

test("DownloadManager rejects inconsistent ranged responses", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omeety-download-range-"))
  const server = http.createServer((request, response) => {
    const range = rangeFrom(request)
    const start = range?.start ?? 0
    const end = range?.end ?? payload.length - 1
    const length = end - start + 1
    const wrongStart = range && start > 0 ? 0 : start
    const body = payload.subarray(wrongStart, wrongStart + length)
    response.writeHead(range ? 206 : 200, {
      "Accept-Ranges": "bytes",
      "Content-Length": body.length,
      ...(range ? { "Content-Range": `bytes ${wrongStart}-${wrongStart + body.length - 1}/${payload.length}` } : {}),
    })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const manager = new DownloadManager({
    stateDirectory: path.join(root, "state"),
    downloadsDirectory: path.join(root, "downloads"),
    confirm: async () => true,
    maxRetries: 0,
  })
  t.after(async () => {
    await manager.shutdown()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })

  const started = await manager.start({ url: `http://127.0.0.1:${port}/wrong-range`, networkMode: "direct", concurrency: 4 })
  const failed = await waitFor(manager, started.task.id, ["failed"])
  assert.match(failed.error, /Content-Range/)
  await assert.rejects(readFile(started.task.destination))
})

test("DownloadManager rejects invalid network modes before probing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omeety-download-input-"))
  const manager = new DownloadManager({
    stateDirectory: path.join(root, "state"),
    downloadsDirectory: path.join(root, "downloads"),
    confirm: async () => true,
  })
  t.after(async () => {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  await assert.rejects(manager.start({ url: "https://example.com/file", networkMode: "fastest" }), /networkMode/)
})
