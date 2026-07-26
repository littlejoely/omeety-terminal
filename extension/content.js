const PATCH_ATTR = "data-omeety-patch"
// 与 background.js 的 CDP 危险词表保持同一份超集：合成点击和 CDP 真实点击的确认门槛一致。
const DANGEROUS_RE = /(提交|保存|删除|作废|下架|审核|确认|同意|拒绝|取消|支付|购买|卸载|发送|退出|approve|submit|delete|remove|confirm|accept|reject|cancel|pay|purchase|install|uninstall|send|exit|logout)/i

// 扩展重载后，旧 content 注入的选取 DOM（#omeety-pick-highlight/banner）会残留在页面上
// （旧 content 的监听器已失效但 DOM 没清）→ 新 content 加载时清掉，避免"没点选取却显示选取态"。
;(function cleanupStalePickDom() {
  document.getElementById("omeety-pick-highlight")?.remove()
  document.getElementById("omeety-pick-banner")?.remove()
})()

// browserSessionId 仅作 snapshot 字段兼容保留，自包含模式下不再使用。
const patchStore = new Map()
let browserSessionId = null

// 自包含模式只处理工具执行请求；不再有 Codeg bootstrap / xyy_* 混淆 shim / 注册逻辑。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "omeety_execute_tool") {
    void executeTool(message.tool, message.arguments || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }))
    return true
  }
  if (message?.type === "omeety_start_pick") {
    // 再点一次 = 取消（toggle）
    if (pickActive) {
      endPickMode()
      chrome.runtime.sendMessage({ type: "omeety_pick_done", pick: null })
    } else {
      startPickMode()
    }
    return false
  }
  return false
})

// ---- 元素选取模式（侧栏 📌 选取 → 鼠标悬停高亮 → 点击捕获 → 回传给 AI）----
let pickActive = false
let pickHighlight = null
let pickBanner = null

function startPickMode() {
  if (pickActive) return
  document.getElementById("omeety-pick-highlight")?.remove() // 清可能的残留（重载/异常）
  document.getElementById("omeety-pick-banner")?.remove()
  pickActive = true
  pickHighlight = document.createElement("div")
  pickHighlight.id = "omeety-pick-highlight"
  pickHighlight.style.display = "none"
  pickBanner = document.createElement("div")
  pickBanner.id = "omeety-pick-banner"
  pickBanner.textContent = "点目标元素选取 · 点本提示或 Esc 取消"
  document.body.appendChild(pickHighlight)
  document.body.appendChild(pickBanner)
  document.addEventListener("mousemove", onPickMove, true)
  document.addEventListener("click", onPickClick, true)
  document.addEventListener("keydown", onPickKey, true)
}

function endPickMode() {
  if (!pickActive) return
  pickActive = false
  document.removeEventListener("mousemove", onPickMove, true)
  document.removeEventListener("click", onPickClick, true)
  document.removeEventListener("keydown", onPickKey, true)
  pickHighlight?.remove()
  pickBanner?.remove()
  pickHighlight = pickBanner = null
}

function onPickMove(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (!el || el === pickHighlight || el === pickBanner || !el.getBoundingClientRect) return
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return
  pickHighlight.style.display = "block"
  pickHighlight.style.left = r.x + "px"
  pickHighlight.style.top = r.y + "px"
  pickHighlight.style.width = r.width + "px"
  pickHighlight.style.height = r.height + "px"
}

function onPickClick(e) {
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
  const el = document.elementFromPoint(e.clientX, e.clientY)
  endPickMode()
  if (!el || el === document.body || el === document.documentElement || el === pickBanner || el === pickHighlight) {
    // 点了 banner / 高亮 / 空白 = 取消
    chrome.runtime.sendMessage({ type: "omeety_pick_done", pick: null })
    return
  }
  // 打上稳定 pick 标记，让 omeety_click(uid:"pick") 能精确再找到它（snapshot 不会清这个标记）
  document.querySelectorAll('[data-omeety-pick="1"]').forEach((n) => n.removeAttribute("data-omeety-pick"))
  el.setAttribute("data-omeety-pick", "1")
  const r = el.getBoundingClientRect()
  const pick = {
    uid: "pick",
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || null,
    text: compactText(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || ""),
    selector: cssPath(el),
    bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    url: location.href,
    capturedAt: new Date().toISOString(),
  }
  chrome.runtime.sendMessage({ type: "omeety_pick_done", pick })
}

function onPickKey(e) {
  if (e.key === "Escape") {
    e.preventDefault()
    e.stopPropagation()
    endPickMode()
    chrome.runtime.sendMessage({ type: "omeety_pick_done", pick: null })
  }
}

