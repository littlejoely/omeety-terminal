# Omeety Terminal — Native Messaging 协议

扩展与本地 host 之间用 Chrome/Edge **native messaging**：stdin/stdout 上的 UTF-8 JSON，每条前缀 **4 字节小端长度**。单消息 ≤ 1MB（截图在扩展端先下采样，规避此限）。

## 扩展 → host（写到 host stdin）

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `shell, cols, rows` | 端口连上后第一条。host 据此 spawn PTY（只 spawn 一次；之后只 resize） |
| `input` | `data:string` | 终端击键/粘贴 → PTY stdin |
| `resize` | `cols, rows` | xterm 尺寸变化 → `pty.resize` |
| `replay_request` | `sid` | 面板建好 tab 后请求回放该会话最近输出（SW 侧 64KB 环形缓冲；同 sid 优先，无则全量兜底） |
| `tool_result` | `id, ok, result?, error?` | content.js/SW 的工具结果，完成一个挂起的 `tool_call` |
| `shutdown` | — | 退出 host |

## host → 扩展（写到 host stdout）

| type | 字段 | 说明 |
|---|---|---|
| `output` | `data:string` | PTY stdout/stderr 字节 → `term.write` |
| `tool_call` | `id, name, args` | MCP `tools/call` 到达 → 请扩展在活动标签页执行 |
| `status` | `state:"ready"\|"pty_exit"\|"mcp_error"\|"disconnected", msg?` | 生命周期信号 |

## 工具调用闭环

```
agent → MCP POST /messages(tools/call)
  host: relayCall 生成 localId，登记 Promise，stdout 发 {type:"tool_call",id,name,args}
  扩展 background: 路由到活动标签页 content.js（截图在本 SW，含下采样）
  扩展: stdin 发 {type:"tool_result",id,ok,result|error}
  host: relay.resolveResult(id) → MCP 经 SSE 流回 agent
超时 60s。
```

## host 内部三件套

同一 Node 进程：① nm-stdio（与扩展）② PTY（node-pty + ConPTY，真实 shell）③ MCP SSE（express，`127.0.0.1:49171`，`/sse` + `/messages`）。host 由浏览器在 `connectNative` 时拉起，端口断开时被杀——所以 MCP 仅在终端面板打开时在线。

## 命名

- native host：`com.omeety.terminal`
- 扩展 ID（manifest key 固定）：`fjhjkmpldbepgcpfkhpolnnheccjaamg`
- MCP server 名 / 各 agent 配置里的 id：`omeety_terminal`
- 工具前缀：`omeety_*`（26 个）
- MCP 端口：`49171`（SSE URL：`http://127.0.0.1:49171/sse`）
