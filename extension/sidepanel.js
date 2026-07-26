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

let panelPort = null
let curSettings = null
const tabs = new Map() // sid -> { term, hostEl, title }
let activeSid = null
let tabSeq = 0
const closingSids = new Set() // 主动关闭的 tab（点 ×）：忽略 host 回的 pty_exit 提示
let sessionsResolved = false
let sessionsFallbackTimer = null
const sessionMetaTimers = new Map()

function setStatus(state, text) {
  statusDot.className = "dot " + (state || "")
  statusText.textContent = text
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
  activeSid = sid
  for (const [s, t] of tabs) {
    const active = s === sid
    t.hostEl.classList.toggle("active", active)
    t.term?.setActive?.(active)
  }
  const t = tabs.get(sid)
  requestAnimationFrame(() => {
    t.term?.resize()
    t.term?.focus()
  })
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
  tabs.delete(sid)
  if (tabs.size === 0) {
    newTab() // 至少留一个 tab
  } else if (activeSid === sid) {
    setActive([...tabs.keys()][tabs.size - 1])
  }
  renderTabs()
  setStatus("ok", "已连接") // 关闭后状态回到正常，不留"已退出"提示
}

// tab 右键菜单：重命名 + codex 标点兼容开关（per-tab）
let ctxMenuEl = null
function closeTabMenu() {
  if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null }
}
function openTabMenu(x, y, sid) {
  closeTabMenu()
  const t = tabs.get(sid)
  if (!t) return
  const m = document.createElement("div")
  m.className = "tab-ctx"
  const rn = document.createElement("button")
  rn.textContent = "重命名…"
  rn.onclick = () => {
    closeTabMenu()
    const name = window.prompt("重命名终端：", t.title)
    if (name && name.trim()) {
      t.title = name.trim().slice(0, 30)
      t.renamed = true
      renderTabs()
      persistTabMeta(sid)
    }
  }
  const pc = document.createElement("button")
  pc.className = "ctx-toggle" + (t.punctCompat ? " on" : "")
  pc.textContent = (t.punctCompat ? "✓ " : "") + "codex 标点兼容"
  pc.title = "把弯引号“”、破折号、省略号等（codex 经 ConPTY 收不到的）转成直引号等价物，让 codex 能用。claude/kimi 不需要。"
  pc.onclick = () => {
    t.punctCompat = !t.punctCompat
    t.term?.setPunctCompat?.(t.punctCompat)
    persistTabMeta(sid)
    setStatus("ok", t.punctCompat ? `「${t.title}」已开启 codex 标点兼容` : `「${t.title}」已关闭标点兼容`)
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

function renderTabs() {
  tabsEl.innerHTML = ""
  let activeEl = null
  for (const [sid, t] of tabs) {
    const el = document.createElement("div")
    el.className = "tab" + (sid === activeSid ? " active" : "")
    el.title = `${t.title}（点击切换；中键关闭；右键重命名）`
    const title = document.createElement("span")
    title.className = "tab-title"
    title.textContent = t.title
    const close = document.createElement("span")
    close.className = "tab-close"
    close.textContent = "×"
    close.title = "关闭"
    close.addEventListener("click", (e) => {
      e.stopPropagation()
      closeTab(sid)
    })
    // 整个 tab 可点（原来只有标题文字那一小条能点）
    el.addEventListener("click", () => setActive(sid))
    // 中键关闭（浏览器/Windows Terminal 通用习惯）
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault()
        closeTab(sid)
      }
    })
    // 右键：菜单（重命名 / codex 标点兼容开关）
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      openTabMenu(e.clientX, e.clientY, sid)
    })
    el.append(title, close)
    tabsEl.appendChild(el)
    if (sid === activeSid) activeEl = el
  }
  // 新选中/添加的 tab 自动滚动到可见（tab 栏 overflow-x 时新 tab 可能在右端被挡住）
  if (activeEl) activeEl.scrollIntoView({ block: "nearest", inline: "nearest" })
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
function connectPanel() {
  if (panelPort) {
    try {
      panelPort.disconnect()
    } catch {
      /* ignore */
    }
  }
  panelPort = chrome.runtime.connect({ name: "panel" })
  panelPort.onMessage.addListener((msg) => {
    if (msg?.type === "sessions_list") {
      restoreSessions(msg.sessions)
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
        }
      } else if (msg.state === "mcp_error") {
        setStatus("err", msg.msg || "MCP 错误")
      }
    } else if (msg?.type === "pick_result") {
      const p = msg.pick
      setStatus("ok", p ? `已选取：${(p.text || p.tag || "").slice(0, 10)}` : "选取已取消")
      const pb = $("pickBtn")
      pb.textContent = "选取"
      pb.classList.remove("danger") // 选取结束（选中/Esc取消/点取消）都恢复非红态
    } else if (msg?.type === "tools_list") {
      renderToolsList(msg.tools || [])
    } else if (msg?.type === "active_tab_changed") {
      // 选取是 per-tab 的：切标签页后当前页可能未在选取，重置按钮 + 提示。
      const pick = $("pickBtn")
      if (pick?.classList.contains("danger")) {
        pick.classList.remove("danger")
        pick.textContent = "选取"
        const t = msg.title ? `「${String(msg.title).slice(0, 20)}」` : "新标签页"
        setStatus("ok", `已切换到${t}；选取按页面独立，本页需要时点「选取」`)
      }
    }
  })
  panelPort.onDisconnect.addListener(() => setStatus("err", "与后台连接断开"))

  // Host 是仍存活 PTY 的事实来源：先恢复全部会话；连接异常时 2.5s 后至少给用户一个新终端。
  send({ type: "list_sessions" })
  clearTimeout(sessionsFallbackTimer)
  sessionsFallbackTimer = setTimeout(() => {
    if (!sessionsResolved && tabs.size === 0) {
      sessionsResolved = true
      newTab()
      setStatus("err", "会话清单响应超时，已创建新终端")
    }
  }, 2500)
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
    resizeTimer = setTimeout(() => tabs.get(activeSid)?.term?.resize(), 100)
  }).observe(terminalHost)

  connectPanel()
})()