async function executeTool(tool, args) {
  switch (tool) {
    case "omeety_get_page_snapshot":
      return getPageSnapshot(args)
    case "omeety_get_selected_context":
      return getSelectedContext()
    case "omeety_fetch_with_cookie":
      return fetchWithCookie(args)
    case "omeety_apply_preview_patch":
      return applyPreviewPatch(args)
    case "omeety_rollback_preview_patch":
      return rollbackPreviewPatch(args.patchId)
    case "omeety_click":
      return clickElement(args)
    case "omeety_click_text":
      return clickByText(args)
    case "omeety_click_at":
      return clickAt(args)
    case "omeety_fill":
      return fillElement(args)
    case "omeety_type_text":
      return typeText(args)
    case "omeety_press_key":
      return pressKey(args)
    case "omeety_select":
      return selectElement(args)
    case "omeety_scroll":
      return scrollPage(args)
    case "omeety_wait_for":
      return waitFor(args)
    case "omeety_hover":
      return hoverElement(args)
    case "omeety_request_user_confirmation":
      return requestUserConfirmation(args)
    default:
      throw new Error(`Unknown Omeety browser tool: ${tool}`)
  }
}

async function getPageSnapshot(args = {}) {
  const mode = args.mode === "detailed" ? "detailed" : "light"
  const includeElements = args.includeElements === undefined ? mode === "detailed" : Boolean(args.includeElements)
  const defaultTextLength = includeElements ? 12000 : 4000
  const maxTextLength = clamp(Number(args.maxTextLength ?? defaultTextLength), 0, 60000)
  const snapshot = {
    browserSessionId,
    url: location.href,
    origin: location.origin,
    title: document.title,
    auth: null,
    mode,
    selection: String(getSelection()?.toString() || "").trim().slice(0, 4000),
    visibleText: collectVisibleText(maxTextLength),
    overview: getPageOverview(),
    // 坐标空间元数据：snapshot.interactive[].bbox 与 omeety_click_at 都是 CSS 像素，
    // 但 omeety_capture_visible_tab 返回物理像素（= CSS × devicePixelRatio）。agent 从截图读坐标
    // 点击时必须除以 devicePixelRatio 换算，否则 dpr≠1（如 1.5）时必偏移。
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
    },
    capturedAt: new Date().toISOString(),
  }
  if (includeElements) {
    snapshot.forms = [...document.forms].slice(0, 20).map(describeForm)
    snapshot.buttons = [...document.querySelectorAll("button,input[type=button],input[type=submit],a")]
      .filter(isVisible)
      .slice(0, 100)
      .map(describeClickable)
    snapshot.inputs = [...document.querySelectorAll("input,textarea,select,[contenteditable=true]")]
      .filter(isVisible)
      .slice(0, 120)
      .map(describeInput)
    snapshot.links = [...document.querySelectorAll("a[href]")]
      .filter(isVisible)
      .slice(0, 80)
      .map(describeClickable)
    snapshot.tables = [...document.querySelectorAll("table")]
      .filter(isVisible)
      .slice(0, 20)
      .map(describeTable)
  }
  // 可交互元素 + 稳定 uid（每次快照重新打标）。agent 拿 uid 去调 click/fill/type，比猜动态 selector 稳。
  // 默认 120 与 tools.meta.js 的 maxInteractive default 对齐（之前这里写 60 导致大列表被砍）。
  snapshot.interactive = listInteractive(Number(args.maxInteractive) || 120)
  return snapshot
}

// 收集可交互元素，给每个打 data-omeety-uid，返回 uid/role/text/bbox/selector。
// bbox 也能配合截图走"视觉定位坐标点击"；uid 则是精确的 DOM 句柄。
// 深度查询：穿透 shadow DOM。复杂 SPA（飞书/企业应用）把导航、会话列表、搜索框大量藏在 shadow root 里，
// 普通 querySelectorAll 查不到 → snapshot 漏采 → agent 找不到元素。这里递归进每个 shadowRoot，带深度/数量上限防失控。
function queryAllDeep(selector, root = document, acc = [], depth = 0) {
  if (depth > 15 || acc.length > 5000) return acc
  try {
    for (const el of root.querySelectorAll(selector)) acc.push(el)
  } catch {
    /* ignore */
  }
  try {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) queryAllDeep(selector, el.shadowRoot, acc, depth + 1)
    }
  } catch {
    /* ignore */
  }
  return acc
}

