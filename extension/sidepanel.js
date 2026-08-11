import { loadSettings, saveSettings } from "./storage.js"
import { initTerminal } from "./terminal.js"

const $ = (id) => document.getElementById(id)
const statusDot = $("statusDot")
const statusText = $("statusText")
const terminalView = $("terminalView")
const settingsView = $("settingsView")
const terminalHost = $("terminalHost") // 容器，内含每个 tab 的独立 hostEl
const tabsEl = $("tabs")
const ackGate = $("ackGate")
const shellSelect = $("shellSelect")
const shellCustom = $("shellCustom")
const scrollbackSelect = $("scrollbackSelect")
const keepAliveSelect = $("keepAliveSelect")
const browserPermissionSelect = $("browserPermissionSelect")

let panelPort = null
let curSettings = null
const tabs = new Map() // sid -> { term, hostEl, title }
let activeSid = null
let tabSeq = 0
const closingSids = new Set() // 主动关闭的 tab（点 ×）：忽略 host 回的 pty_exit 提示
let sessionsResolved = false
let sessionsFallbackTimer = null
const sessionMetaTimers = new Map()
let rendererSwitchTimer = null
let tabScrollFrame = 0

// 状态行分层（复用现有 status-row，不新增显示区域）：
//   base 连接态（持久）/ flash 瞬时反馈（TTL 后回 base）/ activity agent 工具活动指示
const statusLayers = { base: { state: "", text: "连接中…" }, flash: null }
function renderStatus() {
  const layer = statusLayers.activity || statusLayers.flash || statusLayers.base
  statusDot.className = "dot " + (layer.state || "")
  statusText.textContent = layer.text
}
function setStatus(state, text) {
  statusLayers.base = { state, text }
  if (statusLayers.flash) return // 瞬时消息未到期，不被连接态覆盖
  renderStatus()
}
function flashStatus(text, ttl = 3500) {
  clearTimeout(flashStatus._t)
  statusLayers.flash = { state: "ok", text }
  renderStatus()
  flashStatus._t = setTimeout(() => { statusLayers.flash = null; renderStatus() }, ttl)
}
// agent 工具活动指示：慢工具执行时 dot 脉动(busy) + "正在执行…"，让用户知道 agent 在忙。
// 独立于 base/flash 层；start 延迟 300ms 才显示——快工具(list_tabs/switch_tab 毫秒级)不闪。
let activityTimer = null
let activeCount = 0
function scheduleActivity(text) {
  clearTimeout(activityTimer)
  activityTimer = setTimeout(() => { statusLayers.activity = { state: "busy", text }; renderStatus() }, 300)
}
function clearActivity() {
  clearTimeout(activityTimer)
  statusLayers.activity = null
  renderStatus()
}

function showView(name) {
  const isSettings = name === "settings"
  terminalView.classList.toggle("active", !isSettings)
  settingsView.classList.toggle("active", isSettings)
  if (!isSettings) {
    tabs.get(activeSid)?.term?.focus()
    tabs.get(activeSid)?.term?.resize()
  }
}

function setSettingsOpen(open) {
  showView(open ? "settings" : "terminal")
  const toggle = $("settingsToggle")
  toggle.textContent = open ? "×" : "⚙"
  toggle.classList.toggle("danger", open)
  toggle.title = open ? "退出设置" : "设置"
}

function resolvedShell() {
  return shellSelect.value === "custom" ? shellCustom.value.trim() : shellSelect.value
}

function send(msg) {
  try {
    panelPort?.postMessage(msg)
  } catch {
    /* port closed */
  }
}

function formatPickedContext(picks) {
  const items = picks.slice(0, 20).map((pick) => {
    const kind = pick.role || pick.tag || "element"
    const text = String(pick.text || pick.label || "").replace(/\s+/g, " ").trim().slice(0, 48)
    return `${pick.uid} ${kind}${text ? ` ${JSON.stringify(text)}` : ""}`
  })
  return `[Omeety selected ${picks.length} web elements: ${items.join("; ")}. Call omeety_get_user_picks for full selector/bbox/url]`
}

