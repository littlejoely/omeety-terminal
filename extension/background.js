// Omeety Terminal — Service Worker
// 职责：① 持有 native messaging 端口；② 把 native 的 tool_call 路由到活动标签页 content.js（截图在本 SW）；
//       ③ 在面板与 native 间转发 input/output/resize/status。

import { buildPageEvaluationExpression, isTransientContentErrorMessage } from "./tool-runtime.js"
import { loadSettings } from "./storage.js"

const NM_NAME = "com.omeety.terminal"

let nativePort = null
const panelPorts = new Set() // 面板通过 chrome.runtime.connect({name:"panel"}) 连进来
let lastPick = null // 用户用 📌 选取的元素（content.js 回传），供 omeety_get_user_pick 工具取
const runtimeStartedAt = Date.now()
const toolMetrics = new Map() // name -> {calls,successes,failures,totalMs,maxMs,lastMs,lastAt}

function recordToolMetric(name, ok, durationMs) {
  const current = toolMetrics.get(name) || { calls: 0, successes: 0, failures: 0, totalMs: 0, maxMs: 0, lastMs: 0, lastAt: null }
  current.calls += 1
  if (ok) current.successes += 1
  else current.failures += 1
  current.totalMs += durationMs
  current.maxMs = Math.max(current.maxMs, durationMs)
  current.lastMs = durationMs
  current.lastAt = new Date().toISOString()
  toolMetrics.set(name, current)
}

function getRuntimeMetrics() {
  const tools = [...toolMetrics.entries()].map(([name, metric]) => ({
    name,
    ...metric,
    averageMs: metric.calls ? Math.round((metric.totalMs / metric.calls) * 10) / 10 : 0,
  }))
  return {
    startedAt: new Date(runtimeStartedAt).toISOString(),
    uptimeMs: Date.now() - runtimeStartedAt,
    nativeConnected: !!nativePort,
    panelConnections: panelPorts.size,
    replayBufferBytes: outputBufLen,
    replayBufferChunks: outputBuf.length,
    cdpAttachedTabs: cdpAttachedTabs.size,
    totals: {
      calls: tools.reduce((sum, item) => sum + item.calls, 0),
      successes: tools.reduce((sum, item) => sum + item.successes, 0),
      failures: tools.reduce((sum, item) => sum + item.failures, 0),
    },
    tools: tools.sort((a, b) => b.calls - a.calls || b.maxMs - a.maxMs),
  }
}

// 最近 PTY 输出的环形缓冲（按 sid 分条记录）：面板重开建好 tab 后主动 replay_request 回放，
// 避免终端一片空白（轻量，仅近 64KB）。注意不能直接无 sid 回放——面板按 sid 路由，对不上会整条丢弃。
const outputBuf = [] // [{ sid, data }]
let outputBufLen = 0
const OUTPUT_BUF_MAX = 65536
function pushOutput(sid, data) {
  outputBuf.push({ sid, data })
  outputBufLen += data.length
  while (outputBufLen > OUTPUT_BUF_MAX && outputBuf.length > 1) {
    outputBufLen -= outputBuf.shift().data.length
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
})

// offscreen document：维持一条到本 SW 的长连接，让 SW 不被回收 → native 端口不断 →
// host/PTY 活过侧栏关闭（会话保持）。注：Edge 完全退出时 SW 仍会死，会话丢（offscreen 方案的固有限制）。
async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "保持终端会话：侧栏关闭时维持 service worker 存活，使本地 host/PTY 不被回收",
    })
  } catch (e) {
    console.warn("[omeety] offscreen create failed:", e?.message || e)
  }
}
ensureOffscreen()

// content.js 回传的用户选取元素（点 📌 选取 → 在页面点中元素）
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "omeety_pick_done") {
    lastPick = msg.pick ? { ...msg.pick, tabId: sender.tab?.id ?? null } : null
    broadcast({ type: "pick_result", pick: lastPick })
  }
})

// ---------- native port ----------
function connectNative() {
  if (nativePort) return
  try {
    nativePort = chrome.runtime.connectNative(NM_NAME)
  } catch (e) {
    broadcast({ type: "status", state: "mcp_error", msg: "connectNative 失败：" + (e?.message || e) })
    return
  }
  nativePort.onMessage.addListener((msg) => {
    if (msg?.type === "tool_call") {
      void handleToolCall(msg)
    } else {
      broadcast(msg) // output / status → 面板
      if (msg?.type === "output" && typeof msg.data === "string") pushOutput(msg.sid || "default", msg.data)
    }
  })
  nativePort.onDisconnect.addListener(() => {
    // Edge/Chrome 把 native 失败原因放在 chrome.runtime.lastError 里；不读会被吞，读了才能显示到面板。
    const err = chrome.runtime.lastError?.message || ""
    nativePort = null
    broadcast({ type: "status", state: "disconnected", msg: err })
    console.warn("[omeety] native disconnect:", err || "(无 lastError，host 可能自行退出)")
    if (panelPorts.size) setTimeout(connectNative, 1500) // 面板还在 → 自动重连（=新 shell）
  })
}

function sendNative(msg) {
  try {
    nativePort?.postMessage(msg)
  } catch {
    /* port closed */
  }
}

async function notifyPanelState(open) {
  const settings = await loadSettings()
  const actualOpen = panelPorts.size > 0
  if (actualOpen !== !!open) return // storage 异步读取期间侧栏状态又变了，丢弃过期通知
  sendNative({ type: "panel_state", open: actualOpen, keepAliveMode: settings.keepAliveMode })
}

// 心跳保活：只要 native 连着就每 8s 给 host 发 ping（面板关了也发——offscreen 让 SW 活着，
// 心跳让 host 的静默看门狗不触发，PTY 因此活过侧栏关闭）。
setInterval(() => {
  if (nativePort) {
    try {
      nativePort.postMessage({ type: "ping" })
    } catch {
      /* port closed */
    }
  }
}, 8000)

function broadcast(msg) {
  for (const p of panelPorts) {
    try {
      p.postMessage(msg)
    } catch {
      /* dead */
    }
  }
}