// uid 在"同一元素对象存活期间"稳定：WeakMap 以元素为键，只要元素没被 SPA 重渲染替换，多次快照拿到同一个 uid。
// 注意：页面重渲染（React/Vue diff 卸载旧节点、导航换页）会换成新元素对象 → 旧 uid 失效，findByUid 会明确报错
// （而不是像旧方案那样编号撞上、点到别的元素）。agent 收到失效错误后重新 get_page_snapshot 即可。
const uidMap = new WeakMap() // element -> uid
let uidCounter = 0
function uidFor(el) {
  let u = uidMap.get(el)
  if (!u) {
    u = "u" + ++uidCounter
    uidMap.set(el, u)
  }
  el.setAttribute("data-omeety-uid", u)
  return u
}

function listInteractive(max = 120) {
  // 选择器：交互控件 + 列表/菜单/表格行项。之前缺 listitem/row/cell/li/tr 等，导致飞书会话列表、
  // 下拉菜单整列被折叠成父容器的单个 region，item 级拿不到 uid，agent 只能 execute_js 算坐标点。
  // 注：纯 div 的 SPA 列表项（如飞书会话项，无 role/onclick）仍选不中——那种用 omeety_click_text 按文本点。
  const SEL =
    'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"], [role="textbox"], [role="listitem"], [role="row"], [role="cell"], [role="gridcell"], [role="treeitem"], [contenteditable], [tabindex]:not([tabindex="-1"]), [onclick], li, tr, [class*="search" i]'
  const seen = new Set()
  const els = queryAllDeep(SEL).filter((el) => {
    if (seen.has(el)) return false
    seen.add(el)
    return isVisible(el)
  })
  // 分级采集：按钮/链接/输入/菜单项（高价值）优先占名额，列表/行项（低价值）填充剩余——
  // 避免几百行的表格把 max 占满、把真正的操作按钮挤掉。
  const HIGH_TAG = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"])
  const HIGH_ROLE = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "checkbox", "radio", "combobox", "searchbox", "textbox"])
  const isHigh = (el) => HIGH_TAG.has(el.tagName) || HIGH_ROLE.has(el.getAttribute("role") || "")
  const highs = els.filter(isHigh)
  const lows = els.filter((el) => !isHigh(el))
  const picked = highs.slice(0, max).concat(lows.slice(0, Math.max(0, max - highs.length)))
  return picked.map((el) => {
    const uid = uidFor(el)
    const r = el.getBoundingClientRect()
    return {
      uid,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      text: labelOf(el),
      selector: cssPath(el),
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    }
  })
}

// 提取元素的可读 label。icon-only 按钮（飞书工具栏图标按钮常无文字、无 aria-label）之前 text 全是 null，
// agent 只能逐个 hover 探查用途（一次发图任务为此花了 12 次工具调用）。这里多挖几层：aria-label/title/placeholder
// → 内部 img[alt] → data-tip/data-tooltip，尽量给 icon 按钮一个可读名字。
function labelOf(el) {
  const direct = el.innerText || el.value || ""
  if (direct && direct.trim()) return compactText(direct)
  const aria = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || ""
  if (aria.trim()) return compactText(aria)
  const imgAlt = el.querySelector("img[alt]")?.getAttribute("alt") || ""
  if (imgAlt.trim()) return compactText(imgAlt)
  const tip = el.getAttribute("data-tip") || el.getAttribute("data-tooltip") || el.getAttribute("aria-title") || ""
  if (tip.trim()) return compactText(tip)
  return null
}

function findByUid(uid) {
  const u = String(uid)
  const hits = queryAllDeep(`[data-omeety-uid="${CSS.escape(u)}"]`)
  let el = hits[0] || null
  if (!el && u === "pick") el = queryAllDeep('[data-omeety-pick="1"]')[0] || null
  if (!el) {
    throw new Error(`uid "${uid}" 不存在或已失效（页面可能重渲染过；重新 get_page_snapshot 或重新点 📌 选取）`)
  }
  return el
}

function getSelectedContext() {
  const selection = getSelection()
  const text = String(selection?.toString() || "").trim()
  let element = null
  if (selection && selection.rangeCount > 0) {
    const node = selection.getRangeAt(0).commonAncestorContainer
    element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  }
  return {
    browserSessionId,
    url: location.href,
    title: document.title,
    text,
    element: element ? describeElement(element) : null,
  }
}

async function fetchWithCookie(args) {
  const url = new URL(args.url, location.href)
  if (url.origin !== location.origin) {
    throw new Error("omeety_fetch_with_cookie only allows current platform origin")
  }

  const method = String(args.method || "GET").toUpperCase()
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !args.confirmed) {
    const approved = window.confirm(`Agent wants to send ${method} ${url.pathname}. Continue?`)
    if (!approved) throw new Error("User rejected the browser request")
  }

  const response = await fetch(url.toString(), {
    method,
    headers: args.headers || {},
    body: args.body ?? undefined,
    credentials: "include",
  })
  const maxBytes = clamp(Number(args.maxBytes || 200000), 1024, 1000000)
  const text = await response.text()
  return {
    url: url.toString(),
    status: response.status,
    ok: response.ok,
    redirected: response.redirected,
    contentType: response.headers.get("content-type"),
    body: text.slice(0, maxBytes),
    truncated: text.length > maxBytes,
  }
}