function injectPickedContext(picks) {
  if (!activeSid || !picks.length) return
  // 只写可打印文本、不带换行：在 Agent TUI 中等价于粘贴上下文；即使当前
  // 是普通 shell，也只会进入编辑行而不会意外执行命令。
  send({ type: "input", sid: activeSid, data: formatPickedContext(picks) })
  tabs.get(activeSid)?.term?.focus()
}

// ---------- tab 管理（多终端，每个 tab 一个独立 PTY，靠 sid 区分）----------
// 字号改动防抖落盘（500ms 合并连续 Ctrl+滚轮），下次开面板还是上次的字号
let fontSizeSaveTimer = null
function persistFontSize(fs) {
  clearTimeout(fontSizeSaveTimer)
  fontSizeSaveTimer = setTimeout(() => saveSettings({ fontSize: fs }), 500)
}

function makeSid() {
  return `t-${Date.now().toString(36)}-${++tabSeq}`
}

function persistTabMeta(sid) {
  const t = tabs.get(sid)
  if (!t) return
  send({ type: "session_meta", sid, title: t.title, renamed: t.renamed, punctCompat: t.punctCompat })
}

function scheduleTabMeta(sid) {
  clearTimeout(sessionMetaTimers.get(sid))
  sessionMetaTimers.set(sid, setTimeout(() => {
    sessionMetaTimers.delete(sid)
    persistTabMeta(sid)
  }, 500))
}

function createTab(session = {}) {
  const sid = String(session.sid || makeSid())
  if (tabs.has(sid)) return sid
  clearTimeout(rendererSwitchTimer)
  rendererSwitchTimer = null
  const hostEl = document.createElement("div")
  // 先把现有 tab 取消激活，新 tab 直接 active——让 initTerminal 里 term.open 时容器已有真实尺寸，
  // 否则在 display:none 的 0 尺寸容器里 open，xterm 的选区/鼠标坐标会失效（表现为复制选不中）。
  for (const [, t] of tabs) {
    t.hostEl.classList.remove("active")
    t.term?.setActive?.(false)
  }
  hostEl.className = "terminal-tab active"
  terminalHost.appendChild(hostEl)
  activeSid = sid
  const wrapSend = (m) => send({ ...m, sid })
  const rec = {
    term: null,
    hostEl,
    tabEl: null,
    titleEl: null,
    title: String(session.title || `终端 ${tabs.size + 1}`).slice(0, 80),
    renamed: !!session.renamed,
    punctCompat: !!session.punctCompat,
    shell: session.shell || resolvedShell(),
  }
  tabs.set(sid, rec)
  const term = initTerminal({
    hostEl,
    send: wrapSend,
    fontSize: curSettings.fontSize,
    scrollback: curSettings.scrollback,
    onFontSizeChange: persistFontSize,
    // shell 经 OSC 0/2 上报的窗口标题（cmd title / PS $Host.UI.RawUI.WindowTitle / bash PROMPT_COMMAND）
    // → 像 Windows Terminal 一样自动更新 tab 标题；用户手动重命名过的 tab 不覆盖。
    onTitleChange: (t) => {
      const rec = tabs.get(sid)
      if (rec && !rec.renamed && rec.title !== t) {
        rec.title = t
        renderTabs()
        scheduleTabMeta(sid)
      }
    },
  })
  rec.term = term
  term.setPunctCompat?.(rec.punctCompat)
  term.setActive?.(true)
  send({
    type: "hello",
    sid,
    shell: rec.shell,
    title: rec.title,
    renamed: rec.renamed,
    punctCompat: rec.punctCompat,
    cols: curSettings.cols,
    rows: curSettings.rows,
  })
  // 面板重开场景：host/PTY 还活着但 xterm 是新的 → 要最近输出回放，避免一片空白
  send({ type: "replay_request", sid })
  requestAnimationFrame(() => {
    term.resize()
    term.focus()
  })
  renderTabs()
  return sid
}

function newTab(shell) {
  return createTab({ shell: shell || resolvedShell() })
}