// ---------- panel connections ----------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") return // offscreen 保活端口：存在即让 SW 不被回收，无需处理
  if (port.name !== "panel") return
  panelPorts.add(port)
  // 不在此处主动回放：面板此时还没建 tab，回放会路由不到任何终端被丢弃。
  // 面板建好 tab 后会发 replay_request（见下）。
  port.onMessage.addListener(async (m) => {
    if (m?.type === "hello" || m?.type === "input" || m?.type === "resize" || m?.type === "restart" || m?.type === "shutdown" || m?.type === "list_tools" || m?.type === "list_sessions" || m?.type === "session_meta") {
      sendNative(m)
    } else if (m?.type === "settings_changed") {
      void notifyPanelState(panelPorts.size > 0)
    } else if (m?.type === "replay_request") {
      // 只回放同 sid 的记录；对不上（旧会话 sid 已变）就空——绝不 fallback 全量，
      // 否则会把别的 tab 的终端输出灌进当前 tab（跨 tab 串话）。
      const want = String(m.sid || "")
      const entries = outputBuf.filter((e) => e.sid === want)
      if (entries.length) {
        try {
          port.postMessage({ type: "output", sid: want, data: entries.map((e) => e.data).join("") })
        } catch {
          /* dead */
        }
      }
    } else if (m?.type === "start_pick") {
      // 面板点了 📌 选取 → 让活动标签页进入选取模式
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "omeety_start_pick" })
      } catch (e) {
        if (isMissingContent(e)) {
          try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }) } catch {}
          try { await chrome.tabs.sendMessage(tab.id, { type: "omeety_start_pick" }) } catch {}
        }
      }
    }
  })
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port)
    // 由用户设置决定永久保活、空闲 30 分钟回收，或立即结束。
    if (panelPorts.size === 0) void notifyPanelState(false)
  })
  connectNative()
  void notifyPanelState(true)
})

// ---------- CDP（chrome.debugger）真实输入 ----------
// 合成事件（content.js dispatchEvent）isTrusted=false，建不了真实光标/选区 → 飞书 Lark
// EditorKit 等富文本编辑器不认输入。CDP（chrome.debugger）派发的是真实输入事件
// (isTrusted=true)，能建立真光标、触发 model 更新。代价：attach 后浏览器顶部常驻
// "正在调试此浏览器"黄条。这里统一管理 CDP attach/detach 生命周期。
const cdpAttachedTabs = new Set()
const cdpEnabledDomains = new Map()

function chromeDebuggerAttach(target, protocolVersion) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, protocolVersion, () => {
      const e = chrome.runtime.lastError
      e ? reject(new Error(e.message)) : resolve(null)
    })
  })
}
function chromeDebuggerDetach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const e = chrome.runtime.lastError
      e ? reject(new Error(e.message)) : resolve(null)
    })
  })
}
function chromeDebuggerSendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const e = chrome.runtime.lastError
      e ? reject(new Error(e.message)) : resolve(result)
    })
  })
}
async function ensureCdpDomains(tabId, domains = []) {
  if (!cdpEnabledDomains.has(tabId)) cdpEnabledDomains.set(tabId, new Set())
  const enabled = cdpEnabledDomains.get(tabId)
  for (const d of domains) {
    if (enabled.has(d)) continue
    await chromeDebuggerSendCommand({ tabId }, `${d}.enable`, {})
    enabled.add(d)
  }
}
async function ensureCdpAttached(tabId, protocolVersion = "1.3") {
  if (!chrome.debugger?.attach) {
    throw new Error("chrome.debugger 不可用（确认 manifest 声明了 debugger 权限）")
  }
  if (cdpAttachedTabs.has(tabId)) {
    await ensureCdpDomains(tabId, ["Page", "Runtime"])
    return
  }
  await chromeDebuggerAttach({ tabId }, protocolVersion)
  cdpAttachedTabs.add(tabId)
  await ensureCdpDomains(tabId, ["Page", "Runtime"])
}

// 真实鼠标点击：mousePressed + mouseReleased → 建立真实焦点/光标。
async function cdpMouseClick(tabId, x, y, clickCount = 1) {
  await ensureCdpAttached(tabId)
  const button = "left"
  await chromeDebuggerSendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount })
  await chromeDebuggerSendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount })
}

// CDP 真实"全选 + 删除"，清空 contenteditable（触发富文本 model 重置 + 重渲染）。
// 用于 CDP 输入前清场：合成输入的 DOM 残渣不会被富文本重渲染清掉，会越堆越多；
// 真实 Ctrl+A+Backspace 能让 model 真正清空。
async function cdpClearEditor(tabId) {
  await chromeDebuggerSendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 })
  await chromeDebuggerSendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 })
  await chromeDebuggerSendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 })
  await chromeDebuggerSendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 })
  await chromeDebuggerSendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 })
  await chromeDebuggerSendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 })
}

// 真实文本输入：优先 Input.insertText（一次性插入整段，原生支持 CJK/emoji），
// 失败再退回逐字 dispatchKeyEvent char（ASCII 仍可用）。富文本（飞书 Lark EditorKit）
// 靠真实按键更新内部 model；合成 input/InputEvent 它不认。
// 关键：dispatchKeyEvent 的 char 路径不支持 BMP 外/CJK 多字节字符，"杨琪"会变成乱码符号，
// 因此 CJK 必须走 insertText。clear=true（默认）时先 cdpClearEditor 清场，替换语义、不堆叠。
async function cdpTypeText(tabId, text, clear = true) {
  await ensureCdpAttached(tabId)
  if (clear) {
    try { await cdpClearEditor(tabId) } catch { /* 空编辑器/无选中，忽略 */ }
  }
  const s = String(text ?? "")
  if (!s) return
  try {
    await chromeDebuggerSendCommand({ tabId }, "Input.insertText", { text: s })
  } catch {
    // insertText 不被支持/失败时退回逐字 char（ASCII 可用；CJK 会乱码但好过完全不输入）
    for (const ch of s) {
      await chromeDebuggerSendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch })
    }
  }
}

// CDP 真实按键（rawKeyDown + keyUp），用于触发富文本编辑器的快捷键/提交
// （如飞书聊天框 Enter 发送 —— 合成 keydown 它不认）。
async function cdpKeyPress(tabId, key) {
  await ensureCdpAttached(tabId)
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key
  const vkMap = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27 }
  const ev = { key, code, windowsVirtualKeyCode: vkMap[key] || 0 }
  await chromeDebuggerSendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...ev })
  await chromeDebuggerSendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", ...ev })
}