function applyPreviewPatch(args) {
  const patchId = String(args.patchId || crypto.randomUUID())
  const applied = []

  for (const patch of args.patches || []) {
    const target = mustFind(patch.selector)
    const record = snapshotElement(target)
    record.inserted = []

    target.setAttribute(PATCH_ATTR, patchId)
    target.classList.add("omeety-highlight")

    if (patch.text !== undefined) target.textContent = String(patch.text)
    if (patch.html !== undefined) target.innerHTML = String(patch.html)
    if (patch.value !== undefined && "value" in target) {
      target.value = String(patch.value)
      target.dispatchEvent(new Event("input", { bubbles: true }))
      target.dispatchEvent(new Event("change", { bubbles: true }))
    }
    if (patch.style && typeof patch.style === "object") {
      for (const [key, value] of Object.entries(patch.style)) target.style[key] = String(value)
    }
    if (patch.attributes && typeof patch.attributes === "object") {
      for (const [key, value] of Object.entries(patch.attributes)) {
        target.setAttribute(key, String(value))
      }
    }
    if (patch.className) target.classList.add(...String(patch.className).split(/\s+/).filter(Boolean))
    for (const [position, html] of [
      ["beforeend", patch.appendHtml],
      ["beforebegin", patch.beforeHtml],
      ["afterend", patch.afterHtml],
    ]) {
      if (!html) continue
      record.inserted.push(...insertTemporaryHtml(target, position, String(html), patchId))
    }

    applied.push({ selector: patch.selector, element: describeElement(target), record })
  }

  patchStore.set(patchId, applied)
  return { patchId, applied: applied.length }
}

function rollbackPreviewPatch(patchId) {
  const ids = patchId ? [patchId] : [...patchStore.keys()]
  let restored = 0
  for (const id of ids) {
    const records = patchStore.get(id) || []
    for (const item of records.reverse()) {
      restoreElement(item.record)
      restored += 1
    }
    patchStore.delete(id)
  }
  return { restored, remainingPatchIds: [...patchStore.keys()] }
}

async function clickElement(args) {
  const element = args.uid ? findByUid(args.uid) : mustFind(args.selector)
  const label = element.innerText || element.value || element.getAttribute("aria-label") || args.selector || args.uid
  if (!args.confirmed && DANGEROUS_RE.test(label)) {
    if (args.backgroundTask) {
      throw new Error(
        `Background task requires human confirmation before clicking "${String(label).trim()}"`
      )
    }
    const approved = window.confirm(`Agent wants to click "${label.trim()}". Continue?`)
    if (!approved) throw new Error("User rejected dangerous click")
  }
  element.scrollIntoView({ block: "center", inline: "center" })
  const description = describeElement(element)
  // 先让 runtime message 把结果送回 background，再在下一个 task 触发点击。若点击同步导航，旧
  // document 的 content script 此时即使被销毁，也不会把已成功的点击误报成 channel closed。
  setTimeout(() => element.click(), 0)
  return { clicked: true, element: description }
}