function setActive(sid) {
  if (!tabs.has(sid)) return
  if (sid === activeSid) {
    tabs.get(sid)?.term?.focus()
    renderTabs()
    return
  }
  activeSid = sid
  const t = tabs.get(sid)

  // WebGL addon teardown/setup can synchronously block Chromium's main thread.
  // Keep the click path DOM-only and coalesce rapid switches. The outgoing tab
  // stays visible while the target restores its renderer and fits off-screen;
  // only then do we swap visibility. This prevents xterm's short-lived DOM
  // width (before the scrollbar/WebGL metrics settle) from flashing full-width
  // and shrinking a few pixels after every tab switch.
  clearTimeout(rendererSwitchTimer)
  rendererSwitchTimer = setTimeout(() => {
    rendererSwitchTimer = null
    if (activeSid !== sid || !tabs.has(sid)) return
    for (const [candidateSid, candidate] of tabs) {
      if (candidateSid !== sid) candidate.term?.setActive?.(false)
    }
    t.term?.setActive?.(true)
    t.term?.resize()
    for (const [candidateSid, candidate] of tabs) {
      candidate.hostEl.classList.toggle("active", candidateSid === sid)
    }
    t.term?.focus()
  }, 48)
  renderTabs()
}

function closeTab(sid) {
  const t = tabs.get(sid)
  if (!t) return
  clearTimeout(sessionMetaTimers.get(sid))
  sessionMetaTimers.delete(sid)
  closingSids.add(sid) // 标记主动关闭：host 回 pty_exit 时不弹提示
  send({ type: "shutdown", sid }) // 让 host 杀掉这个 PTY
  try {
    t.term?.dispose?.() // 取消 pending rAF + term.dispose（避免对已 dispose 的 term write、闭包不 GC）
  } catch {
    /* ignore */
  }
  t.hostEl.remove()
  t.tabEl?.remove()
  tabs.delete(sid)
  if (tabs.size === 0) {
    newTab() // 至少留一个 tab
  } else if (activeSid === sid) {
    setActive([...tabs.keys()][tabs.size - 1])
  }
  renderTabs()
  setStatus("ok", "已连接") // 关闭后状态回到正常，不留"已退出"提示
}

// shell 退出（非主动关闭）后，在死终端上覆盖一层提示 + [重新打开][关闭]，避免用户继续敲键到尸体
function showExitedOverlay(sid) {
  const t = tabs.get(sid)
  if (!t || !t.hostEl || t._exitedOverlay) return
  const overlay = document.createElement("div")
  overlay.className = "exited-overlay"
  const msg = document.createElement("div")
  msg.className = "exited-msg"
  msg.textContent = "shell 已退出"
  const reopen = document.createElement("button")
  reopen.textContent = "重新打开"
  reopen.className = "primary"
  reopen.onclick = () => {
    overlay.remove()
    t._exitedOverlay = null
    send({ type: "restart", sid, shell: t.shell || resolvedShell(), cols: curSettings.cols, rows: curSettings.rows })
  }
  const close = document.createElement("button")
  close.textContent = "关闭 tab"
  close.onclick = () => closeTab(sid)
  overlay.append(msg, reopen, close)
  t.hostEl.appendChild(overlay)
  t._exitedOverlay = overlay
}

// tab 右键菜单：重命名 + codex 标点兼容开关（per-tab）
let ctxMenuEl = null
function closeTabMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null }
}
// 内联重命名 tab 标题（双击标题或右键菜单触发）：contenteditable，Enter 提交 / Esc 取消 / blur 提交。
// 替代原来的 window.prompt 原生对话框。
function startRename(sid) {
  const t = tabs.get(sid)
  if (!t || !t.titleEl) return
  const el = t.titleEl
  el.contentEditable = "true"
  el.focus()
  const sel = window.getSelection?.()
  if (sel) {
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  const finish = (cancel) => {
    el.contentEditable = "false"
    el.removeEventListener("blur", onBlur)
    el.removeEventListener("keydown", onKey)
    if (cancel) { el.textContent = t.title; return }
    const name = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30)
    if (name && name !== t.title) {
      t.title = name
      t.renamed = true
      renderTabs()
      persistTabMeta(sid)
    } else {
      el.textContent = t.title
    }
  }
  const onBlur = () => finish(false)
  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(false) }
    else if (e.key === "Escape") { e.preventDefault(); finish(true) }
  }
  el.addEventListener("blur", onBlur)
  el.addEventListener("keydown", onKey)
}
function openTabMenu(x, y, sid) {
  closeTabMenu()
  const t = tabs.get(sid)
  if (!t) return
  const m = document.createElement("div")
  m.className = "tab-ctx"
  const rn = document.createElement("button")
  rn.textContent = "重命名…"
  rn.onclick = () => { closeTabMenu(); startRename(sid) }
  const pc = document.createElement("button")
  pc.className = "ctx-toggle" + (t.punctCompat ? " on" : "")
  pc.textContent = (t.punctCompat ? "✓ " : "") + "codex 标点兼容"
  pc.title = "把弯引号“”、破折号、省略号等（codex 经 ConPTY 收不到的）转成直引号等价物，让 codex 能用。claude/kimi 不需要。"
  pc.onclick = () => {
    t.punctCompat = !t.punctCompat
    t.term?.setPunctCompat?.(t.punctCompat)
    persistTabMeta(sid)
    flashStatus(t.punctCompat ? `「${t.title}」已开启 codex 标点兼容` : `「${t.title}」已关闭标点兼容`)
    closeTabMenu()
  }
  m.append(rn, pc)
  document.body.appendChild(m)
  const r = m.getBoundingClientRect()
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px"
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px"
  ctxMenuEl = m
  // 下一帧起，点菜单外即关闭（setTimeout 避免捕获到本次 contextmenu）
  setTimeout(() => {
    const onDown = (ev) => { if (!m.contains(ev.target)) closeTabMenu(); document.removeEventListener("mousedown", onDown, true) }
    document.addEventListener("mousedown", onDown, true)
  }, 0)
}

