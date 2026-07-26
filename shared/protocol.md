# Omeety Terminal — Native Messaging 协议

扩展与本地 host 之间用 Chrome/Edge **native messaging**：stdin/stdout 上的 UTF-8 JSON，每条前缀 **4 字节小端长度**。单消息 ≤ 1MB（截图在扩展端先下采样，规避此限）。

## 扩展 → host（写到 host stdin）

| type | 字段 | 说明 |
|---|---|---|
| `hello` | `sid, shell, cols, rows, title?, renamed?, punctCompat?` | 创建或重新挂接一个终端会话；已存在时只 resize 并更新元数据 |
| `input` | `data:string` | 终端击键/粘贴 → PTY stdin |
| `resize` | `cols, rows` | xterm 尺寸变化 → `pty.resize` |
| `restart` | `sid, shell, cols, rows` | 原子替换指定会话的 PTY |
| `list_sessions` | — | 请求 host 当前仍存活的全部 PTY 会话 |
| `session_meta` | `sid, title?, renamed?, punctCompat?` | 更新可恢复的 Tab 元数据 |
| `panel_state` | `open, keepAliveMode` | 侧栏开关与保活策略（`always` / `30m` / `close`） |
| `replay_request` | `sid` | 面板建好 tab 后请求回放该会话最近输出（SW 侧全局 64KB 环形缓冲，只回放同 sid） |
| `tool_result` | `id, ok, result?, error?` | content.js/SW 的工具结果，完成一个挂起的 `tool_call` |
| `shutdown` | `sid?` | 有 sid 时关闭单个 PTY；无 sid 时退出整个 host |

## host → 扩展（写到 host stdout）

| type | 字段 | 说明 |
|---|---|---|
| `output` | `sid, data:string` | 指定 PTY stdout/stderr 字节 → 对应 Tab 的 `term.write` |
| `sessions_list` | `sessions[]` | 当前存活会话及标题、shell、兼容设置，供侧栏重建全部 Tab |
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

工具成功结果默认以 MCP `text` content 返回。结果对象中的图片 `dataUrl` 会在
host 侧拆成标准 MCP `image` content，并在 JSON 中保留占位标记，避免模型只能
看到一长串 base64。`omeety_get_context_bundle` 因而可以在一次调用中同时交付
目标语义、周边 DOM、诊断信息和局部截图。

轻量页面快照返回 `snapshotId`；下一次传 `sinceSnapshotId` 时，内容未变化只返回
`unchanged` 标记，有变化则返回交互元素增删改与页面摘要差异。动作工具优先使用
`omeety_act_and_verify`，把操作和跨导航后置条件放在同一事务中。

## host 内部三件套

同一 Node 进程：① nm-stdio（与扩展）② PTY（node-pty + ConPTY/Unix PTY，真实 shell）③ MCP Streamable HTTP（`127.0.0.1:49171/mcp`，兼容旧 `/sse` + `/messages`）。host 由浏览器在 `connectNative` 时拉起；侧栏关闭后是否继续运行由保活策略决定。

## 命名

- native host：`com.omeety.terminal`
- 扩展 ID（manifest key 固定）：`fjhjkmpldbepgcpfkhpolnnheccjaamg`
- MCP server 名 / 各 agent 配置里的 id：`omeety_terminal`
- 工具前缀：`omeety_*`（32 个）
- MCP 端口：`49171`（Streamable HTTP：`http://127.0.0.1:49171/mcp`）