// 按可见文本点击元素：穿透 shadow DOM 找"自身直接文本"匹配的可见元素并点击。对飞书会话列表项这类
// 无 uid、无语义 role 的纯 div 特别有用——agent 不必 execute_js 算坐标，直接"点文本为'羊了羊'的会话"。
// 多个匹配时优先 button/a/[role=button]/菜单项/列表项，再取最矮（叶子）的那个，避免点到包裹整段的大容器。
function clickByText(args) {
  const text = String(args.text ?? "")
  if (!text.trim()) throw new Error("click_text 需要 text")
  const mode = args.exact ? "exact" : "contains"
  const matches = []
  const walk = (root) => {
    if (!root) return
    let walker
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode(el) {
          return isVisible(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
        },
      })
    } catch {
      return
    }
    while (walker.nextNode()) {
      const el = walker.currentNode
      // "直接文本"：只拼元素自身的直接文本子节点，不含后代——避免父容器匹配到整段子树文本。
      let direct = ""
      for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) direct += n.textContent
      direct = direct.replace(/\s+/g, " ").trim()
      if (!direct) continue
      const hit = mode === "exact" ? direct === text : direct.includes(text)
      if (hit) matches.push(el)
    }
    try {
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot)
    } catch {
      /* ignore */
    }
  }
  walk(document.body)
  if (!matches.length) {
    throw new Error(
      `click_text: 没找到文本${mode === "exact" ? "等于" : "包含"}"${text}"的可见元素（改用 contains 模式、或 omeety_get_page_snapshot 确认文本/用 📌 选取）`
    )
  }
  const INTERACTIVE_ROLE = ["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "listitem", "treeitem", "row", "cell"]
  const rank = (el) => {
    const role = el.getAttribute("role")
    if (["BUTTON", "A"].includes(el.tagName) || INTERACTIVE_ROLE.includes(role)) return 0
    if (el.onclick || el.hasAttribute("tabindex")) return 1
    return 2
  }
  matches.sort(
    (a, b) => rank(a) - rank(b) || Math.round(a.getBoundingClientRect().height) - Math.round(b.getBoundingClientRect().height)
  )
  const target = matches[0]
  const label = target.innerText || target.getAttribute("aria-label") || text
  if (!args.confirmed && DANGEROUS_RE.test(label)) {
    const approved = window.confirm(
      `Agent wants to click text "${text}" (matched <${target.tagName.toLowerCase()}>). Continue?`
    )
    if (!approved) throw new Error("User rejected dangerous text click")
  }
  target.scrollIntoView({ block: "center", inline: "center" })
  const description = describeElement(target)
  setTimeout(() => target.click(), 0)
  return { clicked: true, text, matchedBy: mode, matchCount: matches.length, element: description }
}

function clickAt(args) {
  const x = clamp(Number(args.x), 0, Math.max(0, window.innerWidth - 1))
  const y = clamp(Number(args.y), 0, Math.max(0, window.innerHeight - 1))
  const element = document.elementFromPoint(x, y)
  if (!element) throw new Error(`No element found at viewport coordinate ${x},${y}`)
  const label = element.innerText || element.value || element.getAttribute("aria-label") || cssPath(element)
  if (!args.confirmed && DANGEROUS_RE.test(label)) {
    const approved = window.confirm(`Agent wants to click "${String(label).trim()}". Continue?`)
    if (!approved) throw new Error("User rejected dangerous coordinate click")
  }
  const description = describeElement(element)
  setTimeout(() => {
    focusElement(element)
    dispatchPointerMouseSequence(element, x, y)
  }, 0)
  return {
    clicked: true,
    x,
    y,
    element: description,
  }
}

function fillElement(args) {
  const element = args.uid ? findByUid(args.uid) : mustFind(args.selector)
  const value = String(args.value ?? "")
  element.scrollIntoView({ block: "center", inline: "center" })
  setEditableText(element, value, { replace: true })
  return { filled: true, element: describeElement(element), valueLength: value.length }
}

function typeText(args) {
  const text = String(args.text ?? "")
  const element = resolveTargetElement(args) || document.activeElement
  if (!element || element === document.body || element === document.documentElement) {
    throw new Error("No editable target is focused; pass selector or x/y")
  }
  focusElement(element)
  setEditableText(element, text, { replace: Boolean(args.clear) })
  return {
    typed: true,
    element: describeElement(element),
    textLength: text.length,
    mode: args.clear ? "replace" : "append",
  }
}

function pressKey(args) {
  const key = String(args.key || "")
  if (!key) throw new Error("key is required")
  const element = resolveTargetElement(args) || document.activeElement || document.body
  focusElement(element)
  const beforeValue = getEditableText(element)
  dispatchKeyboardEvent(element, "keydown", key)
  applySimpleKeyEdit(element, key)
  dispatchKeyboardEvent(element, "keyup", key)
  const afterValue = getEditableText(element)
  return {
    pressed: true,
    key,
    element: describeElement(element),
    valueChanged: beforeValue !== afterValue,
  }
}

function selectElement(args) {
  const element = args.uid ? findByUid(args.uid) : mustFind(args.selector)
  if (!(element instanceof HTMLSelectElement)) throw new Error("Target is not a select element")
  element.value = String(args.value ?? "")
  element.dispatchEvent(new Event("input", { bubbles: true }))
  element.dispatchEvent(new Event("change", { bubbles: true }))
  return { selected: true, element: describeElement(element), value: element.value }
}

function scrollPage(args) {
  const deltaX = Number.isFinite(Number(args.deltaX)) ? Number(args.deltaX) : 0
  const deltaY = Number.isFinite(Number(args.deltaY)) ? Number(args.deltaY) : 600
  const coordinateTarget =
    Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))
      ? document.elementFromPoint(
          clamp(Number(args.x), 0, Math.max(0, window.innerWidth - 1)),
          clamp(Number(args.y), 0, Math.max(0, window.innerHeight - 1))
        )
      : null
  const target = findScrollableAncestor(coordinateTarget) || document.scrollingElement || document.documentElement
  const before = getScrollPosition(target)
  target.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" })
  const after = getScrollPosition(target)
  return {
    scrolled: true,
    deltaX,
    deltaY,
    target: target === document.scrollingElement ? "document" : describeElement(target),
    before,
    after,
  }
}