// ---------- 事件 ----------
$("ackBtn").addEventListener("click", async () => {
  curSettings = await saveSettings({ acknowledged: true })
  applyAckGate()
  tabs.get(activeSid)?.term?.focus()
})

$("pickBtn").addEventListener("click", () => {
  send({ type: "start_pick" }) // content 端 toggle：未选取→进入选取；选取中→取消
  const btn = $("pickBtn")
  const entering = !btn.classList.contains("danger") // danger = 选取中
  btn.textContent = entering ? "取消选取" : "选取"
  btn.classList.toggle("danger", entering)
  if (entering) setStatus("ok", "选取模式：切到网页点一下目标元素（再点本按钮/Esc 取消）")
  else setStatus("ok", "取消选取中…")
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
  const previousShell = curSettings.shell
  const button = $("saveBtn")
  button.disabled = true
  try {
    curSettings = await saveSettings({ shell, scrollback, keepAliveMode })
    for (const [, tab] of tabs) tab.term?.setScrollback?.(scrollback)
    send({ type: "settings_changed" })
    setSettingsOpen(false)
    if (previousShell !== shell) restartTerminals(shell)
    else setStatus("ok", "设置已保存")
  } catch (error) {
    setStatus("err", `保存失败：${error?.message || error}`)
  } finally {
    button.disabled = false
  }
})

// 工具按类别分组渲染（结构化，便于查看）。name 不在下列表里的归"其他"。
const TOOL_CATEGORIES = [
  { title: "页面理解 / Context Bundle", names: ["omeety_get_context_bundle", "omeety_get_page_snapshot", "omeety_get_selected_context", "omeety_capture_visible_tab", "omeety_get_user_pick", "omeety_fetch_with_cookie", "omeety_get_console_logs"] },
  { title: "动作事务 / 元素操作", names: ["omeety_act_and_verify", "omeety_click", "omeety_click_text", "omeety_click_at", "omeety_fill", "omeety_type_text", "omeety_press_key", "omeety_select", "omeety_hover", "omeety_scroll"] },
  { title: "等待", names: ["omeety_wait_for"] },
  { title: "性能 / 诊断", names: ["omeety_get_runtime_metrics"] },
  { title: "预览修改（可回滚）", names: ["omeety_apply_preview_patch", "omeety_rollback_preview_patch"] },
  { title: "标签页 / 导航", names: ["omeety_list_tabs", "omeety_close_tab", "omeety_open_tab", "omeety_switch_tab", "omeety_navigate", "omeety_reload", "omeety_go_back"] },
  { title: "高级（任意 JS / 文件上传）", names: ["omeety_execute_js", "omeety_upload_file"] },
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
  if (sum) sum.textContent = `已注册的浏览器工具（${tools.length} 个）`
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