function ensureTabElement(sid, t) {
  if (t.tabEl) return t.tabEl
  const el = document.createElement("div")
  el.className = "tab"
  el.dataset.sid = sid
  el.setAttribute("role", "tab")
  el.tabIndex = 0
  el.setAttribute("aria-selected", "false")
  const title = document.createElement("span")
  title.className = "tab-title"
  title.title = "双击重命名"
  title.addEventListener("dblclick", () => startRename(sid))
  const close = document.createElement("span")
  close.className = "tab-close"
  close.textContent = "×"
  close.setAttribute("role", "button")
  close.tabIndex = 0
  close.setAttribute("aria-label", "关闭终端")
  close.title = "关闭"
  close.addEventListener("click", (e) => {
    e.stopPropagation()
    closeTab(sid)
  })
  close.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); closeTab(sid) }
  })
  el.addEventListener("click", () => setActive(sid))
  el.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === el) { e.preventDefault(); setActive(sid) }
  })
  el.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
      e.preventDefault()
      closeTab(sid)
    }
  })
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault()
    openTabMenu(e.clientX, e.clientY, sid)
  })
  el.append(title, close)
  t.tabEl = el
  t.titleEl = title
  return el
}

function renderTabs() {
  let activeEl = null
  const liveElements = new Set()
  for (const [sid, t] of tabs) {
    const el = ensureTabElement(sid, t)
    liveElements.add(el)
    const isActive = sid === activeSid
    el.classList.toggle("active", isActive)
    el.setAttribute("aria-selected", isActive ? "true" : "false")
    el.title = `${t.title}（点击切换；中键关闭；右键重命名；双击标题重命名）`
    t.titleEl.textContent = t.title
    if (el.parentElement !== tabsEl) tabsEl.appendChild(el)
    if (sid === activeSid) activeEl = el
  }
  for (const child of [...tabsEl.children]) {
    if (!liveElements.has(child)) child.remove()
  }

  // Preserve node identity so an OSC title update cannot replace a tab between
  // pointerdown and click. Scroll only after layout/paint work has left the
  // click handler, avoiding a forced synchronous layout on every switch.
  if (tabScrollFrame) cancelAnimationFrame(tabScrollFrame)
  tabScrollFrame = requestAnimationFrame(() => {
    tabScrollFrame = 0
    if (activeEl?.isConnected && activeEl.classList.contains("active")) {
      activeEl.scrollIntoView({ block: "nearest", inline: "nearest" })
    }
  })
}

function restoreSessions(sessions) {
  clearTimeout(sessionsFallbackTimer)
  sessionsFallbackTimer = null
  sessionsResolved = true
  const live = Array.isArray(sessions) ? sessions.filter((s) => s && s.sid) : []
  for (const session of live) {
    if (!tabs.has(String(session.sid))) createTab(session)
  }
  if (tabs.size === 0) newTab()
  else setStatus("ok", live.length > 1 ? `已恢复 ${live.length} 个终端会话` : "已连接")
}