function requestUserConfirmation(args) {
  const approved = window.confirm(`${args.message || "Confirm agent action"}\n\n${args.detail || ""}`)
  return { approved }
}

// 收集 root 及其所有 shadow root 内的文本（textContent）。document.body.innerText 不穿透 shadow root，
// 飞书等大量内容在 shadow 里 → wait_for(text) 用本函数才能匹配到。
function collectAllText(root = document.body) {
  let out = root?.textContent || ""
  try {
    for (const el of root?.querySelectorAll ? root.querySelectorAll("*") : []) {
      if (el.shadowRoot) out += "\n" + collectAllText(el.shadowRoot)
    }
  } catch { /* ignore */ }
  return out
}
// 轮询等待页面状态就绪（选择器出现 / 文本出现）。agent 在 navigate/click 之后用它代替瞎等固定秒数。
// 200ms 间隔：比 MutationObserver 省一次回流风暴的复杂度，对 agent 场景足够快。
async function waitFor(args) {
  const timeoutMs = clamp(Number(args.timeoutMs ?? 10000), 500, 60000)
  const selector = args.selector ? String(args.selector) : null
  const text = args.text ? String(args.text) : null
  if (!selector && !text) throw new Error("wait_for 需要 selector 或 text")
  const started = Date.now()
  const probe = () => {
    if (selector) {
      let el = null
      try {
        el = queryAllDeep(selector)[0] || null
      } catch {
        el = document.querySelector(selector)
      }
      if (el && isVisible(el)) return { kind: "selector", el }
    }
    if (text) {
      const bodyText = collectAllText(document.body) // 穿透 shadow root（飞书等大量内容在 shadow 里）
      if (bodyText.includes(text)) return { kind: "text", el: null }
    }
    return null
  }
  for (;;) {
    const hit = probe()
    if (hit) {
      return {
        found: true,
        matchedBy: hit.kind,
        waitedMs: Date.now() - started,
        element: hit.el ? describeElement(hit.el) : null,
      }
    }
    // background 的跨导航等待每次只做立即探测，避免把长 Promise 留在即将销毁的旧文档中。
    if (args.probeOnly) return { found: false, waitedMs: Date.now() - started }
    if (Date.now() - started >= timeoutMs) {
      return { found: false, timeout: true, waitedMs: Date.now() - started }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

// 悬停：展开 hover 才出现的菜单/提示（合成 pointerover/mouseover/mousemove 序列）。
// 菜单展开后通常需要重新 get_page_snapshot 拿到新出现的项再点。
function hoverElement(args) {
  const element = resolveTargetElement(args)
  if (!element) throw new Error("hover 需要 uid/selector/x,y，且目标元素存在")
  element.scrollIntoView({ block: "center", inline: "center" })
  const r = element.getBoundingClientRect()
  const x = Number.isFinite(Number(args.x)) ? Number(args.x) : r.x + r.width / 2
  const y = Number.isFinite(Number(args.y)) ? Number(args.y) : r.y + r.height / 2
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window }
  for (const type of ["pointerover", "pointermove", "mouseover", "mousemove"]) {
    try {
      if (type.startsWith("pointer")) {
        element.dispatchEvent(new PointerEvent(type, { ...base, pointerType: "mouse", isPrimary: true, pointerId: 1 }))
      } else {
        element.dispatchEvent(new MouseEvent(type, base))
      }
    } catch {
      /* ignore */
    }
  }
  return { hovered: true, x: Math.round(x), y: Math.round(y), element: describeElement(element) }
}

function resolveTargetElement(args = {}) {
  if (args.uid) return findByUid(args.uid)
  if (args.selector) return mustFind(args.selector)
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
    return document.elementFromPoint(
      clamp(Number(args.x), 0, Math.max(0, window.innerWidth - 1)),
      clamp(Number(args.y), 0, Math.max(0, window.innerHeight - 1))
    )
  }
  return null
}

function focusElement(element) {
  if (element && typeof element.focus === "function") {
    element.focus({ preventScroll: true })
  }
}

function dispatchPointerMouseSequence(element, x, y) {
  // 模拟真实左键单击。合成事件 isTrusted 恒为 false（JS 无法绕过），但很多 SPA
  // （飞书搜索等）主要靠校验 event.detail（真实单击=1，合成默认=0）来过滤"假点击"，
  // 补 detail=1 / button=0 / buttons / pointerId 后通常即可触发其 mousedown/click handler。
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window }
  for (const type of ["pointerover", "pointermove", "pointerdown", "pointerup"]) {
    try {
      element.dispatchEvent(new PointerEvent(type, {
        ...base,
        pointerType: "mouse",
        isPrimary: true,
        pointerId: 1,
        button: 0,
        buttons: type === "pointerdown" ? 1 : 0,
        pressure: type === "pointerdown" ? 0.5 : 0,
      }))
    } catch {
      break
    }
  }
  for (const type of ["mouseover", "mousemove", "mousedown", "mouseup", "click"]) {
    const isMove = type === "mouseover" || type === "mousemove"
    element.dispatchEvent(new MouseEvent(type, {
      ...base,
      detail: isMove ? 0 : 1, // 真实单击：mousedown/mouseup/click 的 detail=1
      button: 0,
      buttons: type === "mousedown" ? 1 : 0,
    }))
  }
}