// ---- CDP 工具的 安全门 / 自动聚焦 / 串行化 / 资源清理 基建 ----
// 危险操作关键词（与 content.js DANGEROUS_RE 对齐）。CDP 是真实输入(isTrusted=true)，
// 命中危险词的元素点击/提交必须显式 confirmed:true，否则拦截——防误删/误发/误支付。
const DANGEROUS_RE = /(提交|保存|删除|作废|下架|审核|确认|同意|拒绝|取消|支付|购买|卸载|发送|退出|approve|submit|delete|remove|confirm|accept|reject|cancel|pay|purchase|install|uninstall|send|exit|logout)/i

// 剥离 JS 源码里的字符串字面量与注释，供 execute_js 危险词扫描用——避免只读查询里字符串/选择器
// 含"发送/删除"被误拦（如 querySelector('[class*=发送给]')、读"发送按钮"文本）。剥离后只扫"代码逻辑本身"。
// 粗略正则：不解析模板字符串 ${} 嵌套（嵌套表达式里的危险词可能漏报，但漏报比误拦安全；确需时 confirmed:true）。
function stripJsStringsAndComments(code) {
  return String(code || "")
    .replace(/\/\/.*$/gm, "") // 行注释
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // 双引号字符串
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // 单引号字符串
    .replace(/`(?:[^`\\]|\\.)*`/g, "``") // 模板字符串（粗略）
}

// 同一 tab 的 CDP 操作排成队列：避免并发 type_text 的 char 流交错、clearEditor 插进别人 type 中间。
const cdpQueues = new Map() // tabId -> Promise 链尾
function runSerial(tabId, fn) {
  const prev = cdpQueues.get(tabId) || Promise.resolve()
  const next = prev.then(fn, fn) // 前一个无论成败都继续
  cdpQueues.set(tabId, next.catch(() => {})) // 链不因错误断
  return next
}

// 读 (x,y) 处元素的 label（用于 dangerous 判定）。
async function cdpGetLabelAt(tabId, x, y) {
  await ensureCdpAttached(tabId)
  const res = await chromeDebuggerSendCommand({ tabId }, "Runtime.evaluate", {
    expression: `(()=>{const el=document.elementFromPoint(${x},${y});if(!el)return'';return(el.innerText||el.value||el.getAttribute('aria-label')||el.getAttribute('title')||'').slice(0,200)})()`,
    returnByValue: true,
  })
  return String(res?.result?.value || "")
}

// 解析 uid/selector/x,y → 视口坐标（CDP 输入前自动聚焦目标，否则文字发到错的 activeElement）。返回 null=无需/无法聚焦。
async function cdpResolvePoint(tabId, args) {
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
    return { x: Number(args.x), y: Number(args.y) }
  }
  if (args.uid || args.selector) {
    const state = await sendToContent(tabId, "omeety_get_verification_state", {
      uid: args.uid,
      selector: args.selector,
    }).catch(() => null)
    const bbox = state?.result?.target?.bbox
    if (bbox && Number.isFinite(bbox.x) && Number.isFinite(bbox.y)) {
      return {
        x: bbox.x + bbox.w / 2,
        y: bbox.y + bbox.h / 2,
        label: state.result.target.accessibleName || state.result.target.text || "",
      }
    }
  }
  let expr = null
  if (args.uid && args.uid !== "pick") {
    expr = `(()=>{const el=document.querySelector('[data-omeety-uid=${JSON.stringify(String(args.uid))}]');if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`
  } else if (args.selector) {
    expr = `(()=>{const el=document.querySelector(${JSON.stringify(String(args.selector))});if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`
  }
  if (!expr) return null
  await ensureCdpAttached(tabId)
  try {
    const res = await chromeDebuggerSendCommand({ tabId }, "Runtime.evaluate", { expression: expr, returnByValue: true })
    const v = res?.result?.value
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return { x: v.x, y: v.y }
  } catch { /* ignore */ }
  return null
}

function isCdpTool(name, args) {
  if (name === "omeety_cdp_click_at" || name === "omeety_cdp_type_text") return true
  return !!args?.cdp && (name === "omeety_click_at" || name === "omeety_type_text" || name === "omeety_fill" || name === "omeety_press_key")
}

// 统一执行 CDP 工具：dangerous 确认门 + 自动聚焦 + 真实输入。调用方用 runSerial 包裹保证同 tab 串行。
async function execCdpTool(tabId, name, args) {
  const isClick = (name === "omeety_click_at" && args.cdp) || name === "omeety_cdp_click_at"
  const isType = ((name === "omeety_type_text" || name === "omeety_fill") && args.cdp) || name === "omeety_cdp_type_text"
  const isPress = name === "omeety_press_key" && args.cdp

  if (isClick) {
    const point = await cdpResolvePoint(tabId, args)
    const cx = Number(point?.x), cy = Number(point?.y)
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) throw new Error("click_at(cdp) 需要可解析的 uid/selector 或数值 x,y")
    if (!args.confirmed) {
      const label = point?.label || await cdpGetLabelAt(tabId, cx, cy).catch(() => "")
      if (label && DANGEROUS_RE.test(label)) {
        throw new Error(`坐标(${cx},${cy})命中危险元素"${label.slice(0, 40)}"——需 confirmed:true 才执行（或先用 omeety_request_user_confirmation 让用户确认）`)
      }
    }
    await cdpMouseClick(tabId, cx, cy, 1)
    return { ok: true, result: { clicked: true, x: cx, y: cy, method: "cdp:Input.dispatchMouseEvent", tabId } }
  }
  if (isType) {
    const ctext = name === "omeety_fill" ? String(args.value ?? "") : String(args.text ?? "")
    const clear = name === "omeety_fill" ? true : args.clear !== false
    const pt = await cdpResolvePoint(tabId, args) // 自动聚焦：uid/selector/x,y → 先点一下
    if (pt) await cdpMouseClick(tabId, pt.x, pt.y, 1)
    await cdpTypeText(tabId, ctext, clear)
    return { ok: true, result: { typed: true, textLength: ctext.length, cleared: clear, focused: !!pt, method: "cdp:Input.insertText", tabId } }
  }
  if (isPress) {
    const ckey = String(args.key || "")
    if (!ckey) throw new Error("press_key 需要 key")
    const pt = await cdpResolvePoint(tabId, args)
    if (pt) await cdpMouseClick(tabId, pt.x, pt.y, 1)
    await cdpKeyPress(tabId, ckey)
    return { ok: true, result: { pressed: true, key: ckey, focused: !!pt, method: "cdp:Input.dispatchKeyEvent", tabId } }
  }
  throw new Error("未知 CDP 工具：" + name)
}

// 清理某 tab 的 CDP 状态（detach + 清 Set/Map）。tab 关闭 / 用户手动取消调试 / 错误自愈时调。
async function cdpDetachTab(tabId) {
  try { await chromeDebuggerDetach({ tabId }) } catch { /* 可能已 detach */ }
  cdpAttachedTabs.delete(tabId)
  cdpEnabledDomains.delete(tabId)
  cdpQueues.delete(tabId)
}
// tab 关闭 / 用户在 chrome://extensions 手动取消调试 → 清理，避免泄漏和 "Another debugger" 状态错配。
chrome.tabs.onRemoved.addListener((tabId) => {
  consoleLogs.delete(tabId)
  const fc = pendingFileChoosers.get(tabId)
  if (fc) { clearTimeout(fc.timer); pendingFileChoosers.delete(tabId) }
  if (lastPick?.tabId === tabId) lastPick = null // 该 tab 关了，它的 pick 失效，避免串到别的 tab
  if (cdpAttachedTabs.has(tabId)) void cdpDetachTab(tabId)
})
// 切换活动标签页 → 通知面板（选取态切 tab 时提示：选取按页面独立，本页需重选）
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId)
    .then((t) => broadcast({ type: "active_tab_changed", tabId: activeInfo.tabId, title: t?.title || "" }))
    .catch(() => broadcast({ type: "active_tab_changed", tabId: activeInfo.tabId, title: "" }))
})
if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    const tid = source?.tabId
    if (tid != null) { cdpAttachedTabs.delete(tid); cdpEnabledDomains.delete(tid); cdpQueues.delete(tid) }
  })
}

// ---------- tool_call 路由 ----------
async function handleToolCall({ id, name, args }) {
  // 注意：tab 必须声明在 try 外——之前 const 在 try 块内，catch 里引用直接 ReferenceError，
  // 导致任何失败的工具调用连 tool_result 都发不出去，agent 端只能干等 60s 超时。
  let tab = null
  const toolStarted = performance.now()
  try {
    tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null
    let r
    if (name === "omeety_get_context_bundle") {
      if (!tab?.id) throw new Error("没有活动标签页")
      r = await buildContextBundle(tab.id, args)
    } else if (name === "omeety_act_and_verify") {
      if (!tab?.id) throw new Error("没有活动标签页")
      r = await actAndVerify(tab.id, args)
    } else if (name === "omeety_get_runtime_metrics") {
      r = { ok: true, result: getRuntimeMetrics() }
    } else if (name === "omeety_capture_visible_tab") {
      r = await captureDownscaled(tab?.id)
    } else if (name === "omeety_get_user_pick") {
      // 只返回"当前活动 tab"的 pick——否则切到别的 tab 后会拿到旧 tab 的元素，click/fill(uid:'pick') 作用到错页面。
      const curTabId = tab?.id ?? null
      if (lastPick && lastPick.tabId != null && lastPick.tabId !== curTabId) {
        r = { ok: true, result: { pick: null, msg: `pick 来自 tab ${lastPick.tabId}，当前活动 tab 是 ${curTabId}，请在该 tab 重新点 📌 选取` } }
      } else {
        r = lastPick
          ? { ok: true, result: lastPick }
          : { ok: true, result: { pick: null, msg: "用户还没选取元素。让用户点侧栏 📌 选取，再到页面点一下目标元素。" } }
      }
    } else if (name === "omeety_list_tabs") {
      const tabs = await chrome.tabs.query({})
      r = { ok: true, result: { count: tabs.length, tabs: tabs.map((t) => ({ id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url })) } }
    } else if (name === "omeety_close_tab") {
      const tid = Number(args.tabId)
      if (!tid) throw new Error("close_tab 需要 tabId")
      await chrome.tabs.remove(tid)
      r = { ok: true, result: { closed: true, tabId: tid } }
    } else if (name === "omeety_open_tab") {
      const url = String(args.url || "")
      if (!/^https?:\/\//i.test(url)) throw new Error("open_tab 需要 http(s) url")
      const t = await chrome.tabs.create({ url, active: args.active !== false })
      r = { ok: true, result: { id: t.id, windowId: t.windowId, url: t.pendingUrl || t.url || url, title: t.title || "", active: t.active } }
    } else if (name === "omeety_switch_tab") {
      const tid = Number(args.tabId)
      if (!tid) throw new Error("switch_tab 需要 tabId")
      const t = await chrome.tabs.update(tid, { active: true })
      try { await chrome.windows.update(t.windowId, { focused: true }) } catch { /* 窗口聚焦失败不致命 */ }
      r = { ok: true, result: { activated: true, tabId: tid, url: t.url, title: t.title } }
    } else if (name === "omeety_navigate") {
      if (!tab?.id) throw new Error("没有活动标签页")
      const url = String(args.url || "")
      if (!/^https?:\/\//i.test(url)) throw new Error("navigate 需要 http(s) url")
      await chrome.tabs.update(tab.id, { url })
      r = { ok: true, result: { navigating: true, tabId: tab.id, url, hint: "导航是异步的：用 omeety_wait_for 等目标元素/文本出现后再操作" } }
    } else if (name === "omeety_reload") {
      const tid = Number(args.tabId) || tab?.id
      if (!tid) throw new Error("没有活动标签页")
      await chrome.tabs.reload(tid, { bypassCache: !!args.bypassCache })
      r = { ok: true, result: { reloaded: true, tabId: tid } }
    } else if (name === "omeety_go_back") {
      const tid = Number(args.tabId) || tab?.id
      if (!tid) throw new Error("没有活动标签页")
      if (args.forward) await chrome.tabs.goForward(tid)
      else await chrome.tabs.goBack(tid)
      r = { ok: true, result: { moved: true, direction: args.forward ? "forward" : "back", tabId: tid } }
    } else if (name === "omeety_execute_js") {
      if (!tab?.id) throw new Error("没有活动标签页")
      // 安全门：execute_js 是任意代码执行，等于所有其他工具的超集，可绕过 DANGEROUS_RE 确认门。
      // code 命中危险词(删除/提交/支付/发送…)且未 confirmed 时拦截——防 prompt-injection 或误操作借它删数据。
      const jsCode = String(args.code ?? args.expression ?? "")
      // 扫描前剥离字符串/注释：只对代码逻辑本身判危险词，不误伤只读查询里的字符串字面量（如选择器/可见文本含"发送给"）。
      if (!args.confirmed && DANGEROUS_RE.test(stripJsStringsAndComments(jsCode))) {
        throw new Error("execute_js 的代码命中危险词(删除/提交/支付/发送等)，需 confirmed:true——它可执行任意 JS、绕过普通工具的确认门")
      }
      // 走 per-tab 串行队列：execute_js 读 DOM/调函数若与并发的 CDP 输入交错，会读到半输入的中间态。
      r = await runSerial(tab.id, () => executeJsInTab(tab.id, args))
    } else if (name === "omeety_upload_file") {
      // CDP 拦截文件选择对话框 + handleFileChooser：往页面文件输入框塞本地文件（截图/压缩包等）。
      if (!tab?.id) throw new Error("没有活动标签页")
      r = await runSerial(tab.id, () => uploadFile(tab.id, args))
    } else if (name === "omeety_get_console_logs") {
      const tid = Number(args.tabId) || tab?.id
      if (!tid) throw new Error("没有活动标签页")
      r = await getConsoleLogs(tid, args)
    } else if (isCdpTool(name, args)) {
      // 所有 CDP 工具统一走 per-tab 串行队列 + execCdpTool（dangerous 门 / 自动聚焦 / 真实输入）。
      if (!tab?.id) throw new Error("没有活动标签页")
      r = await runSerial(tab.id, () => execCdpTool(tab.id, name, args))
    } else if (name === "omeety_wait_for") {
      // wait_for 在 background 逐次探测。页面发生 reload/navigation 时旧 content script
      // 可以安全销毁；新文档注入完成后继续等，不再把 message channel closed 当作工具失败。
      r = await waitForAcrossNavigation(tab?.id, args)
    } else if (name === "omeety_click" && (args?.waitForSelector || args?.waitForText)) {
      // 点击与等待拆成两个阶段。等待若跨文档，仍由上面的导航恢复轮询接管。
      const clickArgs = { ...args }
      delete clickArgs.waitForSelector
      delete clickArgs.waitForText
      delete clickArgs.waitForTimeoutMs
      const clicked = await sendToContent(tab?.id, name, clickArgs)
      if (!clicked.ok) {
        r = clicked
      } else {
        const waited = await waitForAcrossNavigation(tab?.id, {
          selector: args.waitForSelector,
          text: args.waitForText,
          timeoutMs: args.waitForTimeoutMs ?? 5000,
        })
        r = waited.ok
          ? { ok: true, result: { ...clicked.result, waited: waited.result } }
          : waited
      }
    } else {
      r = await sendToContent(tab?.id, name, args)
    }
    recordToolMetric(name, !!r?.ok, Math.round((performance.now() - toolStarted) * 10) / 10)
    sendNative({ type: "tool_result", id, ok: !!r?.ok, result: r?.result, error: r?.error })
  } catch (e) {
    // CDP 状态自愈：若错误是 debugger 脱钩（tab 崩溃/用户手动取消调试/SW 重启后状态脏），
    // 清掉该 tab 的 attach 记录，下次调用重新 attach，而不是永远报 "Another debugger is already attached"。
    const m = String(e?.message || "")
    if (tab?.id && /not attached|another debugger|target closed|cannot access/i.test(m)) {
      cdpAttachedTabs.delete(tab.id)
      cdpEnabledDomains.delete(tab.id)
    }
    recordToolMetric(name, false, Math.round((performance.now() - toolStarted) * 10) / 10)
    sendNative({ type: "tool_result", id, ok: false, error: m })
  }
}

// 在活动页执行任意 JS（可读写页面变量、调页面函数、await 异步逻辑），是专用工具之外的
// 万能逃生舱。通过 CDP Runtime.evaluate 直接解析源码，不使用 eval/new Function，因此严格 CSP
// 页面也可运行。返回值在页面侧转成字符串，超长截 200KB。
async function executeJsInTab(tabId, args = {}) {
  const code = String(args.code ?? args.expression ?? "")
  if (!code.trim()) return { ok: false, error: "execute_js 需要 code" }
  const world = String(args.world || "MAIN").toUpperCase() === "ISOLATED" ? "ISOLATED" : "MAIN"
  try {
    await ensureCdpAttached(tabId)
    let contextId
    if (world === "ISOLATED") {
      const tree = await chromeDebuggerSendCommand({ tabId }, "Page.getFrameTree", {})
      const frameId = tree?.frameTree?.frame?.id
      if (!frameId) throw new Error("execute_js 无法确定页面主 frame")
      const isolated = await chromeDebuggerSendCommand({ tabId }, "Page.createIsolatedWorld", {
        frameId,
        worldName: "omeety_terminal_execute_js",
        grantUniveralAccess: false,
      })
      contextId = isolated?.executionContextId
      if (!contextId) throw new Error("execute_js 无法创建 isolated world")
    }
    const response = await chromeDebuggerSendCommand({ tabId }, "Runtime.evaluate", {
      expression: buildPageEvaluationExpression(code),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      ...(contextId ? { contextId } : {}),
    })
    if (response?.exceptionDetails) {
      const detail = response.exceptionDetails
      const error = detail.exception?.description || detail.text || "execute_js 解析/执行失败"
      return { ok: false, error }
    }
    const value = response?.result?.value
    if (!value || typeof value !== "object") {
      return { ok: false, error: "execute_js 无返回（受限页面如 chrome:// 无法执行）" }
    }
    return value.ok
      ? { ok: true, result: { value: value.value, world, transport: "cdp:Runtime.evaluate" } }
      : { ok: false, error: value.error || "execute_js 执行失败" }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// console 日志环形缓冲（per tab）：CDP attach 后收 Runtime.consoleAPICalled / Runtime.exceptionThrown /
// Log.entryAdded。agent 排查"点了没反应""页面报错"时直接读，不用让用户开 DevTools。
const consoleLogs = new Map() // tabId -> [{level, text, ts, source}]
const CONSOLE_LOG_MAX = 300

function pushConsoleLog(tabId, entry) {
  let arr = consoleLogs.get(tabId)
  if (!arr) {
    arr = []
    consoleLogs.set(tabId, arr)
  }
  arr.push(entry)
  if (arr.length > CONSOLE_LOG_MAX) arr.splice(0, arr.length - CONSOLE_LOG_MAX)
}

if (chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source?.tabId
    if (tabId == null) return
    if (method === "Runtime.consoleAPICalled") {
      const text = (params.args || [])
        .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
        .join(" ")
      pushConsoleLog(tabId, { level: params.type, text: String(text).slice(0, 2000), ts: Date.now(), source: "console" })
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails || {}
      const text = d.exception?.description || d.text || "exception"
      pushConsoleLog(tabId, { level: "error", text: String(text).slice(0, 2000), ts: Date.now(), source: "exception" })
    } else if (method === "Log.entryAdded") {
      const e = params.entry || {}
      pushConsoleLog(tabId, { level: e.level || "log", text: String(e.text || "").slice(0, 2000), ts: e.timestamp || Date.now(), source: e.source || "log" })
    } else if (method === "Page.fileChooserOpened") {
      // upload_file 拦截到文件选择对话框 → resolve 等待中的 waiter
      const w = pendingFileChoosers.get(tabId)
      if (w) { clearTimeout(w.timer); pendingFileChoosers.delete(tabId); w.resolve(params) }
    }
  })
}

async function getConsoleLogs(tabId, args = {}) {
  const firstAttach = !cdpAttachedTabs.has(tabId)
  await ensureCdpAttached(tabId) // 会出"正在调试此浏览器"黄条
  await ensureCdpDomains(tabId, ["Log"])
  const limit = Math.min(Math.max(Number(args.limit) || 100, 1), CONSOLE_LOG_MAX)
  const logs = (consoleLogs.get(tabId) || []).slice(-limit)
  if (args.clear) consoleLogs.set(tabId, [])
  return {
    ok: true,
    result: {
      tabId,
      count: logs.length,
      logs,
      note: firstAttach ? "刚 attach 调试器：只能收到此刻之后的日志，复现操作后再调一次本工具" : undefined,
    },
  }
}

// pending file-chooser waiters: tabId -> {resolve, timer}（upload_file 用）
const pendingFileChoosers = new Map()

// 往页面文件输入框塞本地文件。流程：setIntercept → 点触发按钮 → 等 Page.fileChooserOpened
// → DOM.setFileInputFiles 给 input 节点注入真实文件（绕过 JS FileList 安全限制）。
// 注：旧版用 Page.handleFileChooser，但该方法自 Chromium ~128 起已从 CDP 移除（Edge 150 / Chromium 150
// 必然报 "'Page.handleFileChooser' wasn't found"），改用 DOM.setFileInputFiles + chooser 事件返回的 backendNodeId。
async function uploadFile(tabId, args) {
  const filePath = String(args.filePath || args.path || "")
  if (!filePath) throw new Error("upload_file 需要 filePath（本地文件绝对路径）")
  await ensureCdpAttached(tabId)
  await ensureCdpDomains(tabId, ["Page"])
  await chromeDebuggerSendCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: true })
  const chooserPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingFileChoosers.get(tabId)?.resolve === resolve) pendingFileChoosers.delete(tabId)
      reject(new Error("upload_file: 点了按钮但 5s 内没等到文件选择对话框（目标可能不是文件上传入口）"))
    }, 5000)
    pendingFileChoosers.set(tabId, { resolve, timer })
  })
  try {
    const pt = await cdpResolvePoint(tabId, args)
    if (!pt) throw new Error("upload_file 需要 x,y 或 uid/selector（指向会弹出文件选择对话框的按钮）")
    await cdpMouseClick(tabId, pt.x, pt.y, 1)
    const chooser = await chooserPromise // {frameId, element(=backendNodeId), mode}
    // chooser.element 即 file input 的 backendNodeId，直接喂给 DOM.setFileInputFiles。
    const backendNodeId = chooser?.element ?? chooser?.backendNodeId ?? null
    if (backendNodeId != null) {
      await chromeDebuggerSendCommand({ tabId }, "DOM.setFileInputFiles", { files: [filePath], backendNodeId })
    } else {
      // 兜底：chooser 没带节点（极少）→ 在页面里找 <input type=file> 用 objectId 注入
      await setFileInputByQuery(tabId, filePath)
    }
    return { ok: true, result: { uploaded: true, filePath, method: "DOM.setFileInputFiles" } }
  } finally {
    try { await chromeDebuggerSendCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: false }) } catch { /* ignore */ }
    const w = pendingFileChoosers.get(tabId)
    if (w) { clearTimeout(w.timer); pendingFileChoosers.delete(tabId) }
  }
}

// 兜底：chooser 事件没给 backendNodeId 时，定位页面里（含动态生成）的 <input type=file>，用 RemoteObject objectId 注入文件。
async function setFileInputByQuery(tabId, filePath) {
  const res = await chromeDebuggerSendCommand({ tabId }, "Runtime.evaluate", {
    expression: `(()=>{const xs=document.querySelectorAll('input[type=file]');return xs.length?xs[xs.length-1]:null})()`,
  })
  const objectId = res?.result?.objectId
  if (!objectId) throw new Error("upload_file: 没找到 <input type=file> 元素（chooser 未返回节点且页面无 file input）")
  await chromeDebuggerSendCommand({ tabId }, "DOM.setFileInputFiles", { files: [filePath], objectId })
}

async function buildContextBundle(tabId, args = {}) {
  const started = performance.now()
  const content = await sendToContent(tabId, "omeety_get_context_bundle", args)
  if (!content.ok) return content
  const bundle = content.result
  if (args.includeScreenshot !== false && bundle?.screenshotRequest?.bbox) {
    const screenshot = await captureDownscaled(tabId, {
      maxWidth: Math.min(Math.max(Number(args.screenshotMaxWidth) || 900, 320), 1280),
      crop: {
        bbox: bundle.screenshotRequest.bbox,
        padding: bundle.screenshotRequest.padding,
        viewport: bundle.page?.viewport,
      },
    })
    if (screenshot.ok) bundle.screenshot = screenshot.result
    else bundle.screenshot = { error: screenshot.error }
  }
  delete bundle.screenshotRequest

  let logs = consoleLogs.get(tabId) || []
  let attachedForBundle = false
  if (args.attachDebugger) {
    const diagnostics = await getConsoleLogs(tabId, { limit: Number(args.consoleLimit) || 30 })
    logs = diagnostics.result?.logs || []
    attachedForBundle = true
  }
  const consoleLimit = Math.min(Math.max(Number(args.consoleLimit) || 20, 1), 100)
  bundle.diagnostics = {
    consoleAttached: cdpAttachedTabs.has(tabId),
    attachedForBundle,
    console: logs
      .filter((entry) => args.includeAllConsole || ["error", "warning", "warn", "exception"].includes(String(entry.level).toLowerCase()))
      .slice(-consoleLimit),
  }
  bundle.metrics = {
    ...(bundle.metrics || {}),
    totalMs: Math.round((performance.now() - started) * 10) / 10,
  }
  return { ok: true, result: bundle }
}

async function actAndVerify(tabId, args = {}) {
  const started = performance.now()
  const action = String(args.action || "")
  const target = {
    ...(args.uid ? { uid: String(args.uid) } : {}),
    ...(args.selector ? { selector: String(args.selector) } : {}),
    ...(Number.isFinite(Number(args.x)) ? { x: Number(args.x) } : {}),
    ...(Number.isFinite(Number(args.y)) ? { y: Number(args.y) } : {}),
  }
  const before = await sendToContent(tabId, "omeety_get_verification_state", target)
  const actionArgs = {
    ...target,
    ...(args.confirmed ? { confirmed: true } : {}),
    ...(args.backgroundTask ? { backgroundTask: true } : {}),
    ...(args.cdp ? { cdp: true } : {}),
  }
  let toolName
  if (action === "click") {
    toolName = args.cdp || ("x" in target && "y" in target) ? "omeety_click_at" : "omeety_click"
  } else if (action === "click_text") {
    toolName = "omeety_click_text"
    actionArgs.text = String(args.text || "")
    actionArgs.exact = !!args.exact
  } else if (action === "fill") {
    toolName = "omeety_fill"
    actionArgs.value = String(args.value ?? "")
  } else if (action === "type") {
    toolName = "omeety_type_text"
    actionArgs.text = String(args.text ?? "")
    actionArgs.clear = args.clear !== false
  } else if (action === "press") {
    toolName = "omeety_press_key"
    actionArgs.key = String(args.key || "")
  } else if (action === "select") {
    toolName = "omeety_select"
    actionArgs.value = String(args.value ?? "")
  } else {
    return { ok: false, error: "act_and_verify.action 需要 click/click_text/fill/type/press/select" }
  }

  let acted
  if (isCdpTool(toolName, actionArgs)) acted = await runSerial(tabId, () => execCdpTool(tabId, toolName, actionArgs))
  else acted = await sendToContent(tabId, toolName, actionArgs)
  if (!acted.ok) return acted

  const expectation = { ...(args.expect || {}) }
  if (action === "fill" || action === "select") expectation.valueEquals ??= String(args.value ?? "")
  if (action === "type") {
    if (args.clear !== false) expectation.valueEquals ??= String(args.text ?? "")
    else expectation.valueIncludes ??= String(args.text ?? "")
  }
  if (target.uid) expectation.targetUid ??= target.uid
  if (target.selector) expectation.targetSelector ??= target.selector
  expectation.match = expectation.match === "any" ? "any" : "all"
  expectation.timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? expectation.timeoutMs ?? 8000), 500), 60000)
  const conditionKeys = ["selector", "text", "selectorGone", "textGone", "urlIncludes", "titleIncludes", "valueEquals", "valueIncludes", "checked"]
  const hasExpectation = conditionKeys.some((key) => expectation[key] !== undefined)

  let waited = null
  if (hasExpectation) waited = await waitForAcrossNavigation(tabId, expectation)
  else await waitDelay(Math.min(Math.max(Number(args.settleMs) || 250, 50), 2000))
  const after = await sendToContent(tabId, "omeety_get_verification_state", target)
  const beforeState = before.ok ? before.result : null
  const afterState = after.ok ? after.result : null
  const comparable = (state) => state ? { url: state.url, title: state.title, textDigest: state.textDigest, target: state.target } : null
  const stateChanged = JSON.stringify(comparable(beforeState)) !== JSON.stringify(comparable(afterState))
  const verified = hasExpectation ? Boolean(waited?.ok && waited.result?.found && !waited.result?.timeout) : stateChanged

  return {
    ok: true,
    result: {
      action: { name: toolName, result: acted.result },
      verified,
      verificationStrength: hasExpectation ? "strong-explicit-postcondition" : "weak-observed-state-change",
      stateChanged,
      expectation: hasExpectation ? expectation : null,
      waited: waited?.result || null,
      before: beforeState,
      after: afterState,
      timing: { totalMs: Math.round((performance.now() - started) * 10) / 10 },
    },
  }
}

async function sendToContent(tabId, name, args) {
  if (!tabId) return { ok: false, error: "没有活动标签页" }
  const payload = { type: "omeety_execute_tool", tool: name, arguments: args }
  try {
    const r = await chrome.tabs.sendMessage(tabId, payload)
    return normalizeContent(r)
  } catch (e) {
    if (isMissingContent(e)) {
      // 该标签页早于扩展打开、content.js 未注入 → 注入后重试一次
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
      } catch {
        /* ignore */
      }
      try {
        await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] })
      } catch {
        /* ignore */
      }
      try {
        const r = await chrome.tabs.sendMessage(tabId, payload)
        return normalizeContent(r)
      } catch (retryError) {
        return { ok: false, error: retryError?.message || String(retryError) }
      }
    }
    return { ok: false, error: e?.message || String(e) }
  }
}

// content.js 成功时直接返回“裸数据对象”（无 ok/result 字段，如 {url,title,visibleText,...}），
// 失败时返回 {ok:false,error}。这里统一归一化成 background 的 {ok,result,error}，
// 否则 handleToolCall 会把裸数据当成 ok:false → MCP 每次回 isError，真实数据全丢。
function normalizeContent(r) {
  if (!r) return { ok: false, error: "content 无响应" }
  if (r.ok === true) return { ok: true, result: r.result !== undefined ? r.result : r }
  if (r.ok === false) return { ok: false, error: r.error || "content 工具执行失败" }
  return { ok: true, result: r }
}

function isMissingContent(e) {
  return isTransientContentErrorMessage(e?.message || e)
}

const waitDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 每次只向当前文档发一个立即探测，轮询状态留在 service worker。这样旧页面进入
// BFCache、reload 或跨站导航时，message channel 中断只是可恢复的中间态。
async function waitForAcrossNavigation(tabId, args = {}) {
  if (!tabId) return { ok: false, error: "没有活动标签页" }
  const expectationArgs = {
    ...(args.selector ? { selector: String(args.selector) } : {}),
    ...(args.text ? { text: String(args.text) } : {}),
    ...(args.selectorGone ? { selectorGone: String(args.selectorGone) } : {}),
    ...(args.textGone ? { textGone: String(args.textGone) } : {}),
    ...(args.urlIncludes ? { urlIncludes: String(args.urlIncludes) } : {}),
    ...(args.titleIncludes ? { titleIncludes: String(args.titleIncludes) } : {}),
    ...(args.valueEquals !== undefined ? { valueEquals: String(args.valueEquals) } : {}),
    ...(args.valueIncludes !== undefined ? { valueIncludes: String(args.valueIncludes) } : {}),
    ...(typeof args.checked === "boolean" ? { checked: args.checked } : {}),
    ...(args.targetUid ? { targetUid: String(args.targetUid) } : {}),
    ...(args.targetSelector ? { targetSelector: String(args.targetSelector) } : {}),
    ...(args.match === "all" ? { match: "all" } : {}),
  }
  const conditionKeys = ["selector", "text", "selectorGone", "textGone", "urlIncludes", "titleIncludes", "valueEquals", "valueIncludes", "checked"]
  if (!conditionKeys.some((key) => key in expectationArgs)) return { ok: false, error: "wait_for 需要至少一个验证条件" }
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 10000), 500), 60000)
  const started = Date.now()
  let transientError = ""
  for (;;) {
    const probe = await sendToContent(tabId, "omeety_wait_for", { ...expectationArgs, probeOnly: true })
    if (probe.ok && probe.result?.found) {
      return {
        ok: true,
        result: {
          ...probe.result,
          waitedMs: Date.now() - started,
          navigationResilient: true,
        },
      }
    }
    if (!probe.ok) {
      if (!isTransientContentErrorMessage(probe.error)) return probe
      transientError = probe.error || transientError
    }
    const elapsed = Date.now() - started
    if (elapsed >= timeoutMs) {
      return {
        ok: true,
        result: {
          found: false,
          timeout: true,
          waitedMs: elapsed,
          navigationResilient: true,
          lastTransientError: transientError || undefined,
        },
      }
    }
    await waitDelay(Math.min(200, timeoutMs - elapsed))
  }
}

// ---------- 截图 + 下采样（SW 用 OffscreenCanvas，单消息 <1MB）----------
// 固定宽 1280（原来是 scale 0.5）：4K 屏 0.5 后仍有 1920 宽、base64 易逼近 1MB 上限；
// 视觉模型本身也只按 ~1.5K 像素读图，1280 宽 q0.7 ≈ 150-350KB，清晰度和体积都可预期。
const SCREENSHOT_MAX_WIDTH = 1280
async function captureDownscaled(tabId, options = {}) {
  const tab = tabId ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  if (!tab) return { ok: false, error: "没有活动标签页" }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  const img = await downscale(dataUrl, Number(options.maxWidth) || SCREENSHOT_MAX_WIDTH, 0.7, options.crop)
  return {
    ok: true,
    result: {
      dataUrl: img.dataUrl,
      mimeType: "image/jpeg",
      url: tab.url,
      title: tab.title,
      capturedAt: new Date().toISOString(),
      originalMime: "image/png",
      downscaled: true,
      // 截图坐标空间：图为物理像素（dpr 缩放后），与 click_at / snapshot.bbox 的 CSS 像素不一致。
      // agent 从截图读坐标点击时，配 omeety_get_page_snapshot 的 viewport.devicePixelRatio 换算：
      //   CSS_x = screenshot_x × (viewport.width / image.width)
      image: { width: img.width, height: img.height, originalWidth: img.originalWidth, originalHeight: img.originalHeight },
      sourceRect: img.sourceRect,
      coordinateSpace: img.sourceRect
        ? "element crop derived from CSS bbox; sourceRect is in original physical screenshot pixels"
        : "physical-pixels — divide by devicePixelRatio (from snapshot.viewport) to map to CSS pixels used by click_at",
    },
  }
}

async function downscale(dataUrl, maxWidth, quality, crop = null) {
  const blob = await (await fetch(dataUrl)).blob()
  const bmp = await createImageBitmap(blob)
  try {
    let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height
    let sourceRect = null
    const bbox = crop?.bbox
    const viewport = crop?.viewport
    if (bbox && viewport?.width && viewport?.height) {
      const scaleX = bmp.width / Number(viewport.width)
      const scaleY = bmp.height / Number(viewport.height)
      const padding = Math.max(0, Number(crop.padding) || 0)
      sx = Math.min(bmp.width - 1, Math.max(0, Math.floor((Number(bbox.x) - padding) * scaleX)))
      sy = Math.min(bmp.height - 1, Math.max(0, Math.floor((Number(bbox.y) - padding) * scaleY)))
      const right = Math.min(bmp.width, Math.max(sx + 1, Math.ceil((Number(bbox.x) + Number(bbox.w) + padding) * scaleX)))
      const bottom = Math.min(bmp.height, Math.max(sy + 1, Math.ceil((Number(bbox.y) + Number(bbox.h) + padding) * scaleY)))
      sw = right - sx
      sh = bottom - sy
      sourceRect = { x: sx, y: sy, width: sw, height: sh }
    }
    const scale = Math.min(1, maxWidth / sw)
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext("2d")
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h)
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality })
    const buf = await out.arrayBuffer()
    return {
      dataUrl: `data:image/jpeg;base64,${bufToB64(buf)}`,
      originalWidth: bmp.width, // 物理像素（captureVisibleTab 返回设备像素）
      originalHeight: bmp.height,
      width: w, // 下采样后实际像素 = agent 在图上读到的坐标空间
      height: h,
      sourceRect,
    }
  } finally {
    bmp.close()
  }
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}
