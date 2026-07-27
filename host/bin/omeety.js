#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const HELP = `Omeety Terminal CLI（MCP 下载工具的薄封装）

用法：
  omeety download <URL> [选项]
  omeety download status [TASK_ID]
  omeety download cancel <TASK_ID>
  omeety help

下载选项：
  --filename <名称>          指定保存文件名
  --sha256 <64位校验值>     完成后校验 SHA-256
  --network <auto|direct|proxy>  线路模式（默认 auto）
  --proxy <URL>              指定 HTTP(S) 代理
  --concurrency <1-8>        Range 分块并发数（默认 4）
  --mcp-url <URL>            MCP 地址（默认 OMEETY_MCP_URL 或 http://127.0.0.1:49171/mcp）

说明：CLI 与 Agent 调用同一组 MCP 工具和同一份持久化任务；开始下载仍会在
Omeety 侧栏显示确认框。下载完成前可以关闭当前 CLI，但不要退出浏览器/host。`

function parse(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value.startsWith("--")) {
      positional.push(value)
      continue
    }
    const [rawKey, inline] = value.slice(2).split(/=(.*)/s, 2)
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    const next = inline ?? argv[++index]
    if (next == null || next.startsWith("--")) throw new Error(`选项 --${rawKey} 缺少值`)
    options[key] = next
  }
  return { positional, options }
}

async function callTool(name, args, mcpUrl) {
  const client = new Client({ name: "omeety-cli", version: "0.1.0" }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
  try {
    await client.connect(transport)
    const result = await client.callTool({ name, arguments: args })
    const text = result.content?.find((item) => item.type === "text")?.text
    if (result.isError) throw new Error(text || "MCP 工具调用失败")
    try { return JSON.parse(text) } catch { return text }
  } finally {
    try { await client.close() } catch { /* connection may not have opened */ }
  }
}

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`)
}

async function main() {
  const argv = process.argv.slice(2)
  if (!argv.length || argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP)
    return
  }
  const { positional, options } = parse(argv)
  if (positional[0] !== "download") throw new Error(`未知命令：${positional[0]}\n\n${HELP}`)
  const knownOptions = new Set(["filename", "sha256", "network", "proxy", "concurrency", "mcpUrl"])
  const unknownOption = Object.keys(options).find((name) => !knownOptions.has(name))
  if (unknownOption) throw new Error(`未知选项：--${unknownOption}`)
  const mcpUrl = options.mcpUrl || process.env.OMEETY_MCP_URL || "http://127.0.0.1:49171/mcp"
  const action = positional[1]
  if (action === "status") {
    print(await callTool("omeety_download_status", positional[2] ? { taskId: positional[2] } : {}, mcpUrl))
    return
  }
  if (action === "cancel") {
    if (!positional[2]) throw new Error("download cancel 需要 TASK_ID")
    print(await callTool("omeety_download_cancel", { taskId: positional[2] }, mcpUrl))
    return
  }
  if (!action || !/^https?:\/\//i.test(action)) throw new Error(`download 需要 http(s) URL\n\n${HELP}`)
  if (options.network != null && !["auto", "direct", "proxy"].includes(options.network)) {
    throw new Error("--network 必须是 auto、direct 或 proxy")
  }
  const concurrency = options.concurrency == null ? undefined : Number(options.concurrency)
  if (concurrency != null && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)) {
    throw new Error("--concurrency 必须是 1 到 8 的整数")
  }
  print(await callTool("omeety_download_start", {
    url: action,
    fileName: options.filename,
    sha256: options.sha256,
    networkMode: options.network,
    proxyUrl: options.proxy,
    concurrency,
  }, mcpUrl))
}

main().catch((error) => {
  const message = String(error?.message || error)
  if (/fetch failed|ECONNREFUSED|connect/i.test(message)) {
    console.error(`无法连接 Omeety MCP。请先打开浏览器和 Omeety 侧栏。\n${message}`)
  } else {
    console.error(message)
  }
  process.exitCode = 1
})