function setEditableText(element, text, options = {}) {
  if (element.isContentEditable) {
    // 优先 execCommand('insertText')：它会派发真实的 beforeinput/input，
    // 富文本编辑器（飞书 Lark EditorKit、ProseMirror、Slate 等）靠这个更新内部 model；
    // 直接设 textContent 绕过 model，会出现"字显示了但组件不响应"（如飞书搜索不触发）。
    element.focus()
    const sel = window.getSelection()
    if (options.replace) {
      sel.selectAllChildren(element) // 全选 → insertText 替换
    } else {
      const range = document.createRange()
      range.selectNodeContents(element)
      range.collapse(false) // 光标移到末尾
      sel.removeAllRanges()
      sel.addRange(range)
    }
    let ok = false
    try {
      ok = document.execCommand("insertText", false, text)
    } catch {
      ok = false
    }
    if (!ok) {
      const next = options.replace ? text : `${element.textContent || ""}${text}`
      element.textContent = next
    }
  } else if ("value" in element) {
    const previous = String(element.value || "")
    const next = options.replace ? text : `${previous}${text}`
    setNativeValue(element, next)
  } else {
    throw new Error("Target element cannot accept text")
  }
  // 用 InputEvent 而非裸 Event：富文本/受控 contenteditable（飞书搜索等）监听
  // InputEvent（看 inputType/data），裸 Event("input") 不被识别为"用户输入"，
  // 会出现"文字进去了但没触发搜索/onChange"的现象。
  try {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text, isComposing: false }))
  } catch {
    element.dispatchEvent(new Event("input", { bubbles: true }))
  }
  element.dispatchEvent(new Event("change", { bubbles: true }))
}

function setNativeValue(element, value) {
  const prototype = Object.getPrototypeOf(element)
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
  if (descriptor?.set) descriptor.set.call(element, value)
  else element.value = value
}

function getEditableText(element) {
  if (!element) return ""
  if (element.isContentEditable) return element.textContent || ""
  if ("value" in element) return String(element.value || "")
  return ""
}

function dispatchKeyboardEvent(element, type, key) {
  element.dispatchEvent(
    new KeyboardEvent(type, {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      composed: true,
    })
  )
}

function applySimpleKeyEdit(element, key) {
  if (key === "Backspace") {
    const current = getEditableText(element)
    if (current) setEditableText(element, current.slice(0, -1), { replace: true })
  }
  if (key === "Enter" && element instanceof HTMLTextAreaElement) {
    setEditableText(element, "\n")
  }
}

function findScrollableAncestor(element) {
  let node = element
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node)
    const scrollableY = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight
    const scrollableX = /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth
    if (scrollableY || scrollableX) return node
    node = node.parentElement
  }
  return null
}

function getScrollPosition(element) {
  return {
    left: Math.round(element.scrollLeft || 0),
    top: Math.round(element.scrollTop || 0),
  }
}

function insertTemporaryHtml(target, position, html, patchId) {
  const template = document.createElement("template")
  template.innerHTML = html
  const nodes = [...template.content.childNodes].map((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      node.setAttribute(PATCH_ATTR, patchId)
      node.classList.add("omeety-highlight")
      return node
    }
    const span = document.createElement("span")
    span.setAttribute(PATCH_ATTR, patchId)
    span.className = "omeety-highlight"
    span.textContent = node.textContent || ""
    return span
  })

  if (position === "beforeend") target.append(...nodes)
  else if (position === "beforebegin") target.before(...nodes)
  else if (position === "afterend") target.after(...nodes)
  else throw new Error(`Unsupported insert position: ${position}`)

  return nodes
}