// ---------- native 桥 ----------
// SW 重启/端口意外断开时自动重连（指数退避，封顶 8s），重连会重新 list_sessions + 上报本窗口，恢复绑定。
let panelReconnectTimer = null
let panelReconnectDelay = 500
let expectPanelDisconnect = false // connectPanel 主动 disconnect 时置 true，避免触发重连
function schedulePanelReconnect() {
  if (panelReconnectTimer) return
  panelReconnectTimer = setTimeout(() => {
    panelReconnectTimer = null
    connectPanel()
  }, panelReconnectDelay)
  panelReconnectDelay = Math.min(Math.round(panelReconnectDelay * 1.7), 8000)
}
function connectPanel() {
  // 不在此重置 panelReconnectDelay：重置要等「真连上」（收到 sessions_list）才做，否则反复失败时
  // 退避会被每次尝试重置成 500，永远累加不到 8s（P7）。
  if (panelPort) {
    expectPanelDisconnect = true
    try {
      panelPort.disconnect()
    } catch {
      /* ignore */
    }
  }
  panelPort = chrome.runtime.connect({ name: "panel" })
  panelPort.onMessage.addListener((msg) => {
    if (msg?.type === "sessions_list") {
      panelReconnectDelay = 500 // 真连上了（native 经 background 回了会话清单）：重置退避基数
      restoreSessions(msg.sessions)
    } else if (msg?.type === "confirmation_request") {
      const detail = String(msg.detail || "")
      const approved = window.confirm(`${msg.message || "请确认操作"}${detail ? `\n\n${detail}` : ""}`)
      send({ type: "confirmation_response", id: msg.id, approved })
    } else if (msg?.type === "session_reset") {
      // Host 只在真正创建新 shell 时发送；普通面板重连现有 PTY 不会清屏。
      tabs.get(msg.sid || "default")?.term?.reset?.()
    } else if (msg?.type === "output") {
      // 按 sid 路由到对应 tab 的终端（host 给每条 output 都打了 sid）
      tabs.get(msg.sid || "default")?.term?.write(msg.data)
    } else if (msg?.type === "status") {
      const sid = msg.sid
      if (msg.state === "ready") {
        setStatus("ok", "已连接")
        // host 起好该 tab 的 PTY 后，补发真实终端尺寸（hello 带的是默认 80x24）
        const xt = tabs.get(sid)?.term?.term
        if (xt && xt.cols) send({ type: "resize", sid, cols: xt.cols, rows: xt.rows })
        if (sid === activeSid) tabs.get(sid)?.term?.focus()
      } else if (msg.state === "disconnected") {
        setStatus("err", msg.msg ? `已断开：${msg.msg}` : "已断开，重连中…")
        // background 会在 1.5s 后重建 Native Host；随后用现有 tab 元数据重建 PTY。
        setTimeout(() => {
          for (const [existingSid, existing] of tabs) {
            send({
              type: "hello",
              sid: existingSid,
              shell: existing.shell || resolvedShell(),
              title: existing.title,
              renamed: existing.renamed,
              punctCompat: existing.punctCompat,
              cols: curSettings.cols,
              rows: curSettings.rows,
            })
          }
        }, 1800)
      } else if (msg.state === "pty_exit") {
        if (sid && closingSids.has(sid)) {
          closingSids.delete(sid) // 主动关闭的 tab：不弹提示
        } else {
          setStatus("err", `tab ${sid} 的 shell 已退出`)
          showExitedOverlay(sid) // 覆盖死终端，避免继续敲键到尸体
        }
      } else if (msg.state === "mcp_error") {
        setStatus("err", msg.msg || "MCP 错误")
      }
    } else if (msg?.type === "pick_progress") {
      setStatus("ok", `已选 ${msg.count || 0} 个；继续点选，Enter 或点「完成选取」`)
      const pb = $("pickBtn")
      pb.textContent = "完成选取"
      pb.classList.add("danger")
    } else if (msg?.type === "pick_result") {
      const picks = Array.isArray(msg.picks) ? msg.picks : msg.pick ? [msg.pick] : []
      if (picks.length) {
        injectPickedContext(picks)
        flashStatus(`已选取 ${picks.length} 个元素，并写入当前终端输入框`)
      } else {
        flashStatus(msg.cancelled ? "选取已取消" : "没有选取元素")
      }
      const pb = $("pickBtn")
      pb.textContent = "选取"
      pb.classList.remove("danger") // 选取结束（选中/Esc取消/点取消）都恢复非红态
    } else if (msg?.type === "tool_activity") {
      if (msg.phase === "start") {
        activeCount++
        if (activeCount === 1) scheduleActivity(`正在执行 ${String(msg.name || "").replace(/^omeety_/, "")}…`)
      } else {
        activeCount = Math.max(0, activeCount - 1)
        if (activeCount === 0) clearActivity()
      }
    } else if (msg?.type === "tools_list") {
      renderToolsList(msg.tools || [])
    } else if (msg?.type === "active_tab_changed") {
      // 选取是 per-tab 的：切标签页后当前页可能未在选取，重置按钮 + 提示。
      const pick = $("pickBtn")
      if (pick?.classList.contains("danger")) {
        pick.classList.remove("danger")
        pick.textContent = "选取"
        const t = msg.title ? `「${String(msg.title).slice(0, 20)}」` : "新标签页"
        flashStatus(`已切换到${t}；选取按页面独立，本页需要时点「选取」`)
      }
    } else if (msg?.type === "window_pin") {
      renderWindowPin(msg)
    }
  })
  panelPort.onDisconnect.addListener(() => {
    if (expectPanelDisconnect) { expectPanelDisconnect = false; return } // connectPanel 主动断的，不重连
    setStatus("err", "与后台连接断开，重连中…")
    schedulePanelReconnect()
  })

  // Host 是仍存活 PTY 的事实来源：先恢复全部会话；连接异常时 2.5s 后至少给用户一个新终端。
  send({ type: "list_sessions" })
  // 上报本侧栏所在窗口 → background 自动绑定（所有自动化操作只作用此窗口，不污染工作窗口）
  ;(async () => {
    try {
      const win = await chrome.windows.getCurrent() // 侧栏 window-scoped：返回本窗口 id
      if (win?.id != null) send({ type: "panel_window", windowId: win.id })
    } catch { /* ignore */ }
  })()
  clearTimeout(sessionsFallbackTimer)
  sessionsFallbackTimer = setTimeout(() => {
    if (!sessionsResolved && tabs.size === 0) {
      sessionsResolved = true
      newTab()
      setStatus("err", "会话清单响应超时，已创建新终端")
    }
  }, 2500)
}

