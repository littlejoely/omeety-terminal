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
let lastPageSnapshot = null
const locatorMemory = new Map()
const locatorRecovery = { attempts: 0, recovered: 0, ambiguous: 0, failed: 0, last: null }
const LOCATOR_MEMORY_MAX = 2000

// 自包含模式只处理工具执行请求；不再有 Codeg bootstrap / xyy_* 混淆 shim / 注册逻辑。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "omeety_execute_tool") {
    void executeTool(message.tool, message.arguments || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }))
    return true
  }
  if (message?.type === "omeety_start_pick") {
    // 再点一次 = 完成当前连续选取（Esc 才是取消）
    if (pickActive) {
      finishPickMode()
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
let pickMoveFrame = 0
let pickPointerX = 0
let pickPointerY = 0
let pickedElements = []
const PICK_LIMIT = 20

function startPickMode() {
  if (pickActive) return
  document.getElementById("omeety-pick-highlight")?.remove() // 清可能的残留（重载/异常）
  document.getElementById("omeety-pick-banner")?.remove()
  clearPickMarkers()
  pickedElements = []
  pickActive = true
  pickHighlight = document.createElement("div")
  pickHighlight.id = "omeety-pick-highlight"
  pickHighlight.style.display = "none"
  pickBanner = document.createElement("div")
  pickBanner.id = "omeety-pick-banner"
  pickBanner.textContent = "连续点选元素 · Enter/点此完成 · Esc 取消"
  document.body.appendChild(pickHighlight)
  document.body.appendChild(pickBanner)
  document.addEventListener("mousemove", onPickMove, true)
  document.addEventListener("click", onPickClick, true)
  document.addEventListener("keydown", onPickKey, true)
}

function endPickMode({ keepMarkers = false } = {}) {
  if (!pickActive) return
  pickActive = false
  document.removeEventListener("mousemove", onPickMove, true)
  document.removeEventListener("click", onPickClick, true)
  document.removeEventListener("keydown", onPickKey, true)
  if (pickMoveFrame) cancelAnimationFrame(pickMoveFrame)
  pickMoveFrame = 0
  pickHighlight?.remove()
  pickBanner?.remove()
  pickHighlight = pickBanner = null
  document.querySelectorAll('[data-omeety-pick-active="1"]').forEach((node) => node.removeAttribute("data-omeety-pick-active"))
  if (!keepMarkers) clearPickMarkers()
}

function clearPickMarkers() {
  document.querySelectorAll("[data-omeety-pick-id], [data-omeety-pick]").forEach((node) => {
    node.removeAttribute("data-omeety-pick-id")
    node.removeAttribute("data-omeety-pick")
    node.removeAttribute("data-omeety-pick-active")
  })
}

function describePick(el, uid) {
  const r = el.getBoundingClientRect()
  const href = el.href || el.closest?.("a[href]")?.href || null
  return {
    uid,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") || null,
    text: compactText(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || ""),
    label: compactText(el.getAttribute("aria-label") || el.getAttribute("title") || findLabel(el) || ""),
    type: el.getAttribute("type") || null,
    href,
    selector: cssPath(el),
    bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    url: location.href,
    capturedAt: new Date().toISOString(),
  }
}

function syncPickedElements() {
  pickedElements = pickedElements.filter((el) => el?.isConnected)
  document.querySelectorAll("[data-omeety-pick-id], [data-omeety-pick]").forEach((node) => {
    node.removeAttribute("data-omeety-pick-id")
    node.removeAttribute("data-omeety-pick")
  })
  const picks = pickedElements.map((el, index) => {
    const uid = `pick-${index + 1}`
    el.setAttribute("data-omeety-pick-id", uid)
    el.setAttribute("data-omeety-pick-active", "1")
    return describePick(el, uid)
  })
  // Backward compatibility: uid:"pick" continues to target the most recently
  // selected element, while pick-1..N address the complete selection.
  pickedElements.at(-1)?.setAttribute("data-omeety-pick", "1")
  if (pickBanner) pickBanner.textContent = `已选 ${picks.length} 个 · 继续点选 · Enter/点此完成 · Esc 取消`
  return picks
}

function finishPickMode() {
  if (!pickActive) return
  const picks = syncPickedElements()
  endPickMode({ keepMarkers: true })
  chrome.runtime.sendMessage({ type: "omeety_pick_done", picks, cancelled: false })
}

function cancelPickMode() {
  if (!pickActive) return
  pickedElements = []
  endPickMode()
  chrome.runtime.sendMessage({ type: "omeety_pick_done", picks: [], cancelled: true })
}

function onPickMove(e) {
  pickPointerX = e.clientX
  pickPointerY = e.clientY
  if (pickMoveFrame) return
  // Mousemove can fire far faster than the display refresh rate. Resolve the
  // target and its layout box at most once per frame to avoid forced-layout
  // storms on complex pages while the picker is being used.
  pickMoveFrame = requestAnimationFrame(updatePickHighlight)
}

function updatePickHighlight() {
  pickMoveFrame = 0
  if (!pickActive || !pickHighlight) return
  const el = document.elementFromPoint(pickPointerX, pickPointerY)
  if (!el || el === pickHighlight || el === pickBanner || !el.getBoundingClientRect) return
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return
  pickHighlight.style.display = "block"
  pickHighlight.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`
  pickHighlight.style.width = r.width + "px"
  pickHighlight.style.height = r.height + "px"
}

function onPickClick(e) {
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (el === pickBanner) {
    finishPickMode()
    return
  }
  if (!el || el === document.body || el === document.documentElement || el === pickHighlight) return
  const existing = pickedElements.indexOf(el)
  if (existing >= 0) {
    pickedElements.splice(existing, 1)
    el.removeAttribute("data-omeety-pick-active")
  } else if (pickedElements.length < PICK_LIMIT) {
    pickedElements.push(el)
  } else {
    if (pickBanner) pickBanner.textContent = `最多选取 ${PICK_LIMIT} 个元素 · Enter/点此完成`
    return
  }
  const picks = syncPickedElements()
  chrome.runtime.sendMessage({ type: "omeety_pick_progress", picks })
}

function onPickKey(e) {
  if (e.key === "Escape") {
    e.preventDefault()
    e.stopPropagation()
    cancelPickMode()
  } else if (e.key === "Enter") {
    e.preventDefault()
    e.stopPropagation()
    finishPickMode()
  }
}

async function executeTool(tool, args) {
  switch (tool) {
    case "omeety_get_page_snapshot":
      return getPageSnapshot(args)
    case "omeety_browser_query":
      return browserQuery(args)
    case "omeety_get_selected_context":
      return getSelectedContext()
    case "omeety_get_context_bundle":
      return getContextBundle(args)
    case "omeety_get_verification_state":
      return getVerificationState(args)
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
  const started = performance.now()
  const mode = args.mode === "detailed" ? "detailed" : "light"
  const profile = ["compact", "standard"].includes(args.profile) ? args.profile : "standard"
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
    profile,
    selection: String(getSelection()?.toString() || "").trim().slice(0, 4000),
    visibleText: collectVisibleText(maxTextLength),
    overview: getPageOverview(),
    topology: inspectDocumentTopology(),
    locatorRecovery: { ...locatorRecovery, remembered: locatorMemory.size },
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
    snapshot.forms = queryAllDeep("form").slice(0, 20).map(describeForm)
    snapshot.buttons = queryAllDeep("button,input[type=button],input[type=submit],a")
      .filter(isVisible)
      .slice(0, 100)
      .map(describeClickable)
    snapshot.inputs = queryAllDeep("input,textarea,select,[contenteditable=true]")
      .filter(isVisible)
      .slice(0, 120)
      .map(describeInput)
    snapshot.links = queryAllDeep("a[href]")
      .filter(isVisible)
      .slice(0, 80)
      .map(describeClickable)
    snapshot.tables = queryAllDeep("table")
      .filter(isVisible)
      .slice(0, 20)
      .map(describeTable)
  }
  // 可交互元素 + 稳定 uid（每次快照重新打标）。agent 拿 uid 去调 click/fill/type，比猜动态 selector 稳。
  // 默认 120 与 tools.meta.js 的 maxInteractive default 对齐（之前这里写 60 导致大列表被砍）。
  snapshot.interactive = listInteractive(Number(args.maxInteractive) || 120, { compact: profile === "compact" })
  return finalizePageSnapshot(snapshot, args, started)
}

function finalizePageSnapshot(snapshot, args, started) {
  const digestSource = JSON.stringify({ ...snapshot, capturedAt: undefined })
  snapshot.snapshotId = `snap-${fnv1a(digestSource)}`
  snapshot.metrics = {
    buildMs: Math.round((performance.now() - started) * 10) / 10,
    visibleTextChars: snapshot.visibleText.length,
    interactiveCount: snapshot.interactive.length,
    estimatedBytes: 0,
  }
  snapshot.metrics.estimatedBytes = JSON.stringify(snapshot).length

  const previous = lastPageSnapshot
  lastPageSnapshot = snapshot
  const since = args.sinceSnapshotId ? String(args.sinceSnapshotId) : ""
  if (!since) return snapshot
  if (since === snapshot.snapshotId) {
    return {
      snapshotId: snapshot.snapshotId,
      baseSnapshotId: since,
      unchanged: true,
      incremental: true,
      url: snapshot.url,
      title: snapshot.title,
      capturedAt: snapshot.capturedAt,
      metrics: snapshot.metrics,
    }
  }
  // detailed 模式包含表格/表单等多类数组；先保持完整返回，避免客户端合并时丢字段。
  if (!previous || previous.snapshotId !== since || snapshot.mode === "detailed" || previous.profile !== snapshot.profile) {
    return {
      ...snapshot,
      incremental: false,
      baseSnapshotId: since,
      incrementalFallback: previous ? "base snapshot mismatch or detailed mode" : "base snapshot unavailable",
    }
  }

  const previousInteractive = new Map(previous.interactive.map((item) => [item.uid, JSON.stringify(item)]))
  const currentInteractive = new Map(snapshot.interactive.map((item) => [item.uid, JSON.stringify(item)]))
  const interactiveUpsert = snapshot.interactive.filter((item) => previousInteractive.get(item.uid) !== JSON.stringify(item))
  const interactiveRemoved = previous.interactive.filter((item) => !currentInteractive.has(item.uid)).map((item) => item.uid)
  const delta = { interactiveUpsert, interactiveRemoved }
  for (const key of ["visibleText", "overview", "topology", "selection"]) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(snapshot[key])) delta[key] = snapshot[key]
  }
  return {
    snapshotId: snapshot.snapshotId,
    baseSnapshotId: since,
    unchanged: false,
    incremental: true,
    url: snapshot.url,
    title: snapshot.title,
    viewport: snapshot.viewport,
    capturedAt: snapshot.capturedAt,
    metrics: snapshot.metrics,
    delta,
  }
}

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function inspectDocumentTopology() {
  let shadowRoots = 0
  try {
    shadowRoots = queryAllDeep("*").filter((element) => element.shadowRoot).length
  } catch {
    /* ignore */
  }
  const frames = []
  for (const frame of [...document.querySelectorAll("iframe,frame")].slice(0, 40)) {
    let sameOrigin = false
    let title = null
    let url = frame.getAttribute("src") || null
    try {
      sameOrigin = !!frame.contentDocument
      if (sameOrigin) {
        title = frame.contentDocument.title || null
        url = frame.contentWindow?.location?.href || url
      }
    } catch {
      sameOrigin = false
    }
    frames.push({
      sameOrigin,
      title,
      url,
      name: frame.getAttribute("name") || null,
      selector: cssPath(frame),
    })
  }
  return {
    shadowRoots,
    iframeCount: frames.length,
    sameOriginFrames: frames.filter((frame) => frame.sameOrigin).length,
    crossOriginFrames: frames.filter((frame) => !frame.sameOrigin).length,
    frames,
  }
}

// 收集可交互元素，给每个打 data-omeety-uid，返回 uid/role/text/bbox/selector。
// bbox 也能配合截图走"视觉定位坐标点击"；uid 则是精确的 DOM 句柄。
// 深度查询：穿透 shadow DOM。复杂 SPA（飞书/企业应用）把导航、会话列表、搜索框大量藏在 shadow root 里，
// 普通 querySelectorAll 查不到 → snapshot 漏采 → agent 找不到元素。这里递归进每个 shadowRoot，带深度/数量上限防失控。
function queryAllDeep(selector, root = document, acc = [], depth = 0) {
  if (depth > 15 || acc.length >= 5000) return acc
  try {
    for (const el of root.querySelectorAll(selector)) {
      if (acc.length >= 5000) break
      acc.push(el)
    }
  } catch {
    /* ignore */
  }
  if (acc.length >= 5000) return acc
  try {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) queryAllDeep(selector, el.shadowRoot, acc, depth + 1)
      if (acc.length >= 5000) break
    }
  } catch {
    /* ignore */
  }
  // 同源 iframe 可以直接读取并操作；跨域 iframe 由 topology 标记为受限，后续走 CDP/视觉兜底。
  try {
    for (const frame of root.querySelectorAll("iframe,frame")) {
      if (acc.length >= 5000) break
      try {
        if (frame.contentDocument) queryAllDeep(selector, frame.contentDocument, acc, depth + 1)
      } catch {
        /* cross-origin */
      }
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
  rememberLocator(u, el)
  return u
}

const INTERACTIVE_SELECTOR =
  'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"], [role="textbox"], [role="listitem"], [role="row"], [role="cell"], [role="gridcell"], [role="treeitem"], [contenteditable], [tabindex]:not([tabindex="-1"]), [onclick], li, tr, [class*="search" i]'

function listInteractive(max = 120, options = {}) {
  // 选择器：交互控件 + 列表/菜单/表格行项。之前缺 listitem/row/cell/li/tr 等，导致飞书会话列表、
  // 下拉菜单整列被折叠成父容器的单个 region，item 级拿不到 uid，agent 只能 execute_js 算坐标点。
  // 注：纯 div 的 SPA 列表项（如飞书会话项，无 role/onclick）仍选不中——那种用 omeety_click_text 按文本点。
  const seen = new Set()
  const els = queryAllDeep(INTERACTIVE_SELECTOR).filter((el) => {
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
  return picked.map((el) => describeInteractive(el, options))
}

function describeInteractive(el, options = {}) {
    const uid = uidFor(el)
    const r = getTopViewportRect(el)
    const locator = publicLocator(locatorMemory.get(uid), { compact: !!options.compact })
    const item = {
      uid,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || inferRole(el) || null,
      text: labelOf(el),
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    }
    if (locator && Object.keys(locator).length) item.locator = locator
    if (!options.compact) {
      item.selector = cssPath(el)
      item.frameChain = getFrameChain(el)
      item.shadowPath = getShadowPath(el)
    }
    return item
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

function locatorSignature(el) {
  const rect = getTopViewportRect(el)
  const parent = getContextParent(el)
  return {
    tag: el.tagName?.toLowerCase?.() || "",
    role: el.getAttribute?.("role") || inferRole(el),
    label: compactText(labelOf(el) || ""),
    text: compactText(el.innerText || el.textContent || ""),
    id: el.id || null,
    name: el.getAttribute?.("name") || null,
    type: el.getAttribute?.("type") || null,
    placeholder: el.getAttribute?.("placeholder") || null,
    ariaLabel: el.getAttribute?.("aria-label") || null,
    href: el.getAttribute?.("href") || null,
    selector: cssPath(el),
    parentTag: parent?.tagName?.toLowerCase?.() || null,
    parentLabel: compactText(parent ? labelOf(parent) || "" : ""),
    bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  }
}

function publicLocator(signature, options = {}) {
  if (!signature) return null
  const { tag, role, label, text, id, name, type, placeholder, ariaLabel, href, selector } = signature
  const locator = options.compact
    ? { id, name, type, placeholder, ariaLabel, href }
    : { tag, role, label, text, id, name, type, placeholder, ariaLabel, href }
  if (!options.compact) locator.selector = selector
  return Object.fromEntries(Object.entries(locator).filter(([, value]) => value !== null && value !== ""))
}

function rememberLocator(uid, el) {
  locatorMemory.delete(uid)
  locatorMemory.set(uid, locatorSignature(el))
  while (locatorMemory.size > LOCATOR_MEMORY_MAX) locatorMemory.delete(locatorMemory.keys().next().value)
}

function locatorScore(signature, el) {
  if (!signature || !el || el.tagName?.toLowerCase?.() !== signature.tag) return -Infinity
  const current = locatorSignature(el)
  let score = 2
  if (signature.id && current.id === signature.id) score += 14
  if (signature.ariaLabel && current.ariaLabel === signature.ariaLabel) score += 10
  if (signature.name && current.name === signature.name) score += 7
  if (signature.href && current.href === signature.href) score += 7
  if (signature.label && current.label === signature.label) score += 8
  else if (signature.label && current.label?.includes(signature.label)) score += 4
  if (signature.text && current.text === signature.text) score += 7
  else if (signature.text && current.text?.includes(signature.text)) score += 3
  if (signature.role && current.role === signature.role) score += 3
  if (signature.type && current.type === signature.type) score += 3
  if (signature.placeholder && current.placeholder === signature.placeholder) score += 4
  if (signature.selector && current.selector === signature.selector) score += 6
  if (signature.parentTag && current.parentTag === signature.parentTag) score += 1
  if (signature.parentLabel && current.parentLabel === signature.parentLabel) score += 3
  const distance = Math.hypot((signature.bbox?.x || 0) - (current.bbox?.x || 0), (signature.bbox?.y || 0) - (current.bbox?.y || 0))
  if (distance < 12) score += 4
  else if (distance < 80) score += 2
  return score
}

function findByUid(uid) {
  const u = String(uid)
  const hits = queryAllDeep(`[data-omeety-uid="${CSS.escape(u)}"]`)
  let el = hits[0] || null
  if (!el && u === "pick") el = queryAllDeep('[data-omeety-pick="1"]')[0] || null
  if (!el && /^pick-\d+$/.test(u)) el = queryAllDeep(`[data-omeety-pick-id="${CSS.escape(u)}"]`)[0] || null
  if (!el && /^u\d+$/.test(u) && locatorMemory.has(u)) {
    locatorRecovery.attempts += 1
    const signature = locatorMemory.get(u)
    const candidates = queryAllDeep(signature.tag).filter((candidate) => candidate.isConnected)
    const ranked = candidates
      .map((candidate) => ({ candidate, score: locatorScore(signature, candidate) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score)
    const best = ranked[0]
    const second = ranked[1]
    if (best?.score >= 10 && (!second || best.score - second.score >= 2)) {
      el = best.candidate
      uidMap.set(el, u)
      el.setAttribute("data-omeety-uid", u)
      rememberLocator(u, el)
      locatorRecovery.recovered += 1
      locatorRecovery.last = { uid: u, score: best.score, candidates: ranked.length, at: new Date().toISOString() }
    } else if (best) {
      locatorRecovery.ambiguous += 1
      locatorRecovery.last = { uid: u, score: best.score, secondScore: second?.score, candidates: ranked.length, ambiguous: true, at: new Date().toISOString() }
    } else {
      locatorRecovery.failed += 1
    }
  }
  if (!el) {
    throw new Error(`uid "${uid}" 不存在或已失效（页面可能重渲染过；重新 get_page_snapshot 或重新点 📌 选取）`)
  }
  if (/^u\d+$/.test(u)) rememberLocator(u, el)
  return el
}

function likelyClickable(el, allowHeuristic = true) {
  if (!el || el === document.body || el === document.documentElement) return false
  if (el.matches?.(INTERACTIVE_SELECTOR)) return true
  const role = String(el.getAttribute?.("role") || "").toLowerCase()
  if (["button", "link", "menuitem", "option", "tab", "listitem", "treeitem", "row", "cell"].includes(role)) return true
  if (!allowHeuristic) return false
  if (getComputedStyle(el).cursor === "pointer") return true
  return /(?:^|[_-])(button|btn|card|contact|department|folder|item|menu|option|row|tab)(?:$|[_-])/i.test(String(el.className || ""))
}

function clickableAncestor(el, maxDepth = 6) {
  let current = el
  for (let depth = 0; current && depth <= maxDepth; depth += 1) {
    if (isVisible(current) && likelyClickable(current, depth > 0)) return current
    const root = current.getRootNode?.()
    current = current.parentElement || (root instanceof ShadowRoot ? root.host : null)
  }
  return el
}

function matchingTextElements(text, exact = false, max = 300) {
  const matches = []
  const needle = String(text || "").toLowerCase()
  let scanned = 0
  const maxScanned = 7500
  const walk = (root) => {
    if (!root || matches.length >= max || scanned >= maxScanned) return
    let walker
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    } catch {
      return
    }
    while (walker.nextNode() && matches.length < max && scanned < maxScanned) {
      const el = walker.currentNode
      scanned += 1
      let direct = ""
      for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) direct += node.textContent
      direct = (compactText(direct) || "").toLowerCase()
      if (direct && (exact ? direct === needle : direct.includes(needle)) && isVisible(el)) matches.push({ el, direct })
    }
    try {
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot)
    } catch {
      /* ignore */
    }
    try {
      for (const frame of root.querySelectorAll("iframe,frame")) {
        if (frame.contentDocument?.body) walk(frame.contentDocument.body)
      }
    } catch {
      /* cross-origin */
    }
  }
  walk(document.body)
  return matches
}

function browserQuery(args = {}) {
  const started = performance.now()
  const query = String(args.query || "").trim().toLowerCase()
  const role = String(args.role || "").trim().toLowerCase()
  const selector = String(args.selector || "").trim()
  const limit = clamp(Number(args.limit ?? 20), 1, 100)
  let items
  if (selector) {
    items = queryAllDeep(selector).slice(0, 500).map((el) => {
      const uid = uidFor(el)
      const rect = getTopViewportRect(el)
      return {
        uid,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || inferRole(el),
        text: labelOf(el),
        selector: cssPath(el),
        visible: isVisible(el),
        bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        locator: publicLocator(locatorMemory.get(uid)),
      }
    })
  } else {
    items = listInteractive(500, { compact: true }).map((item) => ({ ...item, visible: true }))
    if (query) {
      const seen = new Set(items.map((item) => item.uid))
      for (const match of matchingTextElements(query, false, 300)) {
        const target = clickableAncestor(match.el)
        const item = describeInteractive(target, { compact: true })
        if (seen.has(item.uid)) continue
        seen.add(item.uid)
        items.push({ ...item, visible: true, matchedText: match.direct, promotedFrom: target === match.el ? null : match.el.tagName.toLowerCase() })
      }
    }
  }
  const ranked = items
    .map((item) => {
      const haystack = [item.matchedText, item.text, item.role, item.tag, item.locator?.ariaLabel, item.locator?.placeholder, item.locator?.name].filter(Boolean).join(" ").toLowerCase()
      let score = 0
      if (query) {
        if (haystack === query) score += 100
        else if (haystack.includes(query)) score += 50
        for (const token of query.split(/\s+/).filter(Boolean)) if (haystack.includes(token)) score += 5
      }
      if (role && String(item.role || "").toLowerCase() === role) score += 30
      if (!query && !role && selector) score += 1
      return { ...item, score }
    })
    .filter((item) => (!args.visibleOnly || item.visible) && (!query && !role ? true : item.score > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return { query, role: role || null, selector: selector || null, count: ranked.length, matches: ranked, locatorRecovery: { ...locatorRecovery, remembered: locatorMemory.size }, metrics: { queryMs: Math.round((performance.now() - started) * 10) / 10, candidatesScanned: items.length } }
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

function getContextBundle(args = {}) {
  const started = performance.now()
  const target = resolveContextTarget(args)
  let scrolledForScreenshot = false
  if (target && args.includeScreenshot !== false) {
    const initialRect = getTopViewportRect(target)
    const outsideViewport =
      initialRect.x + initialRect.width <= 0 ||
      initialRect.y + initialRect.height <= 0 ||
      initialRect.x >= window.innerWidth ||
      initialRect.y >= window.innerHeight
    if (outsideViewport) {
      target.scrollIntoView({ block: "center", inline: "center", behavior: "auto" })
      scrolledForScreenshot = true
    }
  }
  const selection = String(getSelection()?.toString() || "").trim().slice(0, 8000)
  const targetDescription = target ? describeContextTarget(target, args) : null
  const bundle = {
    version: 1,
    browserSessionId,
    url: location.href,
    title: document.title,
    selection,
    target: targetDescription,
    page: {
      overview: getPageOverview(),
      visibleTextAroundTarget: target ? collectAllText(getContextParent(target) || target, 3000).replace(/\s+/g, " ").trim() : collectVisibleText(3000),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      },
      topology: inspectDocumentTopology(),
    },
    screenshotRequest: targetDescription?.bbox
      ? { bbox: targetDescription.bbox, padding: clamp(Number(args.screenshotPadding ?? 24), 0, 160) }
      : null,
    scrolledForScreenshot,
    capturedAt: new Date().toISOString(),
  }
  bundle.metrics = {
    buildMs: Math.round((performance.now() - started) * 10) / 10,
    estimatedBytes: JSON.stringify(bundle).length,
  }
  return bundle
}

function resolveContextTarget(args = {}) {
  if (args.uid) return findByUid(args.uid)
  if (args.selector) {
    const element = queryAllDeep(String(args.selector))[0] || null
    if (!element) throw new Error(`Context Bundle target not found: ${args.selector}`)
    return element
  }
  const picked = queryAllDeep('[data-omeety-pick="1"]')[0]
  if (picked) return picked
  const selection = getSelection()
  if (selection?.rangeCount) {
    const node = selection.getRangeAt(0).commonAncestorContainer
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    if (element) return element
  }
  const active = document.activeElement
  return active && active !== document.body && active !== document.documentElement ? active : null
}

function describeContextTarget(element, args = {}) {
  const bbox = getTopViewportRect(element)
  const styleWindow = element.ownerDocument?.defaultView || window
  const style = styleWindow.getComputedStyle(element)
  const attributes = {}
  const allowedAttributes = ["aria-label", "aria-describedby", "aria-expanded", "aria-checked", "aria-selected", "title", "name", "type", "placeholder", "alt", "href", "src"]
  for (const name of allowedAttributes) {
    const value = element.getAttribute?.(name)
    if (value) attributes[name] = String(value).slice(0, 500)
  }
  const type = String(element.getAttribute?.("type") || "").toLowerCase()
  const valuePreview = type === "password" ? null : "value" in element ? String(element.value || "").slice(0, 500) : null
  const ownUid = element === document.body || element === document.documentElement ? null : uidFor(element)
  const centerX = bbox.x + bbox.width / 2
  const centerY = bbox.y + bbox.height / 2
  const nearbyInteractive = listInteractive(clamp(Number(args.maxNearbyInteractive ?? 24), 1, 80))
    .filter((item) => item.uid !== ownUid)
    .map((item) => {
      const x = item.bbox.x + item.bbox.w / 2
      const y = item.bbox.y + item.bbox.h / 2
      return { ...item, distance: Math.round(Math.hypot(x - centerX, y - centerY)) }
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, clamp(Number(args.maxNearbyInteractive ?? 12), 1, 30))

  const ancestors = []
  let parent = getContextParent(element)
  while (parent && ancestors.length < 6) {
    ancestors.push({
      tag: parent.tagName?.toLowerCase?.() || "document",
      role: parent.getAttribute?.("role") || null,
      text: compactText(parent.getAttribute?.("aria-label") || parent.getAttribute?.("title") || ""),
      selector: parent.tagName ? cssPath(parent) : null,
    })
    parent = getContextParent(parent)
  }
  return {
    uid: ownUid,
    selector: cssPath(element),
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role") || inferRole(element),
    accessibleName: labelOf(element),
    text: compactText(element.innerText || element.textContent || ""),
    valuePreview,
    attributes,
    bbox: { x: Math.round(bbox.x), y: Math.round(bbox.y), w: Math.round(bbox.width), h: Math.round(bbox.height) },
    visible: isVisible(element),
    disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
    editable: Boolean(element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)),
    styles: {
      display: style.display,
      visibility: style.visibility,
      color: style.color,
      backgroundColor: style.backgroundColor,
      font: style.font,
      cursor: style.cursor,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
    },
    frameChain: getFrameChain(element),
    shadowPath: getShadowPath(element),
    ancestors,
    nearbyInteractive,
  }
}

function getVerificationState(args = {}) {
  let target = null
  try {
    if (args.uid) target = findByUid(args.uid)
    else if (args.selector) target = queryAllDeep(String(args.selector))[0] || null
  } catch {
    target = null
  }
  const targetState = target
    ? {
        exists: true,
        visible: isVisible(target),
        text: compactText(target.innerText || target.textContent || ""),
        accessibleName: labelOf(target),
        role: target.getAttribute("role") || inferRole(target),
        value: "value" in target && String(target.type || "").toLowerCase() !== "password" ? String(target.value || "").slice(0, 1000) : null,
        checked: "checked" in target ? Boolean(target.checked) : null,
        disabled: Boolean(target.disabled || target.getAttribute("aria-disabled") === "true"),
        bbox: (() => {
          const r = getTopViewportRect(target)
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        })(),
      }
    : { exists: false }
  const visibleText = collectVisibleText(6000)
  return {
    url: location.href,
    title: document.title,
    textDigest: fnv1a(visibleText),
    target: targetState,
    capturedAt: new Date().toISOString(),
  }
}

function inferRole(element) {
  const roles = { A: "link", BUTTON: "button", INPUT: "textbox", TEXTAREA: "textbox", SELECT: "combobox", IMG: "img" }
  if (element.tagName === "INPUT" && ["button", "submit", "reset"].includes(String(element.type).toLowerCase())) return "button"
  if (element.tagName === "INPUT" && String(element.type).toLowerCase() === "checkbox") return "checkbox"
  return roles[element.tagName] || null
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
  const matches = matchingTextElements(text, !!args.exact, 500).map((match) => match.el)
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
  const leaf = matches[0]
  const target = clickableAncestor(leaf)
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
  return { clicked: true, text, matchedBy: mode, matchCount: matches.length, promotedToClickableAncestor: target !== leaf, element: description }
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
  const modifiers = new Set(Array.isArray(args.modifiers) ? args.modifiers : [])
  const init = { metaKey: modifiers.has("Meta"), ctrlKey: modifiers.has("Control"), altKey: modifiers.has("Alt"), shiftKey: modifiers.has("Shift") }
  dispatchKeyboardEvent(element, "keydown", key, init)
  applySimpleKeyEdit(element, key)
  dispatchKeyboardEvent(element, "keyup", key, init)
  const afterValue = getEditableText(element)
  return {
    pressed: true,
    key,
    modifiers: [...modifiers],
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
function collectAllText(root = document.body, maxLength = 100000) {
  let out = String(root?.textContent || "").slice(0, maxLength)
  if (out.length >= maxLength) return out
  try {
    for (const el of root?.querySelectorAll ? root.querySelectorAll("*") : []) {
      if (el.shadowRoot) out += "\n" + collectAllText(el.shadowRoot, maxLength - out.length)
      if (out.length >= maxLength) return out.slice(0, maxLength)
    }
  } catch { /* ignore */ }
  try {
    for (const frame of root?.querySelectorAll ? root.querySelectorAll("iframe,frame") : []) {
      try {
        if (frame.contentDocument?.body) out += "\n" + collectAllText(frame.contentDocument.body, maxLength - out.length)
        if (out.length >= maxLength) return out.slice(0, maxLength)
      } catch { /* cross-origin */ }
    }
  } catch { /* ignore */ }
  return out
}

function containsTextDeep(root, needle, visited = new Set()) {
  if (!root || visited.has(root)) return false
  visited.add(root)
  if (String(root.textContent || "").includes(needle)) return true
  try {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot && containsTextDeep(el.shadowRoot, needle, visited)) return true
    }
    for (const frame of root.querySelectorAll("iframe,frame")) {
      try {
        if (frame.contentDocument?.body && containsTextDeep(frame.contentDocument.body, needle, visited)) return true
      } catch { /* cross-origin */ }
    }
  } catch { /* ignore */ }
  return false
}
// 轮询等待页面状态就绪（选择器出现 / 文本出现）。agent 在 navigate/click 之后用它代替瞎等固定秒数。
// 200ms 间隔：比 MutationObserver 省一次回流风暴的复杂度，对 agent 场景足够快。
async function waitFor(args) {
  const timeoutMs = clamp(Number(args.timeoutMs ?? 10000), 500, 60000)
  const selector = args.selector ? String(args.selector) : null
  const text = args.text ? String(args.text) : null
  const selectorGone = args.selectorGone ? String(args.selectorGone) : null
  const textGone = args.textGone ? String(args.textGone) : null
  const urlIncludes = args.urlIncludes ? String(args.urlIncludes) : null
  const titleIncludes = args.titleIncludes ? String(args.titleIncludes) : null
  const valueEquals = args.valueEquals !== undefined ? String(args.valueEquals) : null
  const valueIncludes = args.valueIncludes !== undefined ? String(args.valueIncludes) : null
  const checked = typeof args.checked === "boolean" ? args.checked : null
  if (![selector, text, selectorGone, textGone, urlIncludes, titleIncludes, valueEquals, valueIncludes, checked].some((value) => value !== null)) {
    throw new Error("wait_for 需要 selector/text/url/title/value/checked 等至少一个条件")
  }
  const started = Date.now()
  const probe = () => {
    const conditions = []
    const findVisible = (query) => {
      let element = null
      try {
        element = queryAllDeep(query)[0] || null
      } catch {
        try { element = document.querySelector(query) } catch { element = null }
      }
      return element && isVisible(element) ? element : null
    }
    if (selector) {
      const element = findVisible(selector)
      conditions.push({ kind: "selector", matched: !!element, element })
    }
    if (selectorGone) conditions.push({ kind: "selectorGone", matched: !findVisible(selectorGone), element: null })
    if (text) {
      conditions.push({ kind: "text", matched: containsTextDeep(document.body, text), element: null })
    }
    if (textGone) {
      conditions.push({ kind: "textGone", matched: !containsTextDeep(document.body, textGone), element: null })
    }
    if (urlIncludes) conditions.push({ kind: "urlIncludes", matched: location.href.includes(urlIncludes), element: null })
    if (titleIncludes) conditions.push({ kind: "titleIncludes", matched: document.title.includes(titleIncludes), element: null })
    if (valueEquals !== null || valueIncludes !== null || checked !== null) {
      let target = null
      try {
        if (args.targetUid) target = findByUid(args.targetUid)
        else if (args.targetSelector) target = queryAllDeep(String(args.targetSelector))[0] || null
      } catch { target = null }
      const value = target && "value" in target ? String(target.value ?? "") : ""
      if (valueEquals !== null) conditions.push({ kind: "valueEquals", matched: !!target && value === valueEquals, element: target })
      if (valueIncludes !== null) conditions.push({ kind: "valueIncludes", matched: !!target && value.includes(valueIncludes), element: target })
      if (checked !== null) conditions.push({ kind: "checked", matched: !!target && Boolean(target.checked) === checked, element: target })
    }
    const matched = args.match === "all" ? conditions.every((condition) => condition.matched) : conditions.some((condition) => condition.matched)
    return { matched, conditions }
  }
  for (;;) {
    const result = probe()
    if (result.matched) {
      const hit = result.conditions.find((condition) => condition.matched)
      return {
        found: true,
        matchedBy: args.match === "all" ? "all" : hit?.kind,
        conditions: result.conditions.map((condition) => ({ kind: condition.kind, matched: condition.matched })),
        waitedMs: Date.now() - started,
        element: hit?.element ? describeElement(hit.element) : null,
      }
    }
    // background 的跨导航等待每次只做立即探测，避免把长 Promise 留在即将销毁的旧文档中。
    if (args.probeOnly) {
      return {
        found: false,
        conditions: result.conditions.map((condition) => ({ kind: condition.kind, matched: condition.matched })),
        waitedMs: Date.now() - started,
      }
    }
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

function dispatchKeyboardEvent(element, type, key, init = {}) {
  element.dispatchEvent(
    new KeyboardEvent(type, {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...init,
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
  let out = ""
  const visited = new Set()
  const collect = (root, depth = 0) => {
    if (!root || depth > 15 || out.length >= maxTextLength || visited.has(root)) return
    visited.add(root)
    const treeRoot = root.body || root
    const ownerDocument = treeRoot.ownerDocument || (root.nodeType === Node.DOCUMENT_NODE ? root : document)
    const walker = ownerDocument.createTreeWalker(treeRoot, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue?.replace(/\s+/g, " ").trim()
        if (!text) return NodeFilter.FILTER_REJECT
        return isVisible(node.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })
    while (walker.nextNode() && out.length < maxTextLength) {
      out += `${walker.currentNode.nodeValue.replace(/\s+/g, " ").trim()}\n`
    }
    try {
      for (const element of treeRoot.querySelectorAll("*")) {
        if (element.shadowRoot) collect(element.shadowRoot, depth + 1)
        if (out.length >= maxTextLength) break
      }
      for (const frame of out.length >= maxTextLength ? [] : treeRoot.querySelectorAll("iframe,frame")) {
        try {
          if (frame.contentDocument) collect(frame.contentDocument, depth + 1)
        } catch { /* cross-origin */ }
      }
    } catch { /* ignore */ }
  }
  collect(document)
  return out.slice(0, maxTextLength)
}

function getPageOverview() {
  const visibleButtons = queryAllDeep("button,input[type=button],input[type=submit]")
    .filter(isVisible)
    .slice(0, 20)
    .map((element) => compactText(element.innerText || element.value || element.getAttribute("aria-label") || ""))
    .filter(Boolean)
  const visibleInputs = queryAllDeep("input,textarea,select,[contenteditable=true]")
    .filter(isVisible)
    .slice(0, 20)
    .map((element) => ({
      type: element.type || element.tagName.toLowerCase(),
      name: element.getAttribute("name"),
      placeholder: element.getAttribute("placeholder"),
      label: findLabel(element),
    }))
  return {
    heading: compactText(queryAllDeep("h1,h2,h3,[role=heading]").find(isVisible)?.innerText || ""),
    path: location.hash || location.pathname,
    counts: {
      forms: queryAllDeep("form").filter(isVisible).length,
      buttons: queryAllDeep("button,input[type=button],input[type=submit]").filter(isVisible).length,
      links: queryAllDeep("a[href]").filter(isVisible).length,
      inputs: queryAllDeep("input,textarea,select,[contenteditable=true]").filter(isVisible).length,
      tables: queryAllDeep("table").filter(isVisible).length,
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
  const styleWindow = element.ownerDocument?.defaultView || window
  const style = styleWindow.getComputedStyle(element)
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false
  }
  const rect = element.getBoundingClientRect()
  if (!(rect.width > 0 && rect.height > 0)) return false
  try {
    const frameElement = element.ownerDocument?.defaultView?.frameElement
    if (frameElement && !isVisible(frameElement)) return false
  } catch {
    /* cross-origin elements are never directly reached here */
  }
  return true
}

function getContextParent(element) {
  if (!element) return null
  if (element.parentElement) return element.parentElement
  const root = element.getRootNode?.()
  if (root?.host) return root.host
  try {
    return element.ownerDocument?.defaultView?.frameElement || null
  } catch {
    return null
  }
}

function getTopViewportRect(element) {
  const rect = element.getBoundingClientRect()
  let x = rect.x
  let y = rect.y
  let currentWindow = element.ownerDocument?.defaultView
  let guard = 0
  while (currentWindow && currentWindow !== currentWindow.top && guard++ < 12) {
    try {
      const frame = currentWindow.frameElement
      if (!frame) break
      const frameRect = frame.getBoundingClientRect()
      x += frameRect.x + (frame.clientLeft || 0)
      y += frameRect.y + (frame.clientTop || 0)
      currentWindow = frame.ownerDocument?.defaultView
    } catch {
      break
    }
  }
  return { x, y, width: rect.width, height: rect.height }
}

function getFrameChain(element) {
  const chain = []
  let currentWindow = element.ownerDocument?.defaultView
  let guard = 0
  while (currentWindow && currentWindow !== currentWindow.top && guard++ < 12) {
    try {
      const frame = currentWindow.frameElement
      if (!frame) break
      chain.unshift({
        selector: cssPath(frame),
        name: frame.getAttribute("name") || null,
        src: frame.getAttribute("src") || null,
      })
      currentWindow = frame.ownerDocument?.defaultView
    } catch {
      break
    }
  }
  return chain
}

function getShadowPath(element) {
  const path = []
  let current = element
  let guard = 0
  while (current && guard++ < 12) {
    const root = current.getRootNode?.()
    if (!root?.host) break
    path.unshift({ tag: root.host.tagName.toLowerCase(), selector: cssPath(root.host) })
    current = root.host
  }
  return path
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
