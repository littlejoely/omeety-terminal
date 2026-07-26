// MCP HTTP 服务：Streamable HTTP /mcp（当前 agent）+ legacy SSE /sse（兼容旧客户端）。
import express from "express"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { TOOLS } from "./tools.meta.js"
import { relayCall } from "./relay.js"
import { log } from "./log.js"

function safeStr(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function makeServer(nmSend) {
  const server = new Server({ name: "omeety-terminal", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    const r = await relayCall(nmSend, name, args)
    return r.ok
      ? { content: [{ type: "text", text: safeStr(r.result) }] }
      : { isError: true, content: [{ type: "text", text: String(r.error) }] }
  })
  return server
}

export function startMcpHttp({ port, nmSend }) {
  const app = express()
  app.use(express.json({ limit: "10mb" }))

  const sessions = new Map() // sessionId -> { transport, server }

  // Stateless Streamable HTTP：URL 型 Codex MCP 配置会向同一地址 POST initialize/tools 请求。
  // 每个请求使用独立 server/transport，不需要维护 session，也不会和 legacy SSE 会话串线。
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const server = makeServer(nmSend)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      try { transport.close() } catch { /* ignore */ }
      try { server.close() } catch { /* ignore */ }
    }
    res.once("finish", close)
    res.once("close", close)
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (e) {
      log("mcp streamable http error", e?.stack || String(e))
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: String(e?.message || e) },
          id: null,
        })
      }
    }
  })

  app.get("/sse", async (_req, res) => {
    const transport = new SSEServerTransport("/messages", res)
    const server = makeServer(nmSend)
    sessions.set(transport.sessionId, { transport, server })
    log("mcp /sse new session", transport.sessionId)
    res.on("close", () => {
      try {
        server.close()
      } catch {
        /* ignore */
      }
      sessions.delete(transport.sessionId)
    })
    try {
      await server.connect(transport)
    } catch (e) {
      log("mcp sse connect error", e?.stack || String(e))
    }
  })

  app.post("/messages", async (req, res) => {
    const sid = req.query.sessionId
    const s = sessions.get(sid)
    if (!s) {
      res.status(400).send("no session")
      return
    }
    try {
      await s.transport.handlePostMessage(req, res, req.body)
    } catch (e) {
      log("mcp post error", e?.stack || String(e))
      // handlePostMessage 抛错前可能没回响应 → 不兜底会让 agent 的 fetch 挂起到超时。
      if (!res.headersSent) {
        try { res.status(500).json({ error: String(e?.message || e) }) } catch { /* ignore */ }
      }
    }
  })

  // SW 回收窗口期：旧 host 可能还没退出（看门狗会在 25s 内让它退），此时绑端口会 EADDRINUSE。
  // 不能 exit（会连 PTY 一起杀，终端就废了）→ 过 2s 重试，直到旧 host 退掉抢到端口。PTY 始终活着。
  function listenWithRetry(attempt = 0) {
    const server = app.listen(port, "127.0.0.1", () => {
      log("mcp listening", port, attempt > 0 ? "(retry#" + attempt + ")" : "")
      console.error(`[mcp] HTTP on http://127.0.0.1:${port}/mcp (legacy SSE: /sse)`)
    })
    server.on("error", (e) => {
      log("mcp listen ERROR", e?.code, "attempt=" + attempt)
      console.error(`[mcp] listen error: ${e.code} — ${e.message}`)
      if (e?.code === "EADDRINUSE" && attempt < 30) {
        setTimeout(() => listenWithRetry(attempt + 1), 2000)
      }
    })
  }
  listenWithRetry()
}
