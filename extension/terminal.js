// 终端初始化：xterm.js + FitAddon，桥接到 background 的 native 端口。
// terminal.bundle.js（经典脚本）先加载，暴露 window.Terminal / window.FitAddon / window.WebglAddon /
// window.SearchAddon / window.WebLinksAddon / window.ClipboardAddon。

export function initTerminal({ hostEl, send, fontSize: initialFontSize, scrollback: initialScrollback, onFontSizeChange, onTitleChange }) {
  let fontSize = Number(initialFontSize) >= 8 && Number(initialFontSize) <= 28 ? Math.round(Number(initialFontSize)) : 12
  const normalizeScrollback = (value) => Math.max(1000, Math.min(50000, Math.round(Number(value) || 5000)))
  const term = new window.Terminal({
    cursorBlink: false, // 关闭光标闪烁——codex/TUI 会发 ?12h 启用闪烁，下面 writeBatch 里每次都追加 ?12l 强制覆盖
    fontFamily: "Cascadia Mono, Consolas, 'Microsoft YaHei', monospace",
    fontSize,
    scrollback: normalizeScrollback(initialScrollback),
    smoothScrollDuration: 0,
    scrollSensitivity: 3, // 滚轮滚动幅度（默认 1 偏慢；3 更跟手、少滚轮圈数）
    fastScrollSensitivity: 8, // 按住 Alt + 滚轮时大幅翻页
    fastScrollModifier: "alt",
  })
  const fit = new window.FitAddon()
  term.loadAddon(fit)
  term.open(hostEl)
  hostEl.__omeetyTerm = term // 调试/测试钩子：可从外部查 hasSelection()/getSelection()

  // ================= 光标稳定器 =================
  // 解决的问题：Codex/claude 这类 TUI 一次界面刷新会输出大量光标寻址序列（CUP/HVP 等），
  // 且一次刷新常拆成多个 synchronized output（?2026h/l）块。xterm 会在块间把"中间坐标"
  // （Working/状态栏行尾）画出来一帧甚至几百 ms；Windows 输入法候选框的锚点（隐藏 textarea 的
  // DOM 坐标）也随这些中间坐标跳。上一版守卫失败在两个根因：
  //   ① "已提交坐标"没有有效性标准——任何坐标静默 80~150ms 就被提交，重绘中间坐标常态性达标；
  //      且 500ms interactive 窗口让后台重绘坐标搭上用户输入的快车被误提交。
  //   ② 只包装了 CompositionHelper.updateCompositionElements，漏了
  //      CoreBrowserTerminal._syncTextArea（每次 cursor move 都会重定位 textarea）——
  //      真实 Windows IME 在 composition 之外就读这个锚点，所以真实输入法照样跳。
  //
  // 本方案的核心是按"输出结构"区分两类光标移动，而不是时间窗口：
  //   A. 回显类：整批输出不含光标寻址 CSI（可打印字符/BS/CR/LF），或从已提交位置出发的
  //      同行小幅相对移动（readline 方向键回显 \x1b[C/\x1b[D）→ write 回调里立即提交，零延迟。
  //   B. 重绘类：含绝对寻址/大跳的 CSI → 事务期间把"呈现层"钉在已提交坐标，
  //      直到输出静默才把当时位置提交为新的稳定坐标——一次布局完成后光标最多移动一次。
  // 静默窗口分两档：用户刚输入过（500ms 内）用 32ms（>1 帧、打字跟手无感，覆盖
  // Codex 里"按键→TUI 重绘输入行"的链路）；纯后台输出用 150ms（相邻重绘块间隔通常 <100ms，
  // 跨块中间坐标到不了提交线）。
  // 钉住只发生在呈现层（同步 swap，见下），真实 buffer 从不被改写。
  const CURSOR_SETTLE_INTERACTIVE_MS = 32  // 交互模式（用户刚输入）。codex 一次按键的回显会拆成多段 output（多段 CUP 重绘输入行/状态栏），
  // cgArmSettle 每段都会 clearTimeout+重设定时器——只要 settle 时长 > 单次按键所有 chunk 的到达跨度，
  // 多段就被串进同一个 pin 窗口、只在输出真正静默后提交一次"最终坐标"，cursor 最多旧位→新位移动一次。
  // ❌ 曾误改成 0：每段各自的 setTimeout(0) 在下一段到达前就 fire 并 commit 该段的中间坐标，
  // cursor 在每个中间坐标上都渲染一帧 = 输入/回退时"频闪几下"。32ms 覆盖典型按键（codex chunk 间隔 <10ms）。
  const CURSOR_SETTLE_IDLE_MS = 150       // 后台输出：150ms，codex 多块重绘的中间坐标到不了提交线
  const cgSettleDelay = () => (performance.now() < interactiveUntil ? CURSOR_SETTLE_INTERACTIVE_MS : CURSOR_SETTLE_IDLE_MS)
  let cgCommittedX = term.buffer.active.cursorX
  let cgCommittedY = term.buffer.active.cursorY
  let cgSettleTimer = 0 // 非 0 = 有重绘事务未决（钉住中）
  let cgWritesInFlight = 0
  let cgUnsafeChunk = false // 当前 write 块是否含重绘类光标移动
  const cgBuffer = () => term?._core?._bufferService?.buffer
  const isSynchronizedOutput = () => Boolean(term?._core?.coreService?.decPrivateModes?.synchronizedOutput)
  // 钉住条件：有未决重绘（settle 计时中）/ 有写入在解析 / 处于 synchronized output 事务
  const cgPinned = () => cgSettleTimer !== 0 || cgWritesInFlight > 0 || isSynchronizedOutput()
  const cgClampX = (x) => Math.max(0, Math.min(term.cols - 1, x))
  const cgClampY = (y) => Math.max(0, Math.min(term.rows - 1, y))
  hostEl.dataset.omeetyCursorCommitted = `${cgCommittedX},${cgCommittedY}`
  hostEl.dataset.omeetyCursorPinned = "false"

  const refreshCursorRows = (prevY, nextY) => {
    const lastRow = Math.max(0, term.rows - 1)
    const start = Math.max(0, Math.min(lastRow, prevY, nextY))
    const end = Math.max(0, Math.min(lastRow, Math.max(prevY, nextY)))
    term.refresh(start, end)
  }

  // renderService.handleCursorMove 的原版引用；提交后补一次（blink 相位重置 + link layer）
  let cgForwardCursorMove = () => {}
  let cgForwardTextArea = () => {}
  function cgCommit() {
    const b = cgBuffer()
    if (!b) return
    const previousX = cgCommittedX
    const previousY = cgCommittedY
    cgCommittedX = b.x
    cgCommittedY = b.y
    const committedX = b.x
    const committedY = b.y
    hostEl.dataset.omeetyCursorCommitted = `${b.x},${b.y}`
    // 延迟到 rAF 里调 handleCursorMove，和 xterm 渲染循环对齐（避免 commit 时立即触发
    // 一次 cursor 层渲染，和 rAF 主渲染产生双渲染 → 输入/回退时 cursor 频闪）。
    requestAnimationFrame(() => {
      if (_disposed || cgSettleTimer !== 0) return
      cgForwardCursorMove()
      cgForwardTextArea()
      // During pinning, WebGL rendered the committed cursor and xterm's normal
      // cursor-move callbacks were deliberately swallowed. Once the transaction
      // settles, explicitly repaint both the old and final rows so the GPU model
      // drops the old cursor and commits the final one in the same frame.
      if (previousX !== committedX || previousY !== committedY) refreshCursorRows(previousY, committedY)
    })
  }
  function cgArmSettle(ms) {
    if (cgSettleTimer) clearTimeout(cgSettleTimer)
    hostEl.dataset.omeetyCursorPinned = "true"
    cgSettleTimer = setTimeout(() => {
      cgSettleTimer = 0
      if (_disposed) return
      // 事务还没完（新块在解析 / sync 未关）→ 继续等，不能提交中间坐标
      if (cgWritesInFlight > 0 || isSynchronizedOutput()) {
        cgArmSettle(16)
        return
      }
      hostEl.dataset.omeetyCursorPinned = "false"
      cgCommit()
    }, ms)
  }

  // —— 分类器：解析期观察（return false = 不消费，默认处理照常）——
  // 重绘类 CSI：绝对寻址与大幅度移动。C/D（左右相对移动）单独判：从已提交位置出发的
  // 同行小步移动视为回显（readline 光标键），否则算重绘。
  try {
    const UNSAFE_FINALS = ["H", "f", "A", "B", "E", "F", "G", "`", "d", "r"]
    for (const final of UNSAFE_FINALS) {
      term.parser.registerCsiHandler({ final }, () => {
        cgUnsafeChunk = true
        return false
      })
    }
    for (const final of ["C", "D"]) {
      term.parser.registerCsiHandler({ final }, (params) => {
        const b = cgBuffer()
        const first = Array.isArray(params?.[0]) ? params[0][0] : params?.[0]
        const n = Number(first) || 1
        const echoLike = b && b.x === cgCommittedX && b.y === cgCommittedY && n <= 8
        if (!echoLike) cgUnsafeChunk = true
        return false
      })
    }
    // ?2026l：sync 事务的子边界。整段刷新可能拆多段，不立即提交，统一进静默窗口。
    term.parser.registerCsiHandler({ final: "l", prefix: "?" }, (params) => {
      const flat = Array.isArray(params) ? params.flatMap((p) => (Array.isArray(p) ? p : [p])) : []
      if (flat.includes(2026)) cgArmSettle(cgSettleDelay())
      return false
    })
  } catch (e) {
    console.warn("[omeety] 光标分类器注册失败：", e)
  }

  // —— 呈现层钉住 ①：RenderService.handleCursorMove 钉住期间吞掉（WebGL 只动 link/blink；
  // DOM 本就是 no-op），提交时统一补发 ——
  try {
    const renderService = term?._core?._renderService
    const originalHandleCursorMove = renderService?.handleCursorMove?.bind(renderService)
    if (renderService && originalHandleCursorMove) {
      cgForwardCursorMove = () => {
        try { originalHandleCursorMove() } catch { /* ignore */ }
      }
      renderService.handleCursorMove = () => {
        if (!cgPinned()) originalHandleCursorMove()
      }
    }
  } catch (e) {
    console.warn("[omeety] handleCursorMove 守卫安装失败：", e)
  }

  // —— 呈现层钉住 ②：renderer.renderRows。WebGL 的 cursor model 和 DOM 的 cursor span 都在
  // renderRows 内同步读取 buffer.x/y，所以用同步 swap（try/finally 包裹的纯同步调用，JS 单线程
  // 不存在交错；GPU 上传读的是已生成的 model，不回头读 buffer）。比事后改 model 更精确：
  // 单元格反色、双宽光标等细节完全按 xterm 原生逻辑渲染。committed 行并入本帧避免部分行刷新丢光标。
  const cgWrapRenderRows = () => {
    try {
      const renderer = term?._core?._renderService?._renderer?.value
      if (!renderer || renderer.__omeetyCursorWrapped || typeof renderer.renderRows !== "function") return
      const originalRenderRows = renderer.renderRows.bind(renderer)
      renderer.renderRows = (start, end) => {
        const b = cgBuffer()
        if (!b || !cgPinned()) {
          originalRenderRows(start, end)
          return
        }
        const actualX = b.x
        const actualY = b.y
        const pinnedY = cgClampY(cgCommittedY)
        b.x = cgClampX(cgCommittedX)
        b.y = pinnedY
        try {
          originalRenderRows(Math.min(start, pinnedY), Math.max(end, pinnedY))
        } finally {
          b.x = actualX
          b.y = actualY
        }
      }
      renderer.__omeetyCursorWrapped = true
      hostEl.dataset.omeetyCursorGuard = "stabilizer-v2"
    } catch (e) {
      console.warn("[omeety] renderRows 守卫安装失败：", e)
    }
  }
  cgWrapRenderRows() // term.open 时的初始 DOM renderer；WebGL 加载后再包一次（见下）

  // —— 呈现层钉住 ③：IME 锚点路径 A —— CompositionHelper.updateCompositionElements
  // （composition 进行中，候选框/预编辑视图定位）。同样的同步 swap，同步函数无交错风险。
  try {
    const compositionHelper = term?._core?._compositionHelper
    const originalUpdateCompositionElements = compositionHelper?.updateCompositionElements?.bind(compositionHelper)
    if (compositionHelper && originalUpdateCompositionElements) {
      compositionHelper.updateCompositionElements = (dontRecurse) => {
        const b = cgBuffer()
        if (!b || !cgPinned()) return originalUpdateCompositionElements(dontRecurse)
        const actualX = b.x
        const actualY = b.y
        b.x = cgClampX(cgCommittedX)
        b.y = cgClampY(cgCommittedY)
        try {
          return originalUpdateCompositionElements(dontRecurse)
        } finally {
          b.x = actualX
          b.y = actualY
        }
      }
    }
  } catch (e) {
    console.warn("[omeety] IME composition 锚点守卫安装失败：", e)
  }

  // —— 呈现层钉住 ④：IME 锚点路径 B —— CoreBrowserTerminal._syncTextArea
  // （composition 之外，每次 cursor move 都会把隐藏 textarea 锚到 live 坐标——真实 Windows IME
  // 的 TSF 定位链路读的就是它，上一版漏了这里，所以真实输入法照样跳）。钉住期间改用已提交坐标
  // 重实现（逻辑照抄 xterm 源码，仅替换坐标来源）。
  try {
    const coreTerm = term?._core
    if (coreTerm && typeof coreTerm._syncTextArea === "function") {
      const originalSyncTextArea = coreTerm._syncTextArea.bind(coreTerm) // 覆盖前先存原型方法
      cgForwardTextArea = () => {
        try { originalSyncTextArea() } catch { /* ignore */ }
      }
      coreTerm._syncTextArea = function () {
        if (!cgPinned()) {
          // 未钉住：走原生实现（此时 committed 与 live 一致，行为与原版相同）
          return originalSyncTextArea()
        }
        const b = this.buffer
        if (!this.textarea || !b.isCursorInViewport || this._compositionHelper?.isComposing || !this._renderService) return
        const bufferLine = b.lines.get(b.ybase + cgCommittedY)
        if (!bufferLine) return
        const cursorX = cgClampX(cgCommittedX)
        const dims = this._renderService.dimensions.css.cell
        const cellWidth = dims.width * bufferLine.getWidth(cursorX)
        this.textarea.style.left = cursorX * dims.width + "px"
        this.textarea.style.top = cgCommittedY * dims.height + "px"
        this.textarea.style.width = cellWidth + "px"
        this.textarea.style.height = dims.height + "px"
        this.textarea.style.lineHeight = dims.height + "px"
        this.textarea.style.zIndex = "-5"
      }
    }
  } catch (e) {
    console.warn("[omeety] _syncTextArea 锚点守卫安装失败：", e)
  }

  // 同一时刻只给活动 tab 保留 WebGL 上下文。非活动 tab 继续解析 PTY 输出、维护完整
  // buffer，但释放 GPU renderer；切回时再恢复 WebGL。这样多 tab 不会按 tab 数累积纹理/
  // canvas 显存，也不影响后台 CLI Agent 持续运行。
  let webglAddon = null
  let renderActive = true
  hostEl.dataset.omeetyRenderer = "dom"
  function enableWebgl() {
    if (webglAddon || !renderActive || !window.WebglAddon) return
    try {
      webglAddon = new window.WebglAddon()
      term.loadAddon(webglAddon)
      hostEl.dataset.omeetyRenderer = "webgl"
      cgWrapRenderRows()
    } catch (e) {
      webglAddon = null
      hostEl.dataset.omeetyRenderer = "dom-fallback"
      console.warn("[omeety] WebGL 渲染器加载失败，退回 DOM：", e)
    }
  }
  function disableWebgl() {
    if (webglAddon) {
      try { webglAddon.dispose() } catch { /* ignore */ }
      webglAddon = null
    }
    hostEl.dataset.omeetyRenderer = renderActive ? "dom-fallback" : "suspended"
  }
  enableWebgl()

  // 终端内搜索：Ctrl+F 唤起搜索条（见下方 searchBar）
  let search = null
  try {
    if (window.SearchAddon) {
      search = new window.SearchAddon()
      term.loadAddon(search)
    }
  } catch (e) {
    console.warn("[omeety] SearchAddon 加载失败：", e)
  }

  // Ctrl+点击终端里的 URL → 浏览器新标签页打开（不抢当前页）
  try {
    if (window.WebLinksAddon) {
      term.loadAddon(
        new window.WebLinksAddon((_e, uri) => {
          try {
            chrome.tabs.create({ url: uri, active: false })
          } catch {
            window.open(uri)
          }
        })
      )
    }
  } catch (e) {
    console.warn("[omeety] WebLinksAddon 加载失败：", e)
  }

  // OSC52：让 shell 里的程序（claude code 的 /copy、tmux、vim 等）直接写系统剪贴板
  try {
    if (window.ClipboardAddon) term.loadAddon(new window.ClipboardAddon())
  } catch (e) {
    console.warn("[omeety] ClipboardAddon 加载失败：", e)
  }

  // OSC 0/2 标题序列（cmd 的 title 命令、PowerShell $Host.UI.RawUI.WindowTitle、bash PROMPT_COMMAND）
  // → 更新侧栏 tab 标题，像 Windows Terminal 那样一眼看出每个 tab 在跑什么。
  try {
    term.onTitleChange((t) => {
      const clean = String(t || "").trim().slice(0, 30)
      if (clean) onTitleChange?.(clean)
    })
  } catch {
    /* 老版本 xterm 无此 API */
  }

  // 动态缩放：Ctrl+滚轮即时改字号；改 term.options.fontSize 后 fit 重排行列数。
  function setFontSize(next) {
    const prev = fontSize
    fontSize = Math.max(8, Math.min(28, Math.round(next)))
    if (fontSize === prev) return
    term.options.fontSize = fontSize
    try { fit.fit() } catch { /* ignore */ }
    onFontSizeChange?.(fontSize) // 持久化（sidepanel 防抖写 storage）
  }
  hostEl.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    setFontSize(fontSize + (e.deltaY < 0 ? 1 : -1))
  }, { capture: true, passive: false })

  // 用户输入回显的低延迟通道：只决定 write 是否立即冲刷（跳过一次 rAF 批处理）。
  // 注意：不再参与光标提交判断——回显/重绘的分类完全由输出结构（有无寻址 CSI）决定。
  let interactiveUntil = 0
  const markInteractive = () => {
    interactiveUntil = performance.now() + 500
  }
  // per-tab "codex 标点兼容"：把 ConPTY 会丢的那批中文标点（U+2000-206F 通用标点：弯引号、
  // 破折号、省略号——经 ConPTY 的 key-event 合成被 codex 这类 crossterm TUI 丢弃）转成 ASCII
  // 等价物，让 codex 能正常收。claude/kimi 不需要（它们读文本流，不经过有 bug 的 key-event 路径）。
  // 由 sidepanel 的 tab 右键菜单按 tab 开关（默认关）。
  let punctCompat = false
  const PUNCT_COMPAT = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "--", "…": "..." }
  const PUNCT_COMPAT_RE = /[‘’“”–—…]/g
  const convertPunct = (s) => s.replace(PUNCT_COMPAT_RE, (c) => PUNCT_COMPAT[c] || c)
  term.onData((d) => {
    if (punctCompat) d = convertPunct(d)
    markInteractive()
    send({ type: "input", data: d })
  })

  // ---- 复制 / 粘贴 / 换行 ----
  // 复制：选中即自动复制（mouseup）；也可 Ctrl+Shift+C / Ctrl+Insert。
  // 粘贴：Ctrl+V / Ctrl+Shift+V / Cmd+V / Shift+Insert；或右键。
  //   注意：不能放任 xterm 处理 Ctrl+V——它会把 ^V(0x16) 当“字面量下一字符”发给 PTY，和粘贴内容混在一起。
  //   所以这里一律拦截这些键、自己读剪贴板、return false 让 xterm 跳过默认处理。
  // 所有入口统一交给 xterm 的 paste()：它会按终端当前的 2004 模式生成一个完整的
  // bracketed-paste 事件，并统一换行。Codex 只有收到 Paste 事件，才会把超过阈值的长文本
  // 折叠成 [Pasted Content … chars]；直接向 PTY 写普通文本虽然内容相同，却会被当成逐字输入。
  const sendPaste = (t) => {
    if (!t) return
    term.paste(t)
  }
  const clipWrite = (t) => {
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(t)
    } catch {
      /* ignore */
    }
  }
  const clipRead = async () => {
    try {
      return (await navigator.clipboard.readText()) || ""
    } catch {
      return ""
    }
  }
  let lastPasteAt = 0 // 粘贴防抖：避免按住/连按 Ctrl+V 一次粘多遍

  // 复制成功的可视反馈：终端右上角闪一个"已复制 ✓"小标，1s 后消失
  let copiedBadge = null
  function flashCopied() {
    if (!copiedBadge) {
      copiedBadge = document.createElement("div")
      copiedBadge.className = "omeety-copied-badge"
      copiedBadge.textContent = "已复制 ✓"
      hostEl.appendChild(copiedBadge)
    }
    copiedBadge.classList.add("show")
    clearTimeout(flashCopied._t)
    flashCopied._t = setTimeout(() => copiedBadge.classList.remove("show"), 1000)
  }

  // ---- 终端内搜索条（Ctrl+F）----
  const searchBar = document.createElement("div")
  searchBar.className = "omeety-search"
  searchBar.hidden = true
  searchBar.innerHTML =
    '<input type="text" placeholder="搜索终端输出…" />' +
    '<button type="button" data-act="prev" title="上一个 (Shift+Enter)">↑</button>' +
    '<button type="button" data-act="next" title="下一个 (Enter)">↓</button>' +
    '<button type="button" data-act="close" title="关闭 (Esc)">×</button>'
  hostEl.appendChild(searchBar)
  const searchInput = searchBar.querySelector("input")
  const SEARCH_OPTS = {
    decorations: {
      matchBackground: "#4b5563",
      activeMatchBackground: "#d97706",
      matchOverviewRuler: "#9ca3af",
      activeMatchColorOverviewRuler: "#f59e0b",
    },
  }
  function openSearch() {
    if (!search) return
    searchBar.hidden = false
    const sel = term.getSelection()
    if (sel && !searchInput.value) searchInput.value = sel.split("\n")[0].slice(0, 80)
    searchInput.focus()
    searchInput.select()
  }
  function closeSearch() {
    searchBar.hidden = true
    try { search?.clearDecorations() } catch { /* ignore */ }
    term.focus()
  }
  searchInput.addEventListener("input", () => {
    try { search?.findNext(searchInput.value, { ...SEARCH_OPTS, incremental: true }) } catch { /* ignore */ }
  })
  searchInput.addEventListener("keydown", (e) => {
    // 焦点在搜索框时再按 Ctrl+F：重新聚焦+全选（xterm 的 Ctrl+F handler 此时收不到，否则会走浏览器默认查找）。
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyF") {
      e.preventDefault()
      searchInput.focus()
      searchInput.select()
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      const q = searchInput.value
      if (!q) return
      try {
        if (e.shiftKey) search?.findPrevious(q, SEARCH_OPTS)
        else search?.findNext(q, SEARCH_OPTS)
      } catch { /* ignore */ }
    } else if (e.key === "Escape") {
      e.preventDefault()
      closeSearch()
    }
  })
  searchBar.addEventListener("click", (e) => {
    const act = e.target?.dataset?.act
    const q = searchInput.value
    try {
      if (act === "next" && q) search?.findNext(q, SEARCH_OPTS)
      else if (act === "prev" && q) search?.findPrevious(q, SEARCH_OPTS)
      else if (act === "close") closeSearch()
    } catch { /* ignore */ }
  })

  // —— 中文 IME：标准 229 守卫 + 标点键序列诊断（临时，定位后可删）——
  // 用 Playwright 对 xterm 源码逐一验证（test/ime_test.py）的结论：
  //   · 英文标点（keyCode 222）：xterm keydown 原样交付，单发，无需干预。
  //   · IME 组合（拼音）：compositionend 单发；isComposing 时 return false，避免 xterm 再原样发一次（双发）。
  //   · IME 直接转换（keyCode 229，如部分 IME 的 Shift+"→""）：xterm 的 _inputEvent 单发；
  //     必须 return false 让 _keyDown 在 CompositionHelper._handleAnyTextareaChanges 之前 abort，
  //     否则 _handleAnyTextareaChanges 与 _inputEvent 会双发同一个字符。
  //   · 光标稳定器的 textarea 重定位经验证不影响 IME 交付。
  //   => 最稳的就是 return false（=最初的守卫）。之前 return true / 手动调 _handleAnyTextareaChanges 都会双发。
  // 若你的 IME 仍打不出中文标点，多半是它对这些键不发 229——按一次 Shift+"，把控制台 [omeety-ime] 那行发我。
  const IME_PUNCT_CODES = new Set(["Quote", "BracketLeft", "BracketRight", "Backslash", "Semicolon"])
  // 诊断：标点键 keydown 后开 500ms 窗口，捕获后续 composition/input 事件，拼成一行打印
  const _diagTa = term.element?.querySelector(".xterm-helper-textarea")
  let _diagArmed = false
  const _diagSeq = []
  if (_diagTa) {
    _diagTa.addEventListener("compositionstart", () => { if (_diagArmed) _diagSeq.push("compositionstart") })
    _diagTa.addEventListener("compositionupdate", (ev) => { if (_diagArmed) _diagSeq.push("compositionupdate:" + JSON.stringify(ev.data)) })
    _diagTa.addEventListener("compositionend", (ev) => { if (_diagArmed) _diagSeq.push("compositionend:" + JSON.stringify(ev.data)) })
    _diagTa.addEventListener("input", (ev) => { if (_diagArmed) _diagSeq.push("input:data=" + JSON.stringify(ev.data) + " type=" + ev.inputType + " composed=" + ev.composed) })
  }

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true

    // 诊断：标点键签名 + 后续事件序列
    if (!e.ctrlKey && !e.altKey && !e.metaKey && IME_PUNCT_CODES.has(e.code)) {
      _diagSeq.length = 0
      _diagArmed = true
      _diagSeq.push("keydown:code=" + e.code + " keyCode=" + e.keyCode + " isComposing=" + e.isComposing + " key=" + JSON.stringify(e.key))
      setTimeout(() => { _diagArmed = false; console.log("[omeety-ime]", _diagSeq.join(" | ")) }, 500)
    }

    if (e.isComposing || e.keyCode === 229) return false


    // tab 快捷键 Ctrl+Alt+T/W/←/→ 由 sidepanel 在 document 层处理；这里拦截防止 xterm 把它当普通键发进 PTY
    // （尤其 Ctrl+Alt+←/→ 在 readline 是"按词跳"，会意外移动光标）。
    if (e.ctrlKey && e.altKey && (e.code === "KeyT" || e.code === "KeyW" || e.code === "ArrowLeft" || e.code === "ArrowRight")) {
      return false
    }

    // Ctrl+F：终端内搜索（拦截浏览器/扩展页默认的页内查找）
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyF") {
      e.preventDefault()
      openSearch()
      return false
    }

    // Ctrl+C：有选区→复制（Windows Terminal/conhost 习惯，不发 ^C 中断）；无选区→放行发 ^C
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC") {
      const sel = term.getSelection()
      if (sel) {
        clipWrite(sel)
        flashCopied()
        return false // 拦截，不发 ^C
      }
      return true // 无选区 → 正常发 ^C（中断）
    }

    // 复制：Ctrl+Shift+C / Ctrl+Insert
    const isCopy =
      (e.ctrlKey && e.shiftKey && (e.code === "KeyC" || (e.key || "").toLowerCase() === "c")) ||
      (e.ctrlKey && !e.shiftKey && e.code === "Insert")
    if (isCopy) {
      const sel = term.getSelection()
      if (sel) {
        clipWrite(sel)
        flashCopied()
      }
      return false
    }

    // 粘贴：Ctrl+V / Ctrl+Shift+V / Cmd+V / Shift+Insert
    const isPaste =
      ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyV") ||
      (e.shiftKey && !e.ctrlKey && !e.altKey && e.code === "Insert")
    if (isPaste) {
      if (e.repeat) return false // 按住自动重复不重复粘贴
      const now = Date.now()
      if (now - lastPasteAt < 350) {
        e.preventDefault()
        return false // 防抖：350ms 内不重复粘贴
      }
      lastPasteAt = now
      // 显式阻止浏览器原生 paste 事件——否则 xterm 的 paste 监听会再触发一次 onData，导致重复粘贴
      e.preventDefault()
      e.stopPropagation()
      clipRead().then(sendPaste)
      return false
    }

    // 换行：Codex 在 Windows 上把 CSI-u 的 modified Enter 当成文本 "[13;2u"。
    // 不手工向 PTY 注入 LF/粘贴序列，而是在 xterm textarea 上重放一次完整 Ctrl+J，
    // 让 xterm 走与用户物理按 Ctrl+J 完全相同的键盘解析和 onData 路径。
    const isEnterKey =
      e.code === "Enter" ||
      e.code === "NumpadEnter" ||
      e.key === "Enter" ||
      e.keyCode === 13
    if (isEnterKey && (e.shiftKey || e.ctrlKey)) {
      e.preventDefault()
      const textarea = term.element?.querySelector(".xterm-helper-textarea")
      setTimeout(() => {
        if (!textarea) {
          send({ type: "input", data: "\x0a" })
          return
        }
        const dispatchCtrlJ = (type) => {
          const event = new KeyboardEvent(type, {
            key: "j",
            code: "KeyJ",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          })
          // Chromium ignores keyCode/which passed to the constructor, while xterm keeps
          // compatibility branches that read them. Expose the same values as a real J key.
          try { Object.defineProperty(event, "keyCode", { get: () => 74 }) } catch { /* ignore */ }
          try { Object.defineProperty(event, "which", { get: () => 74 }) } catch { /* ignore */ }
          textarea.dispatchEvent(event)
        }
        dispatchCtrlJ("keydown")
        dispatchCtrlJ("keyup")
      }, 0)
      return false
    }

    // 缩放快捷键：Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 复位(12)
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === "Equal" || e.code === "NumpadAdd" || e.code === "Minus" || e.code === "NumpadSubtract" || e.code === "Digit0" || e.code === "Numpad0")) {
      e.preventDefault()
      if (e.code === "Digit0" || e.code === "Numpad0") setFontSize(12)
      else if (e.code === "Minus" || e.code === "NumpadSubtract") setFontSize(fontSize - 1)
      else setFontSize(fontSize + 1)
      return false
    }

    return true
  })

  // 选中不自动复制——只有 Ctrl+C（见上方 attachCustomKeyEventHandler）才复制。
  // 鼠标选中只是普通的高亮选中，不打扰剪贴板内容。

  // 右键 = 有选中→复制；无选中→粘贴（Windows Terminal 风格）。
  // 不用"始终粘贴"——选中即复制会把屏幕上的文本写进剪贴板，右键再粘贴会把旧剪贴板内容灌进输入框，容易出乱。
  hostEl.addEventListener("contextmenu", async (ev) => {
    ev.preventDefault()
    const sel = term.getSelection()
    if (sel) {
      clipWrite(sel)
      return
    }
    const t = await clipRead()
    if (t) sendPaste(t)
  })

  // 去重：xterm 尺寸真变了才通知 host
  let lastCols = 0,
    lastRows = 0
  term.onResize(({ cols, rows }) => {
    if (cols !== lastCols || rows !== lastRows) {
      lastCols = cols
      lastRows = rows
      send({ type: "resize", cols, rows })
    }
  })

  // 只在“容器像素尺寸真的变了”时才 fit()。
  // xterm 重渲染 / 滚动条出现消失会反复触发 ResizeObserver，但容器（hostEl）像素尺寸其实没变 ——
  // 这种是测量噪声，跳过即可彻底打断 fit↔ResizeObserver 的抖动循环（尺寸在 N/N±2 间来回跳）。
  let lastW = 0,
    lastH = 0
  function applyFit() {
    const w = hostEl.clientWidth,
      h = hostEl.clientHeight
    if (!w || !h) return
    if (w === lastW && h === lastH) return
    lastW = w
    lastH = h
    try {
      fit.fit()
    } catch {
      /* ignore */
    }
  }

  applyFit()
  // 面板刚打开时 hostEl 可能还没布局完（尺寸 0 被 applyFit 跳过），下一帧再补一次。
  // CSS 已让容器尺寸稳定，不会重新引发震荡。
  requestAnimationFrame(() => applyFit())
  requestAnimationFrame(() => requestAnimationFrame(() => applyFit()))

  // write 批量化：一帧(rAF)内多条 output 合并成一次 term.write。高频输出(claude 启动瀑布/工具输出)
  // 时原本每条都同步触发 xterm 渲染调度、抢占主线程 → 滚动掉帧 + 输入框响应延迟；合并后调度次数大降。
  let _pending = ""
  let _scheduled = false
  let _rafId = 0
  let _coalesceT = 0
  let _disposed = false
  const writeBatch = (batch) => {
    if (_disposed || !batch) return
    cgWritesInFlight++
    cgUnsafeChunk = false // 分类器在解析期间置位
    term.write(batch, () => {
      // 强制禁用光标闪烁——直接改 xterm 内部属性，不发额外 write（避免多一次解析+渲染）。
      // codex 会发 ?12h 启用闪烁，这里在解析完成后、渲染前直接把 cursorBlink 拉回 false。
      try {
        const dm = term?._core?.coreService?.decPrivateModes
        if (dm) dm.cursorBlink = false
      } catch { /* ignore */ }
      cgWritesInFlight = Math.max(0, cgWritesInFlight - 1)
      if (_disposed) return
      // 交互期（用户刚输入，且 write 已被合并成一次）：parse 后 cursor 已在最终位，立即同步提交
      // committed=final，下一帧渲染直接画最终位——不再 pin 在旧坐标干等 settle → 输入/回退跟手、无滞后。
      // （合并写入是前提：单次 write 的 parse 同步进行、cursor 一次性落到最终位，无中间坐标可提交。）
      // 后台输出（codex 思考中的多块重绘）仍走 settle 批量提交，避免后台重绘中间坐标跳动。
      if (performance.now() < interactiveUntil || !cgUnsafeChunk) {
        cgCommit()
      } else {
        cgArmSettle(cgSettleDelay())
      }
    })
  }
  // 统一冲刷：把 _pending 里攒下的所有 chunk 合并成一次 term.write 交给 xterm。
  const _flush = () => {
    _rafId = 0
    _coalesceT = 0
    _scheduled = false
    if (_disposed) { _pending = ""; return }
    const batch = _pending
    _pending = ""
    writeBatch(batch)
  }
  return {
    term,
    write(d) {
      if (_disposed) return
      _pending += d
      // 每次有新 chunk 到达都重排冲刷（交互/后台两套策略可在一次按键内随 interactiveUntil 切换）。
      if (performance.now() < interactiveUntil) {
        // ★交互期合并（修复 codex 输入/回退 cursor 频闪与乱窜的关键）★
        // codex 一次按键的回显会被 PTY 拆成多段 output（多段 CUP 重绘输入行/状态栏/换行）。
        // 若每段各自 term.write，每段 parse 后 cursor 停在该段"段内最终坐标"（常是中间位，
        // 如"输入行下一行首字"），段间的 rAF 渲染就会把中间坐标画出来 → cursor 在中间位与真最终位
        // 之间来回跳。这里每次有新 chunk 都重置 4ms 定时器，把一次按键的所有段攒成一次 term.write：
        // parse 同步进行，cursor 一次性落到真最终坐标，渲染只画最终位。settle=32 再兜底跨 4ms 的拆段。
        if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0 }
        if (_coalesceT) clearTimeout(_coalesceT)
        _coalesceT = setTimeout(_flush, 4)
        return
      }
      // 后台输出（codex 思考中 / claude 启动瀑布）：rAF 合并，减少渲染调度、不抢主线程。
      if (_coalesceT) { clearTimeout(_coalesceT); _coalesceT = 0 }
      if (!_scheduled) {
        _scheduled = true
        _rafId = requestAnimationFrame(_flush)
      }
    },
    resize: applyFit,
    focus() { if (!_disposed) term.focus() },
    clear() { if (!_disposed) term.clear() },
    reset() {
      if (_disposed) return
      if (_rafId) cancelAnimationFrame(_rafId)
      _rafId = 0
      if (_coalesceT) clearTimeout(_coalesceT)
      _coalesceT = 0
      _scheduled = false
      _pending = ""
      try { term.reset() } catch { term.clear() }
    },
    setActive(active) {
      if (_disposed) return
      renderActive = !!active
      if (renderActive) {
        enableWebgl()
        requestAnimationFrame(() => {
          if (_disposed) return
          applyFit()
          try { term.refresh(0, Math.max(0, term.rows - 1)) } catch { /* ignore */ }
        })
      } else {
        disableWebgl()
      }
    },
    setScrollback(lines) {
      if (_disposed) return
      try { term.options.scrollback = normalizeScrollback(lines) } catch { /* ignore */ }
    },
    // 按 tab 开关"codex 标点兼容"（弯引号等转直引号等价物），见 onData 里 punctCompat。
    setPunctCompat(on) { punctCompat = !!on },
    // 关 tab 时调：取消 pending rAF/定时器（否则会对已 dispose 的 term.write 报错 + 闭包不 GC）+ term.dispose。
    dispose() {
      _disposed = true
      if (cgSettleTimer) clearTimeout(cgSettleTimer)
      cgSettleTimer = 0
      cgWritesInFlight = 0
      if (_rafId) cancelAnimationFrame(_rafId)
      _rafId = 0
      if (_coalesceT) clearTimeout(_coalesceT)
      _coalesceT = 0
      _scheduled = false
      _pending = ""
      disableWebgl()
      try { term.dispose() } catch { /* ignore */ }
    },
  }
}