// ---------- 浏览器窗口绑定按钮（顶栏 status-row 右侧：自动/锁定/解除 三态）----------
function renderWindowPin({ state, windowId, title }) {
  const btn = $("winPin")
  if (!btn) return
  btn.classList.toggle("locked", state === "locked")
  const t = String(title || "").trim()
  const label = t ? (t.length > 8 ? t.slice(0, 8) + "…" : t) : (windowId != null ? `窗口${windowId}` : "")
  if (state === "locked" || state === "auto") {
    btn.textContent = `🔒 ${label || "本窗口"}`
    btn.title = state === "locked"
      ? `已锁定「${label || "本窗口"}」，点此解除（改回跟随焦点）`
      : `自动绑定「${label || "本窗口"}」，点此锁定（不再随侧栏切换）`
  } else { // unpinned / 初始未上报
    btn.textContent = "🔓 跟焦点"
    btn.title = "已解除（跟随焦点），点此恢复自动绑定本窗口"
  }
  btn.dataset.state = state || "unpinned"
}
function cycleWindowPin() {
  const btn = $("winPin")
  const s = btn?.dataset.state
  // auto → locked → unpinned → auto
  if (s === "auto") send({ type: "pin_window" })
  else if (s === "locked") send({ type: "unpin_window" })
  else send({ type: "auto_window" }) // unpinned / 初始 → 恢复自动
}

function restartTerminals(shell) {
  setStatus("", "正在重连…")
  for (const [sid, tab] of tabs) {
    tab.shell = shell
    send({ type: "restart", sid, shell, cols: curSettings.cols, rows: curSettings.rows })
  }
}

// ---------- ack 门 ----------
function applyAckGate() {
  ackGate.hidden = !!curSettings.acknowledged
}

