import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Agent, ProxyAgent, fetch } from "undici"
import { log } from "./log.js"

const EXECUTABLE_RE = /\.(?:exe|msi|msix|bat|cmd|com|ps1|sh|pkg|dmg|appimage)$/i
const SHA256_RE = /^[a-f0-9]{64}$/i
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"])

class DownloadCancelledError extends Error {
  constructor() {
    super("download cancelled")
    this.name = "DownloadCancelledError"
  }
}

function defaultStateDirectory() {
  if (process.env.OMEETY_DOWNLOAD_STATE_DIR) return path.resolve(process.env.OMEETY_DOWNLOAD_STATE_DIR)
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Omeety Terminal", "downloads")
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Omeety Terminal", "downloads")
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "omeety-terminal", "downloads")
}

function defaultDownloadsDirectory() {
  return path.resolve(process.env.OMEETY_DOWNLOAD_DIR || path.join(os.homedir(), "Downloads"))
}

function clampInteger(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
}

function sanitizeFileName(value) {
  let name = String(value || "").trim()
  try { name = decodeURIComponent(name) } catch { /* keep original */ }
  name = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim()
  if (!name || name === "." || name === "..") name = "download.bin"
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 24)
    name = name.slice(0, Math.max(1, 180 - ext.length)) + ext
  }
  return name
}

function fileNameFromDisposition(value) {
  const text = String(value || "")
  const utf = text.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)
  if (utf) return sanitizeFileName(utf[1].replace(/^"|"$/g, ""))
  const plain = text.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i)
  return plain ? sanitizeFileName(plain[1] || plain[2]) : null
}

function fileNameFromUrl(url) {
  try {
    return sanitizeFileName(new URL(url).pathname.split("/").filter(Boolean).at(-1) || "download.bin")
  } catch {
    return "download.bin"
  }
}

function displayUrl(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return String(url)
  }
}