function collectVisibleText(maxTextLength) {
  if (maxTextLength <= 0) return ""
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue?.replace(/\s+/g, " ").trim()
      if (!text) return NodeFilter.FILTER_REJECT
      return isVisible(node.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  let out = ""
  while (walker.nextNode() && out.length < maxTextLength) {
    out += `${walker.currentNode.nodeValue.replace(/\s+/g, " ").trim()}\n`
  }
  return out.slice(0, maxTextLength)
}

function getPageOverview() {
  const visibleButtons = [...document.querySelectorAll("button,input[type=button],input[type=submit]")]
    .filter(isVisible)
    .slice(0, 20)
    .map((element) => compactText(element.innerText || element.value || element.getAttribute("aria-label") || ""))
    .filter(Boolean)
  const visibleInputs = [...document.querySelectorAll("input,textarea,select,[contenteditable=true]")]
    .filter(isVisible)
    .slice(0, 20)
    .map((element) => ({
      type: element.type || element.tagName.toLowerCase(),
      name: element.getAttribute("name"),
      placeholder: element.getAttribute("placeholder"),
      label: findLabel(element),
    }))
  return {
    heading: compactText(document.querySelector("h1,h2,h3,[role=heading]")?.innerText || ""),
    path: location.hash || location.pathname,
    counts: {
      forms: document.forms.length,
      buttons: [...document.querySelectorAll("button,input[type=button],input[type=submit]")].filter(isVisible)
        .length,
      links: [...document.querySelectorAll("a[href]")].filter(isVisible).length,
      inputs: [...document.querySelectorAll("input,textarea,select,[contenteditable=true]")].filter(isVisible)
        .length,
      tables: [...document.querySelectorAll("table")].filter(isVisible).length,
    },
    sampleButtons: visibleButtons,
    sampleInputs: visibleInputs,
  }
}

function describeForm(form) {
  return {
    selector: cssPath(form),
    id: form.id || null,
    name: form.getAttribute("name"),
    action: form.action || null,
    method: form.method || null,
    fields: [...form.querySelectorAll("input,textarea,select")]
      .filter(isVisible)
      .slice(0, 80)
      .map(describeInput),
  }
}

function describeClickable(element) {
  return {
    ...describeElement(element),
    text: compactText(element.innerText || element.value || element.getAttribute("title") || ""),
    href: element.href || null,
  }
}

function describeInput(element) {
  return {
    ...describeElement(element),
    type: element.type || element.tagName.toLowerCase(),
    name: element.getAttribute("name"),
    placeholder: element.getAttribute("placeholder"),
    label: findLabel(element),
    valuePreview: "value" in element ? String(element.value || "").slice(0, 80) : null,
  }
}

function describeTable(table) {
  const headers = [...table.querySelectorAll("th")].slice(0, 30).map((th) => compactText(th.innerText))
  const rows = [...table.querySelectorAll("tr")]
    .slice(0, 5)
    .map((tr) => [...tr.children].slice(0, 10).map((td) => compactText(td.innerText)))
  return { selector: cssPath(table), headers, rows }
}

function describeElement(element) {
  return {
    selector: cssPath(element),
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    className: element.className || null,
    text: compactText(element.innerText || element.textContent || ""),
  }
}

function findLabel(element) {
  if (element.id) {
    const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
    if (label) return compactText(label.innerText)
  }
  return compactText(element.closest("label")?.innerText || "")
}

function compactText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 160) || null
}

function mustFind(selector) {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`Element not found: ${selector}`)
  return element
}

function snapshotElement(element) {
  return {
    element,
    html: element.innerHTML,
    text: element.textContent,
    value: "value" in element ? element.value : undefined,
    className: element.className,
    style: element.getAttribute("style"),
    attrs: [...element.attributes].map((attr) => [attr.name, attr.value]),
  }
}

function restoreElement(record) {
  for (const node of record.inserted || []) node.remove()
  const element = record.element
  if (!element?.isConnected) return
  while (element.attributes.length) element.removeAttribute(element.attributes[0].name)
  for (const [name, value] of record.attrs) element.setAttribute(name, value)
  element.innerHTML = record.html
  if (record.value !== undefined && "value" in element) element.value = record.value
  if (record.style === null) element.removeAttribute("style")
  else element.setAttribute("style", record.style)
  element.className = record.className
}

function isVisible(element) {
  if (!element) return false
  const style = getComputedStyle(element)
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false
  }
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function cssPath(element) {
  if (element.id) return `#${CSS.escape(element.id)}`
  const parts = []
  let node = element
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
    let part = node.tagName.toLowerCase()
    const parent = node.parentElement
    if (parent) {
      const same = [...parent.children].filter((child) => child.tagName === node.tagName)
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`
    }
    parts.unshift(part)
    node = parent
  }
  return parts.length ? parts.join(" > ") : "body"
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}