// ---------- 启动 ----------
;(async () => {
  curSettings = await loadSettings()
  const isMac = /Mac/.test(navigator.platform)
  const knownShells = new Set(["auto", "zsh", "bash", "fish", "powershell", "cmd", "pwsh", "gitbash"])
  shellSelect.value = knownShells.has(curSettings.shell) ? curSettings.shell : "custom"
  scrollbackSelect.value = [3000, 5000, 10000, 20000].includes(Number(curSettings.scrollback)) ? String(curSettings.scrollback) : "5000"
  keepAliveSelect.value = ["always", "30m", "close"].includes(curSettings.keepAliveMode) ? curSettings.keepAliveMode : "always"
  browserPermissionSelect.value = ["read", "act", "submit"].includes(curSettings.browserPermissionMode) ? curSettings.browserPermissionMode : "submit"
  document.querySelectorAll("#shellSelect option[data-platform]").forEach((option) => {
    option.hidden = isMac ? option.dataset.platform === "windows" : option.dataset.platform === "unix"
  })
  shellCustom.placeholder = isMac ? "如 /bin/zsh" : "如 C:\\Program Files\\PowerShell\\7\\pwsh.exe"
  if (shellSelect.value === "custom") {
    shellCustom.hidden = false
    shellCustom.value = curSettings.shell === "custom" ? "" : curSettings.shell
  }
  applyAckGate()

  // 容器尺寸变化 → 防抖 fit 活动 tab（拖尾 100ms 合并连续事件，打断 fit↔ResizeObserver 抖动循环）
  let resizeTimer = null
  new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => tabs.get(activeSid)?.term?.resize(), 160)
  }).observe(terminalHost)

  connectPanel()
})()

// ---------- 事件 ----------
$("ackBtn").addEventListener("click", async () => {
  curSettings = await saveSettings({ acknowledged: true })
  applyAckGate()
  tabs.get(activeSid)?.term?.focus()
})

$("winPin")?.addEventListener("click", cycleWindowPin)
$("pickBtn").addEventListener("click", () => {
  send({ type: "start_pick" }) // content 端 toggle：未选取→进入；选取中→完成
  const btn = $("pickBtn")
  const entering = !btn.classList.contains("danger") // danger = 选取中
  btn.textContent = entering ? "完成选取" : "选取"
  btn.classList.toggle("danger", entering)
  if (entering) flashStatus("连续选取：到网页点多个元素；Enter/本按钮完成，Esc 取消")
  else flashStatus("正在完成选取…")
})

$("tabNew").addEventListener("click", () => newTab())
// 终端 tab 快捷键（Ctrl+Alt 系：Ctrl+T/W/Tab 被浏览器占用到不了页面；Alt+字母和 readline 的
// Alt+b/Alt+f、Alt+数字参数冲突，所以选 Ctrl+Alt）。
//   Ctrl+Alt+T 新终端 · Ctrl+Alt+W 关闭当前 · Ctrl+Alt+←/→ 左右切换
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey && e.altKey) || e.shiftKey) return
  if (e.code === "KeyT") {
    e.preventDefault()
    newTab()
  } else if (e.code === "KeyW") {
    e.preventDefault()
    if (activeSid) closeTab(activeSid)
  } else if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
    e.preventDefault()
    const sids = [...tabs.keys()]
    if (sids.length < 2) return
    const i = sids.indexOf(activeSid)
    const next = e.code === "ArrowRight" ? (i + 1) % sids.length : (i - 1 + sids.length) % sids.length
    setActive(sids[next])
  }
})

$("settingsToggle").addEventListener("click", () => {
  const willEnterSettings = !settingsView.classList.contains("active")
  setSettingsOpen(willEnterSettings)
})
$("backBtn").addEventListener("click", () => {
  setSettingsOpen(false)
})

shellSelect.addEventListener("change", () => {
  shellCustom.hidden = shellSelect.value !== "custom"
})