function proxyLabel(proxyUrl) {
  if (!proxyUrl) return null
  try {
    const parsed = new URL(proxyUrl)
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`
  } catch {
    return "configured proxy"
  }
}

function parseTotalBytes(response) {
  const contentRange = response.headers.get("content-range") || ""
  const match = contentRange.match(/\/(\d+)$/)
  if (match) return Number(match[1])
  const length = Number(response.headers.get("content-length"))
  return Number.isFinite(length) && length >= 0 ? length : null
}

function parseContentRange(value) {
  const match = String(value || "").match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i)
  if (!match) return null
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? null : Number(match[3]),
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "未知"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let n = value
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`
}

async function fileSize(filePath) {
  try { return (await fsp.stat(filePath)).size } catch { return 0 }
}

export class DownloadManager {
  constructor(options = {}) {
    this.stateDirectory = path.resolve(options.stateDirectory || defaultStateDirectory())
    this.downloadsDirectory = path.resolve(options.downloadsDirectory || defaultDownloadsDirectory())
    this.partsRoot = path.join(this.stateDirectory, "parts")
    this.stateFile = path.join(this.stateDirectory, "jobs.json")
    this.confirm = options.confirm || (async () => false)
    this.probeBytes = clampInteger(options.probeBytes, 32 * 1024, 1024 * 1024, 256 * 1024)
    this.probeTimeoutMs = clampInteger(options.probeTimeoutMs, 1000, 60000, 15000)
    this.requestTimeoutMs = clampInteger(options.requestTimeoutMs, 5000, 10 * 60 * 1000, 120000)
    this.maxRetries = clampInteger(options.maxRetries, 0, 12, 5)
    this.defaultProxyUrl = options.defaultProxyUrl || process.env.OMEETY_DOWNLOAD_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "http://127.0.0.1:51081"
    this.jobs = new Map()
    this.running = new Map()
    this.controllers = new Map()
    this.dispatchers = new Map()
    this.pendingDestinations = new Set()
    this.destinationAllocationChain = Promise.resolve()
    this.persistChain = Promise.resolve()
    this.persistTimer = null
    this.ready = this.#initialize()
  }

  async #initialize() {
    await fsp.mkdir(this.partsRoot, { recursive: true })
    await fsp.mkdir(this.downloadsDirectory, { recursive: true })
    try {
      const parsed = JSON.parse(await fsp.readFile(this.stateFile, "utf8"))
      for (const raw of Array.isArray(parsed?.jobs) ? parsed.jobs : []) {
        if (!raw?.id || !raw?.url || !raw?.destination) continue
        const job = { ...raw }
        if (job.state === "running" || job.state === "queued" || job.state === "assembling") job.state = "interrupted"
        this.jobs.set(job.id, job)
      }
    } catch (error) {
      if (error?.code !== "ENOENT") log("download state load failed", error?.message || String(error))
    }
  }

  async resumeInterrupted() {
    await this.ready
    for (const job of this.jobs.values()) {
      if (job.state === "interrupted") this.#launch(job)
    }
  }

  async handleTool(name, args = {}) {
    if (name === "omeety_download_start") return this.start(args)
    if (name === "omeety_download_status") return this.status(args.taskId)
    if (name === "omeety_download_cancel") return this.cancel(args.taskId)
    return undefined
  }

  isDownloadTool(name) {
    return name === "omeety_download_start" || name === "omeety_download_status" || name === "omeety_download_cancel"
  }

  async start(args = {}) {
    await this.ready
    const url = String(args.url || "").trim()
    let parsed
    try { parsed = new URL(url) } catch { throw new Error("url 必须是有效的 http(s) 地址") }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("只允许 http:// 或 https:// 下载")
    const expectedSha256 = args.sha256 ? String(args.sha256).trim().toLowerCase() : null
    if (expectedSha256 && !SHA256_RE.test(expectedSha256)) throw new Error("sha256 必须是 64 位十六进制字符串")
    const networkMode = args.networkMode == null ? "auto" : String(args.networkMode)
    if (!["auto", "direct", "proxy"].includes(networkMode)) {
      throw new Error("networkMode 必须是 auto、direct 或 proxy")
    }
    const requestedProxy = args.proxyUrl == null ? this.defaultProxyUrl : String(args.proxyUrl)
    const proxyUrl = networkMode === "direct" ? null : this.#validateProxy(requestedProxy)
    if (args.proxyUrl != null && !proxyUrl) throw new Error("proxyUrl 必须是有效且不含内嵌凭据的 http(s) 地址")

    const duplicate = [...this.jobs.values()].find((job) => !TERMINAL_STATES.has(job.state) && job.url === url && job.expectedSha256 === expectedSha256)
    if (duplicate) return { started: false, duplicate: true, task: await this.#publicJob(duplicate) }

    const probe = await this.#selectRoute(url, networkMode, proxyUrl)
    const requestedName = args.fileName ? sanitizeFileName(args.fileName) : null
    const fileName = requestedName || probe.fileName || fileNameFromUrl(probe.finalUrl || url)
    const destination = await this.#uniqueDestination(fileName, { reserve: true })
    const concurrency = probe.supportsRanges && Number.isFinite(probe.totalBytes) && probe.totalBytes >= 8 * 1024 * 1024
      ? clampInteger(args.concurrency, 1, 8, 4)
      : 1
    const executable = EXECUTABLE_RE.test(fileName)
    const details = [
      `来源：${displayUrl(url)}`,
      `文件：${fileName}`,
      `大小：${formatBytes(probe.totalBytes)}`,
      `线路：${probe.mode === "proxy" ? `代理 ${proxyLabel(probe.proxyUrl)}` : "直连"}`,
      `并发：${concurrency}`,
      `保存：${destination}`,
      expectedSha256 ? `SHA-256：${expectedSha256}` : "SHA-256：未提供",
      executable ? "⚠ 这是可执行文件；Omeety 只下载和校验，不会运行。" : "",
    ].filter(Boolean).join("\n")
    try {
      const approved = await this.confirm({ message: "允许 Omeety 下载此文件吗？", detail: details })
      if (!approved) return { started: false, approved: false, fileName, size: probe.totalBytes }

      const id = randomUUID()
      const job = {
        id,
        state: "queued",
        url,
        displayUrl: displayUrl(url),
        fileName,
        destination,
        totalBytes: probe.totalBytes,
        downloadedBytes: 0,
        supportsRanges: probe.supportsRanges,
        concurrency,
        networkMode: probe.mode,
        proxyUrl: probe.mode === "proxy" ? probe.proxyUrl : null,
        etag: probe.etag,
        lastModified: probe.lastModified,
        expectedSha256,
        actualSha256: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        updatedAt: new Date().toISOString(),
        speedBps: 0,
        error: null,
        segments: this.#buildSegments(id, probe.totalBytes, probe.supportsRanges, concurrency),
      }
      this.jobs.set(id, job)
      await this.#persist()
      this.#launch(job)
      return { started: true, approved: true, task: await this.#publicJob(job) }
    } finally {
      this.pendingDestinations.delete(this.#destinationKey(destination))
    }
  }

  async status(taskId) {
    await this.ready
    if (taskId) {
      const job = this.jobs.get(String(taskId))
      if (!job) throw new Error(`下载任务不存在：${taskId}`)
      return { task: await this.#publicJob(job) }
    }
    const tasks = []
    for (const job of [...this.jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
      tasks.push(await this.#publicJob(job))
    }
    return { count: tasks.length, tasks }
  }

  async cancel(taskId) {
    await this.ready
    const id = String(taskId || "")
    const job = this.jobs.get(id)
    if (!job) throw new Error(`下载任务不存在：${id}`)
    if (TERMINAL_STATES.has(job.state)) return { cancelled: false, task: await this.#publicJob(job) }
    job.state = "cancelled"
    job.updatedAt = new Date().toISOString()
    job.error = null
    for (const controller of this.controllers.get(id) || []) controller.abort()
    await this.#persist()
    return { cancelled: true, partialFilesKept: true, task: await this.#publicJob(job) }
  }

  async shutdown() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
      await this.#persist()
    }
    for (const controllers of this.controllers.values()) for (const controller of controllers) controller.abort()
    await Promise.allSettled(this.running.values())
    await this.persistChain.catch(() => {})
    for (const dispatcher of this.dispatchers.values()) {
      try { await dispatcher.close() } catch { /* ignore */ }
    }
  }

  #validateProxy(value) {
    if (!value) return null
    try {
      const parsed = new URL(String(value))
      if (!/^https?:$/.test(parsed.protocol)) return null
      if (parsed.username || parsed.password) return null
      return parsed.toString()
    } catch {
      return null
    }
  }

  #dispatcher(mode, proxyUrl) {
    const key = mode === "proxy" ? `proxy:${proxyUrl}` : "direct"
    if (!this.dispatchers.has(key)) {
      const dispatcher = mode === "proxy"
        ? new ProxyAgent({ uri: proxyUrl, connect: { timeout: this.probeTimeoutMs } })
        : new Agent({ connect: { timeout: this.probeTimeoutMs } })
      this.dispatchers.set(key, dispatcher)
    }
    return this.dispatchers.get(key)
  }

  async #selectRoute(url, networkMode, proxyUrl) {
    const candidates = []
    if (networkMode !== "proxy") candidates.push({ mode: "direct", proxyUrl: null })
    if (networkMode !== "direct") {
      if (!proxyUrl) {
        if (networkMode === "proxy") throw new Error("未配置可用代理 URL")
      } else {
        candidates.push({ mode: "proxy", proxyUrl })
      }
    }
    const settled = await Promise.allSettled(candidates.map((route) => this.#probe(url, route)))
    const successes = settled.filter((item) => item.status === "fulfilled").map((item) => item.value)
    if (!successes.length) {
      const errors = settled.map((item, index) => `${candidates[index].mode}: ${item.reason?.message || item.reason}`).join("；")
      throw new Error(`直连/代理探测均失败：${errors}`)
    }
    successes.sort((a, b) => b.speedBps - a.speedBps)
    return successes[0]
  }

  async #probe(url, route) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs)
    const started = performance.now()
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        dispatcher: this.#dispatcher(route.mode, route.proxyUrl),
        signal: controller.signal,
        headers: { Range: `bytes=0-${this.probeBytes - 1}`, "Accept-Encoding": "identity", "User-Agent": "Omeety-Terminal/0.2" },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const reader = response.body?.getReader()
      let received = 0
      while (reader && received < this.probeBytes) {
        const { done, value } = await reader.read()
        if (done) break
        received += value?.byteLength || 0
      }
      try { await reader?.cancel() } catch { /* response already done */ }
      const elapsed = Math.max(0.001, (performance.now() - started) / 1000)
      const dispositionName = fileNameFromDisposition(response.headers.get("content-disposition"))
      return {
        ...route,
        finalUrl: response.url,
        speedBps: received / elapsed,
        totalBytes: parseTotalBytes(response),
        // 探测请求本身已带 Range；只有真实 206 才能证明后续分块/续传可靠。
        supportsRanges: response.status === 206,
        fileName: dispositionName || fileNameFromUrl(response.url),
        etag: response.headers.get("etag") || null,
        lastModified: response.headers.get("last-modified") || null,
      }
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`连接或读取超过 ${Math.round(this.probeTimeoutMs / 1000)} 秒`)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  #buildSegments(id, totalBytes, supportsRanges, concurrency) {
    const directory = path.join(this.partsRoot, id)
    if (!supportsRanges || !Number.isFinite(totalBytes) || concurrency <= 1) {
      return [{ index: 0, start: 0, end: Number.isFinite(totalBytes) ? totalBytes - 1 : null, path: path.join(directory, "part-00.bin") }]
    }
    const size = Math.ceil(totalBytes / concurrency)
    return Array.from({ length: concurrency }, (_, index) => ({
      index,
      start: index * size,
      end: Math.min(totalBytes - 1, (index + 1) * size - 1),
      path: path.join(directory, `part-${String(index).padStart(2, "0")}.bin`),
    })).filter((segment) => segment.start <= segment.end)
  }

  #launch(job) {
    if (this.running.has(job.id) || TERMINAL_STATES.has(job.state)) return
    const promise = this.#run(job).finally(() => {
      this.running.delete(job.id)
      this.controllers.delete(job.id)
    })
    this.running.set(job.id, promise)
  }

  async #run(job) {
    job.state = "running"
    job.startedAt ||= new Date().toISOString()
    job.updatedAt = new Date().toISOString()
    job.error = null
    await fsp.mkdir(path.dirname(job.segments[0].path), { recursive: true })
    job.downloadedBytes = await this.#downloadedBytes(job)
    const initialBytes = job.downloadedBytes
    const speedStarted = performance.now()
    await this.#persist()
    const segmentPromises = job.segments.map((segment) => this.#downloadSegment(job, segment, initialBytes, speedStarted))
    try {
      await Promise.all(segmentPromises)
      if (job.state === "cancelled") throw new DownloadCancelledError()
      job.state = "assembling"
      await this.#persist()
      await this.#assemble(job)
      job.state = "completed"
      job.downloadedBytes = job.totalBytes ?? await fileSize(job.destination)
      job.completedAt = new Date().toISOString()
      job.updatedAt = job.completedAt
      job.speedBps = 0
      await this.#persist()
      await this.#cleanupParts(job)
      log("download completed", job.id, job.fileName, job.actualSha256)
    } catch (error) {
      const cancelled = job.state === "cancelled" || error instanceof DownloadCancelledError
      job.state = cancelled ? "cancelled" : "failed"
      for (const controller of this.controllers.get(job.id) || []) controller.abort()
      await Promise.allSettled(segmentPromises)
      if (cancelled) {
        job.state = "cancelled"
        job.error = null
      } else {
        job.error = error?.message || String(error)
        log("download failed", job.id, job.error)
      }
      job.updatedAt = new Date().toISOString()
      job.speedBps = 0
      await this.#persist()
    }
  }

  async #downloadSegment(job, segment, initialBytes, speedStarted) {
    const expectedLength = segment.end == null ? null : segment.end - segment.start + 1
    let downloaded = await fileSize(segment.path)
    if (expectedLength != null && downloaded > expectedLength) {
      await fsp.truncate(segment.path, 0)
      downloaded = 0
    }
    let attempt = 0
    while (expectedLength == null || downloaded < expectedLength) {
      if (job.state === "cancelled") throw new DownloadCancelledError()
      if (job.state !== "running") throw new Error("download stopped")
      const controller = new AbortController()
      if (!this.controllers.has(job.id)) this.controllers.set(job.id, new Set())
      this.controllers.get(job.id).add(controller)
      let timer
      let response
      const refreshInactivityTimer = () => {
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
      }
      refreshInactivityTimer()
      try {
        const rangeStart = segment.start + downloaded
        const headers = { "Accept-Encoding": "identity", "User-Agent": "Omeety-Terminal/0.2" }
        if (job.supportsRanges && (rangeStart > 0 || segment.end != null)) headers.Range = `bytes=${rangeStart}-${segment.end ?? ""}`
        if (headers.Range) {
          const strongEtag = job.etag && !String(job.etag).startsWith("W/") ? job.etag : null
          if (strongEtag || job.lastModified) headers["If-Range"] = strongEtag || job.lastModified
        }
        response = await fetch(job.url, {
          method: "GET",
          redirect: "follow",
          dispatcher: this.#dispatcher(job.networkMode, job.proxyUrl),
          signal: controller.signal,
          headers,
        })
        const expectsPartial = Boolean(headers.Range)
        if (!response.ok || (expectsPartial && response.status !== 206)) {
          throw new Error(`HTTP ${response.status}${expectsPartial ? "（服务器未接受断点 Range）" : ""}`)
        }
        if (expectsPartial) {
          const range = parseContentRange(response.headers.get("content-range"))
          if (!range || range.start !== rangeStart || (segment.end != null && range.end > segment.end)) {
            throw new Error("服务器返回的 Content-Range 与请求分块不一致")
          }
          if (Number.isFinite(job.totalBytes) && range.total != null && range.total !== job.totalBytes) {
            throw new Error(`远端文件大小已变化：${range.total}/${job.totalBytes}`)
          }
        }
        const responseEtag = response.headers.get("etag")
        const responseModified = response.headers.get("last-modified")
        if (job.etag && responseEtag && responseEtag !== job.etag) throw new Error("远端文件 ETag 已变化")
        if (job.lastModified && responseModified && responseModified !== job.lastModified) throw new Error("远端文件修改时间已变化")
        if (!expectsPartial && downloaded > 0) {
          await fsp.truncate(segment.path, 0)
          job.downloadedBytes -= downloaded
          downloaded = 0
        }
        const handle = await fsp.open(segment.path, "a")
        try {
          for await (const chunk of response.body || []) {
            if (job.state === "cancelled") throw new DownloadCancelledError()
            refreshInactivityTimer()
            const buffer = Buffer.from(chunk)
            await handle.write(buffer)
            downloaded += buffer.length
            job.downloadedBytes += buffer.length
            const elapsed = Math.max(0.001, (performance.now() - speedStarted) / 1000)
            job.speedBps = Math.max(0, (job.downloadedBytes - initialBytes) / elapsed)
            job.updatedAt = new Date().toISOString()
            this.#schedulePersist()
            if (expectedLength != null && downloaded > expectedLength) throw new Error("服务器返回数据超过分块边界")
          }
        } finally {
          await handle.close()
        }
        if (expectedLength == null) {
          job.totalBytes = job.downloadedBytes
          segment.end = segment.start + downloaded - 1
          break
        }
        if (downloaded >= expectedLength) break
        throw new Error(`连接提前结束：${downloaded}/${expectedLength}`)
      } catch (error) {
        try { await response?.body?.cancel() } catch { /* body may already be consumed or locked */ }
        if (job.state === "cancelled") throw new DownloadCancelledError()
        if (job.state !== "running") throw error
        if (attempt >= this.maxRetries) throw error
        attempt++
        await delay(Math.min(10000, 500 * 2 ** attempt))
        downloaded = await fileSize(segment.path)
      } finally {
        clearTimeout(timer)
        this.controllers.get(job.id)?.delete(controller)
      }
    }
  }

  async #assemble(job) {
    const output = `${job.destination}.omeety-${job.id}.tmp`
    await fsp.rm(output, { force: true })
    try {
      const out = await fsp.open(output, "wx")
      const hash = createHash("sha256")
      try {
        for (const segment of [...job.segments].sort((a, b) => a.index - b.index)) {
          if (job.state === "cancelled") throw new DownloadCancelledError()
          const input = fs.createReadStream(segment.path)
          for await (const chunk of input) {
            if (job.state === "cancelled") throw new DownloadCancelledError()
            hash.update(chunk)
            await out.write(chunk)
          }
        }
      } finally {
        await out.close()
      }
      const actual = hash.digest("hex")
      job.actualSha256 = actual
      if (job.expectedSha256 && actual.toLowerCase() !== job.expectedSha256.toLowerCase()) {
        throw new Error(`SHA-256 校验失败：实际 ${actual}，期望 ${job.expectedSha256}`)
      }
      const assembledSize = await fileSize(output)
      if (Number.isFinite(job.totalBytes) && assembledSize !== job.totalBytes) {
        throw new Error(`最终大小不匹配：${assembledSize}/${job.totalBytes}`)
      }
      if (job.state === "cancelled") throw new DownloadCancelledError()
      job.destination = await this.#uniqueDestination(job.fileName, { excludeJobId: job.id })
      if (job.state === "cancelled") throw new DownloadCancelledError()
      await fsp.rename(output, job.destination)
      if (job.state === "cancelled") {
        await fsp.rm(job.destination, { force: true })
        throw new DownloadCancelledError()
      }
    } catch (error) {
      await fsp.rm(output, { force: true })
      throw error
    }
  }

  #destinationKey(filePath) {
    const resolved = path.resolve(filePath)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }

  #isDestinationReserved(candidate, excludeJobId = null) {
    const key = this.#destinationKey(candidate)
    if (this.pendingDestinations.has(key)) return true
    return [...this.jobs.values()].some((job) => (
      job.id !== excludeJobId &&
      !TERMINAL_STATES.has(job.state) &&
      this.#destinationKey(job.destination) === key
    ))
  }

  async #uniqueDestination(fileName, { excludeJobId = null, reserve = false } = {}) {
    if (!reserve) return this.#findUniqueDestination(fileName, { excludeJobId, reserve: false })
    const allocation = this.destinationAllocationChain.then(
      () => this.#findUniqueDestination(fileName, { excludeJobId, reserve: true }),
      () => this.#findUniqueDestination(fileName, { excludeJobId, reserve: true }),
    )
    this.destinationAllocationChain = allocation.then(() => {}, () => {})
    return allocation
  }

  async #findUniqueDestination(fileName, { excludeJobId = null, reserve = false } = {}) {
    const parsed = path.parse(sanitizeFileName(fileName))
    for (let i = 0; i < 10000; i++) {
      const suffix = i === 0 ? "" : ` (${i})`
      const candidate = path.join(this.downloadsDirectory, `${parsed.name}${suffix}${parsed.ext}`)
      if (this.#isDestinationReserved(candidate, excludeJobId)) continue
      try {
        await fsp.access(candidate)
      } catch (error) {
        if (error?.code !== "ENOENT") throw error
        if (reserve) this.pendingDestinations.add(this.#destinationKey(candidate))
        return candidate
      }
    }
    throw new Error("无法生成唯一下载文件名")
  }

  async #downloadedBytes(job) {
    let total = 0
    for (const segment of job.segments || []) total += await fileSize(segment.path)
    return total
  }

  async #publicJob(job) {
    if (!TERMINAL_STATES.has(job.state)) job.downloadedBytes = await this.#downloadedBytes(job)
    const total = Number.isFinite(job.totalBytes) ? job.totalBytes : null
    const percent = total > 0 ? Math.min(100, (job.downloadedBytes / total) * 100) : null
    const remaining = total == null ? null : Math.max(0, total - job.downloadedBytes)
    const etaSeconds = remaining != null && job.speedBps > 0 ? Math.round(remaining / job.speedBps) : null
    return {
      id: job.id,
      state: job.state,
      url: job.displayUrl || displayUrl(job.url),
      fileName: job.fileName,
      destination: job.destination,
      totalBytes: total,
      downloadedBytes: job.downloadedBytes,
      percent: percent == null ? null : Math.round(percent * 10) / 10,
      speedBps: Math.round(job.speedBps || 0),
      etaSeconds,
      route: job.networkMode === "proxy" ? `proxy ${proxyLabel(job.proxyUrl)}` : "direct",
      concurrency: job.concurrency,
      expectedSha256: job.expectedSha256,
      actualSha256: job.actualSha256,
      verified: job.state === "completed" ? (job.expectedSha256 ? job.actualSha256 === job.expectedSha256 : true) : false,
      executable: EXECUTABLE_RE.test(job.fileName),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      error: job.error,
    }
  }

  #schedulePersist() {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.#persist().catch((error) => log("download persist failed", error?.message || String(error)))
    }, 1000)
  }

  async #persist() {
    const persist = async () => {
      await fsp.mkdir(this.stateDirectory, { recursive: true })
      const temp = `${this.stateFile}.${process.pid}.tmp`
      const jobs = [...this.jobs.values()]
      await fsp.writeFile(temp, JSON.stringify({ version: 1, jobs }, null, 2) + "\n", "utf8")
      await fsp.rename(temp, this.stateFile)
    }
    this.persistChain = this.persistChain.then(persist, persist)
    return this.persistChain
  }

  async #cleanupParts(job) {
    const target = path.resolve(path.dirname(job.segments[0].path))
    const root = path.resolve(this.partsRoot)
    if (target.startsWith(root + path.sep)) await fsp.rm(target, { recursive: true, force: true })
  }
}