$("saveBtn").addEventListener("click", async () => {
  const shell = resolvedShell() || "auto"
  const scrollback = Number(scrollbackSelect.value) || 5000
  const keepAliveMode = keepAliveSelect.value
  const browserPermissionMode = browserPermissionSelect.value
  const previousShell = curSettings.shell
  const button = $("saveBtn")
  button.disabled = true
  try {
    curSettings = await saveSettings({ shell, scrollback, keepAliveMode, browserPermissionMode })
    for (const [, tab] of tabs) tab.term?.setScrollback?.(scrollback)
    send({ type: "settings_changed" })
    setSettingsOpen(false)
    if (previousShell !== shell) restartTerminals(shell)
    else flashStatus("设置已保存")
  } catch (error) {
    setStatus("err", `保存失败：${error?.message || error}`)
  } finally {
    button.disabled = false
  }
})

// 工具按类别分组渲染（结构化，便于查看）。name 不在下列表里的归"其他"。
const TOOL_CATEGORIES = [
  { title: "Browser Core v2", names: ["omeety_browser_observe", "omeety_browser_query", "omeety_browser_act", "omeety_browser_transaction", "omeety_browser_wait", "omeety_browser_tabs", "omeety_browser_status"] },
  { title: "页面理解 / Context Bundle", names: ["omeety_get_context_bundle", "omeety_get_page_snapshot", "omeety_get_selected_context", "omeety_capture_visible_tab", "omeety_get_user_picks", "omeety_fetch_with_cookie", "omeety_get_console_logs"] },
  { title: "动作事务 / 元素操作", names: ["omeety_act_and_verify", "omeety_click", "omeety_click_text", "omeety_click_at", "omeety_fill", "omeety_type_text", "omeety_press_key", "omeety_select", "omeety_hover", "omeety_scroll"] },
  { title: "等待", names: ["omeety_wait_for"] },
  { title: "性能 / 诊断", names: ["omeety_get_runtime_metrics"] },
  { title: "预览修改（可回滚）", names: ["omeety_apply_preview_patch", "omeety_rollback_preview_patch"] },
  { title: "标签页 / 导航", names: ["omeety_list_tabs", "omeety_close_tab", "omeety_open_tab", "omeety_switch_tab", "omeety_navigate", "omeety_reload", "omeety_go_back"] },
  { title: "高级（任意 JS / 文件上传）", names: ["omeety_execute_js", "omeety_upload_file"] },
  { title: "本地下载", names: ["omeety_download_start", "omeety_download_status", "omeety_download_cancel"] },
  { title: "交互", names: ["omeety_request_user_confirmation"] },
]
function renderToolItem(t, idx) {
  const item = document.createElement("div")
  item.className = "tool-item"
  const name = document.createElement("code")
  name.textContent = (idx ? idx + ". " : "") + t.name
  const desc = document.createElement("div")
  desc.className = "muted small"
  desc.textContent = t.description || ""
  item.append(name, desc)
  return item
}
// 设置里的"已注册工具"子菜单：展开时向 host 要一次工具清单（name + description）。
// 工具定义在 host/src/tools.meta.js（单一来源），面板不硬编码，避免和真实注册的工具脱节。
function renderToolsList(tools) {
  const el = $("toolsList")
  if (!el) return
  el.dataset.loaded = "1"
  el.textContent = ""
  const byName = new Map(tools.map((t) => [t.name, t]))
  const sum = document.querySelector("#toolsDetails > summary")
  if (sum) sum.textContent = `已注册工具（${tools.length} 个）`
  const used = new Set()
  for (const cat of TOOL_CATEGORIES) {
    const items = cat.names.map((n) => byName.get(n)).filter(Boolean)
    if (!items.length) continue
    items.forEach((t) => used.add(t.name))
    const h = document.createElement("div")
    h.className = "tool-cat"
    h.textContent = cat.title
    el.appendChild(h)
    items.forEach((t, i) => el.appendChild(renderToolItem(t, i + 1)))
  }
  const rest = tools.filter((t) => !used.has(t.name))
  if (rest.length) {
    const h = document.createElement("div")
    h.className = "tool-cat"
    h.textContent = "其他"
    el.appendChild(h)
    rest.forEach((t, i) => el.appendChild(renderToolItem(t, i + 1)))
  }
}
const toolsDetails = $("toolsDetails")
if (toolsDetails) {
  toolsDetails.addEventListener("toggle", () => {
    if (toolsDetails.open && !$("toolsList")?.dataset.loaded) {
      if ($("toolsList")) $("toolsList").textContent = "加载中…"
      send({ type: "list_tools" })
    }
  })
}
