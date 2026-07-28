// 浏览器工具的 JSON Schema（镜像 extension/content.js 与 background.js 契约）。MCP inputSchema 用。

const EXPECTATION_SCHEMA = {
  type: "object",
  properties: {
    selector: { type: "string" }, text: { type: "string" },
    selectorGone: { type: "string" }, textGone: { type: "string" },
    urlIncludes: { type: "string" }, titleIncludes: { type: "string" },
    valueEquals: { type: "string" }, valueIncludes: { type: "string" }, checked: { type: "boolean" },
    match: { type: "string", enum: ["all", "any"], default: "all" },
    timeoutMs: { type: "integer", minimum: 500, maximum: 60000 },
  },
}

const TRANSACTION_STEP_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["click", "click_text", "fill", "type", "press", "select", "wait", "reload", "navigate", "evaluate"] },
    uid: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" },
    text: { type: "string" }, value: { type: "string" }, key: { type: "string" }, exact: { type: "boolean" }, clear: { type: "boolean" },
    cdp: { type: "boolean" }, confirmed: { type: "boolean" }, backgroundTask: { type: "boolean" }, verify: { type: "boolean" },
    refocus: { type: "boolean" }, inputMode: { type: "string", enum: ["insertText", "keyEvents"] },
    commitKey: { type: "string", enum: ["Enter", "Tab"] }, clickCount: { type: "integer", minimum: 1, maximum: 3 },
    timeoutMs: { type: "integer", minimum: 500, maximum: 60000 }, settleMs: { type: "integer", minimum: 50, maximum: 5000 },
    expect: EXPECTATION_SCHEMA,
    url: { type: "string" }, bypassCache: { type: "boolean" },
    code: { type: "string" }, world: { type: "string", enum: ["MAIN", "ISOLATED"] },
  },
  required: ["action"],
}

export const TOOLS = [
  {
    name: "omeety_get_page_snapshot",
    description:
      "Capture a snapshot of the current page: url/title/visibleText/overview/topology + interactive[] (stable uid, role, text, bbox, selector, frame/shadow path) + viewport and build metrics. Traverses open Shadow DOM and same-origin iframes. Pass sinceSnapshotId from a previous response to receive an unchanged marker or light-mode delta instead of another full snapshot. Pass uid to click/fill/type/select. Snapshot bbox is in CSS pixels; screenshot pixels may differ by DPR.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["light", "detailed"], default: "light" },
        includeElements: { type: "boolean" },
        maxTextLength: { type: "integer", minimum: 0, maximum: 60000 },
        maxInteractive: { type: "integer", minimum: 1, maximum: 500, default: 120 },
        sinceSnapshotId: { type: "string", description: "Previous snapshotId; light mode returns only changes when the base is still cached" },
      },
    },
  },
  {
    name: "omeety_get_selected_context",
    description: "Return the user's current text selection plus its enclosing element.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "omeety_get_context_bundle",
    description:
      "Build a compact multimodal Context Bundle around uid/selector, the sidebar pick, current text selection, or focused element. Returns accessibility-like identity, safe attributes/value preview, computed styles, ancestors, nearby interactive elements, iframe/Shadow DOM paths, page overview/topology, diagnostics, performance metrics, and by default a cropped element screenshot as a real MCP image content block. This is the preferred 'understand this element' tool.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string" },
        selector: { type: "string" },
        includeScreenshot: { type: "boolean", default: true },
        screenshotPadding: { type: "integer", minimum: 0, maximum: 160, default: 24 },
        screenshotMaxWidth: { type: "integer", minimum: 320, maximum: 1280, default: 900 },
        maxNearbyInteractive: { type: "integer", minimum: 1, maximum: 30, default: 12 },
        attachDebugger: { type: "boolean", description: "Attach CDP to start/read Console diagnostics; may show Chrome's debugging banner" },
        includeAllConsole: { type: "boolean" },
        consoleLimit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
  },
  {
    name: "omeety_fetch_with_cookie",
    description:
      "Fetch a same-origin URL with the page's cookies. Non-GET methods require user consent unless confirmed:true.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string", default: "GET" },
        headers: { type: "object" },
        body: { type: "string" },
        confirmed: { type: "boolean" },
        maxBytes: { type: "integer", minimum: 1024, maximum: 1000000 },
      },
      required: ["url"],
    },
  },
  {
    name: "omeety_apply_preview_patch",
    description: "Apply reversible preview edits to elements; returns patchId for rollback.",
    inputSchema: {
      type: "object",
      properties: {
        patchId: { type: "string" },
        patches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              selector: { type: "string" },
              text: { type: "string" },
              html: { type: "string" },
              value: { type: "string" },
              style: { type: "object" },
              attributes: { type: "object" },
              className: { type: "string" },
              appendHtml: { type: "string" },
              beforeHtml: { type: "string" },
              afterHtml: { type: "string" },
            },
            required: ["selector"],
          },
        },
      },
      required: ["patches"],
    },
  },
  {
    name: "omeety_rollback_preview_patch",
    description: "Roll back one (by patchId) or all preview patches.",
    inputSchema: { type: "object", properties: { patchId: { type: "string" } } },
  },
  {
    name: "omeety_click",
    description: "Click an element by uid (preferred, from snapshot.interactive[].uid) or CSS selector. Dangerous labels auto-trigger a user confirm unless confirmed:true. Optional waitForSelector/waitForText: after clicking, wait across reloads/navigation until the selector/text appears — use after opening a menu or navigating, instead of guessing a sleep. A successful navigation is not misreported as a closed message channel.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string" },
        selector: { type: "string" },
        confirmed: { type: "boolean" },
        waitForSelector: { type: "string", description: "After click, wait until this CSS selector matches a visible element before returning" },
        waitForText: { type: "string", description: "After click, wait until this text appears in the page before returning" },
        waitForTimeoutMs: { type: "integer", minimum: 500, maximum: 60000, default: 5000 },
      },
    },
  },
  {
    name: "omeety_act_and_verify",
    description:
      "Run one verified browser action, or a pinned multi-step transaction in one MCP round trip. Pass tabId so user tab switches cannot redirect the work. Single-action mode supports click/click_text/fill/type/press/select. Transaction mode accepts 1-20 steps and additionally supports wait/reload/navigate/evaluate, stops on the first semantic failure by default, and returns per-step timing/results; always check completed and failedStep. Low-level steps default to no extra verification unless expect/verify is supplied; use evaluate assertions or explicit postconditions for accuracy.",
    inputSchema: {
      // 不能用 anyOf 表达“action/steps 至少传一个”——MCP 协议要求 inputSchema.type 必须为 "object"，
      // 而 Moonshot/Kimi 又要求用了 anyOf 父级就不能有 type，二者冲突无法兼顾。
      // 故去掉 anyOf，靠 description 约束（单步传 action，事务传 steps），三家 API + MCP 都兼容。
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Pin the whole action/transaction to this browser tab even if the user switches tabs" },
        action: { type: "string", enum: ["click", "click_text", "fill", "type", "press", "select"] },
        uid: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" },
        text: { type: "string" }, value: { type: "string" }, key: { type: "string" }, exact: { type: "boolean" }, clear: { type: "boolean" },
        cdp: { type: "boolean" }, confirmed: { type: "boolean" }, backgroundTask: { type: "boolean" },
        refocus: { type: "boolean", description: "Set false to keep the current focused editor instead of clicking uid/selector/x,y again" },
        inputMode: { type: "string", enum: ["insertText", "keyEvents"] },
        commitKey: { type: "string", enum: ["Enter", "Tab"] },
        clickCount: { type: "integer", minimum: 1, maximum: 3 },
        verify: { type: "boolean", description: "Set false to dispatch a single action without an extra before/wait/after verification pass" },
        timeoutMs: { type: "integer", minimum: 500, maximum: 60000, default: 8000 },
        settleMs: { type: "integer", minimum: 50, maximum: 2000, default: 250 },
        expect: EXPECTATION_SCHEMA,
        steps: { type: "array", minItems: 1, maxItems: 20, items: TRANSACTION_STEP_SCHEMA },
        stopOnError: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "omeety_click_text",
    description:
      "Click a visible element by its OWN direct text content (traverses shadow DOM). Use when snapshot gives no uid for an item — e.g. Feishu chat-list rows are plain <div> whose text is '羊了羊', or text-labeled menu items. Matches the element whose direct text equals/contains `text`; among multiple matches prefers button/a/[role=button]/menu/list items, then the shortest (leaf) to avoid hitting a wrapping container. exact:true = exact match (default contains). Dangerous labels still need confirmed:true.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, exact: { type: "boolean" }, confirmed: { type: "boolean" } },
      required: ["text"],
    },
  },
  {
    name: "omeety_click_at",
    description: "Click at viewport coordinate (x,y). Dangerous target labels require confirmation. Set cdp:true to use a REAL CDP mouse click (chrome.debugger Input.dispatchMouseEvent, isTrusted=true); clickCount:2 supports Canvas/grid double-click editing. Leaves a '正在调试此浏览器' yellow bar.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, confirmed: { type: "boolean" }, cdp: { type: "boolean" }, clickCount: { type: "integer", minimum: 1, maximum: 3 } },
      required: ["x", "y"],
    },
  },
  {
    name: "omeety_fill",
    description: "Replace a form field. With cdp:true, inputMode:'insertText' preserves CJK; inputMode:'keyEvents' sends trusted per-character ASCII/numeric keys for Canvas/controlled grids. Set refocus:false when the transient editor is already focused, and optionally commitKey:'Enter'|'Tab'. Clearing uses Cmd+A on macOS and Ctrl+A elsewhere. Leaves a yellow bar.",
    inputSchema: {
      type: "object",
      properties: { uid: { type: "string" }, selector: { type: "string" }, value: { type: "string" }, cdp: { type: "boolean" }, refocus: { type: "boolean" }, inputMode: { type: "string", enum: ["insertText", "keyEvents"] }, commitKey: { type: "string", enum: ["Enter", "Tab"] } },
      required: ["value"],
    },
  },
  {
    name: "omeety_type_text",
    description: "Type/append text into an editable target. With cdp:true, inputMode:'insertText' preserves CJK; inputMode:'keyEvents' sends trusted keydown/char/keyup sequences for ASCII/numeric Canvas editors. Set refocus:false to keep an already-focused transient editor, clear:false to append, and commitKey:'Enter'|'Tab' for atomic grid edits. Leaves a yellow bar.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        uid: { type: "string" },
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        clear: { type: "boolean" },
        cdp: { type: "boolean" },
        refocus: { type: "boolean" },
        inputMode: { type: "string", enum: ["insertText", "keyEvents"] },
        commitKey: { type: "string", enum: ["Enter", "Tab"] },
      },
      required: ["text"],
    },
  },
  {
    name: "omeety_press_key",
    description: "Dispatch a key on a target. With cdp:true, named keys use trusted keydown/up and printable characters use trusted keydown/char/keyup with correct KeyA/Digit1 codes. Set refocus:false to keep the current focused editor. Leaves a yellow bar.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, uid: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" }, cdp: { type: "boolean" }, refocus: { type: "boolean" } },
      required: ["key"],
    },
  },
  {
    name: "omeety_select",
    description: "Set an <option> value on a <select> by uid (preferred) or selector.",
    inputSchema: {
      type: "object",
      properties: { uid: { type: "string" }, selector: { type: "string" }, value: { type: "string" } },
      required: ["value"],
    },
  },
  {
    name: "omeety_scroll",
    description: "Scroll the page (or element at x,y) by deltaX/deltaY pixels.",
    inputSchema: {
      type: "object",
      properties: { deltaX: { type: "number", default: 0 }, deltaY: { type: "number", default: 600 }, x: { type: "number" }, y: { type: "number" } },
    },
  },
  {
    name: "omeety_request_user_confirmation",
    description: "Show a yes/no confirm dialog to the user.",
    inputSchema: { type: "object", properties: { message: { type: "string" }, detail: { type: "string" } } },
  },
  {
    name: "omeety_get_user_pick",
    description:
      "Return the most recently selected element from the sidebar picker (backward-compatible single-pick view). Returns uid:'pick-N' plus tag/role/text/selector/bbox/url, or {pick:null}. To act on all selected elements, prefer omeety_get_user_picks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "omeety_get_user_picks",
    description:
      "Return all elements from the user's latest completed continuous selection. The user clicks sidebar 选取, clicks multiple page elements, then presses Enter or clicks 完成选取. Returns {count,picks:[{uid:'pick-1'..,tag,role,text,label,type,href,selector,bbox,url}]}. Pass each uid to omeety_click/fill/type_text/select/hover.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "omeety_capture_visible_tab",
    description: "Screenshot the visible area of the active tab (returns a JPEG data URL, downscaled; result also carries image.width/height and coordinateSpace). ONLY useful if YOU are a multimodal/vision model that can analyze images. IMPORTANT: the image is in PHYSICAL pixels; click_at / snapshot.bbox use CSS pixels — map screenshot coords to CSS via CSS_x = screenshot_x × (viewport.width / image.width), using viewport.devicePixelRatio from omeety_get_page_snapshot. Text-only models CANNOT interpret this image — prefer omeety_get_page_snapshot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "omeety_upload_file",
    description: "Upload a LOCAL file (image/zip/any) into the page's file input. Clicks a trigger (x,y/uid/selector) that opens a file-chooser dialog, then injects the file via CDP DOM.setFileInputFiles using the chooser's backendNodeId (real file — the ONLY way; execute_js can't fake FileList). Note: Page.handleFileChooser was removed in Chromium 128+ (Edge 150); this tool intercepts the chooser and sets the file on the input node directly. Typical Feishu flow: click '+' → snapshot the 'image'/'file' menu item → call this with that item's coords + local file path. Leaves a yellow bar.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path to local file, e.g. C:\\\\Users\\\\AI\\\\shot.jpg" },
        x: { type: "number" }, y: { type: "number" },
        uid: { type: "string" }, selector: { type: "string" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "omeety_list_tabs",
    description: "List ALL open browser tabs across all windows. Returns {count, tabs:[{id, windowId, active, title, url}]}. Use to see what's open or to find a tabId before omeety_close_tab.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "omeety_close_tab",
    description: "Close a browser tab by tabId (from omeety_list_tabs). Irreversible — confirm with the user first.",
    inputSchema: { type: "object", properties: { tabId: { type: "integer" } }, required: ["tabId"] },
  },
  {
    name: "omeety_open_tab",
    description: "Open a NEW browser tab with the given http(s) URL. Returns {id, url, title}. By default the new tab becomes active (subsequent tools target it); pass active:false to open in background.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, active: { type: "boolean" } },
      required: ["url"],
    },
  },
  {
    name: "omeety_switch_tab",
    description: "Make an existing tab (tabId from omeety_list_tabs) the active tab and focus its window. Subsequent tools target it. Use this instead of asking the user to switch tabs manually.",
    inputSchema: { type: "object", properties: { tabId: { type: "integer" } }, required: ["tabId"] },
  },
  {
    name: "omeety_navigate",
    description: "Navigate a tab to a new http(s) URL (defaults to the active tab; pass tabId to pin it). Navigation is async — call omeety_wait_for with the same tabId, or use an act_and_verify transaction, before acting.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "omeety_reload",
    description: "Reload a tab (default: current active tab). bypassCache:true forces a hard reload.",
    inputSchema: { type: "object", properties: { tabId: { type: "integer" }, bypassCache: { type: "boolean" } } },
  },
  {
    name: "omeety_go_back",
    description: "Go back (or forward with forward:true) in a tab's history (default: current active tab).",
    inputSchema: { type: "object", properties: { tabId: { type: "integer" }, forward: { type: "boolean" } } },
  },
  {
    name: "omeety_execute_js",
    description:
      "Escape hatch: execute arbitrary JavaScript in a pinned tab's MAIN world through CDP Runtime.evaluate (defaults to the active tab and works on strict-CSP pages). It can read/write page variables, call page functions, and await async logic; use `return` for the value. world:'ISOLATED' creates an isolated world. Prefer dedicated tools or a multi-step act_and_verify transaction. Output is truncated at 200KB. Attaching CDP may show a debugging banner. Dangerous code requires confirmed:true.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        world: { type: "string", enum: ["MAIN", "ISOLATED"], default: "MAIN" },
        confirmed: { type: "boolean", description: "Required when the code performs a dangerous action such as submit/delete/send" },
      },
      required: ["code"],
    },
  },
  {
    name: "omeety_get_console_logs",
    description:
      "Read the page's console logs / uncaught exceptions collected via CDP (chrome.debugger). Use to diagnose 'nothing happened' / 'page errored'. NOTE: attaching the debugger shows a '正在调试此浏览器' yellow bar; collection starts at attach time, so on first call reproduce the action, then call again. clear:true empties the buffer after reading.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer" }, limit: { type: "integer", minimum: 1, maximum: 300 }, clear: { type: "boolean" } },
    },
  },
  {
    name: "omeety_get_runtime_metrics",
    description:
      "Return Omeety browser-runtime performance and reliability metrics for this service-worker lifetime: per-tool calls/successes/failures/average/max/last latency, totals, uptime, Native connection, side-panel connections, replay-buffer size, and attached CDP tab count. Use when diagnosing slowness or reliability regressions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "omeety_wait_for",
    description:
      "Wait for one or all page postconditions in a pinned tab: selector/text appears, selector/text disappears, URL/title contains, target value equals/includes, or checked state. Polls every 200ms and survives reload, navigation, BFCache, and user tab switches when tabId is supplied. Defaults to any condition; match:'all' requires every condition.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" }, text: { type: "string" },
        selectorGone: { type: "string" }, textGone: { type: "string" },
        urlIncludes: { type: "string" }, titleIncludes: { type: "string" },
        targetUid: { type: "string" }, targetSelector: { type: "string" },
        valueEquals: { type: "string" }, valueIncludes: { type: "string" }, checked: { type: "boolean" },
        match: { type: "string", enum: ["all", "any"], default: "any" },
        timeoutMs: { type: "integer", minimum: 500, maximum: 60000 },
      },
    },
  },
  {
    name: "omeety_hover",
    description: "Hover over an element (uid/selector/x,y) to reveal hover-only menus/tooltips. Afterwards take a fresh omeety_get_page_snapshot to see the newly appeared items before clicking.",
    inputSchema: {
      type: "object",
      properties: { uid: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
    },
  },
  {
    name: "omeety_download_start",
    description:
      "Start a persistent local download after explicit user confirmation in the Omeety sidebar. In auto mode Omeety probes direct and proxy routes, chooses the faster working route, resumes partial files, retries transient failures, uses ranged concurrency when supported, verifies optional SHA-256, and atomically publishes the completed file. It never executes downloaded files.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP(S) download URL" },
        fileName: { type: "string", description: "Optional safe output filename (saved under the configured Downloads directory)" },
        sha256: { type: "string", pattern: "^[A-Fa-f0-9]{64}$", description: "Optional expected SHA-256 checksum" },
        networkMode: { type: "string", enum: ["auto", "direct", "proxy"], default: "auto" },
        proxyUrl: { type: "string", description: "Optional HTTP(S) proxy URL without embedded credentials" },
        concurrency: { type: "integer", minimum: 1, maximum: 8, default: 4 },
      },
      required: ["url"],
    },
  },
  {
    name: "omeety_download_status",
    description: "Get one persistent download task by taskId, or list all tasks when taskId is omitted. Returns progress, speed, ETA, route, verification and errors.",
    inputSchema: { type: "object", properties: { taskId: { type: "string" } } },
  },
  {
    name: "omeety_download_cancel",
    description: "Cancel a running download. Partial segment files are retained so the task can be inspected and future resume support can reuse them.",
    inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  },
]

// 长事务必须能锁定页面，不能因用户中途切 tab 而转向另一个网页。
// 截图不在此列：chrome.tabs.captureVisibleTab 只能截窗口的活动 tab，伪装成可后台锁定会产生错图。
const PINNABLE_BROWSER_TOOLS = new Set([
  "omeety_get_page_snapshot", "omeety_get_selected_context", "omeety_fetch_with_cookie",
  "omeety_apply_preview_patch", "omeety_rollback_preview_patch", "omeety_click", "omeety_act_and_verify",
  "omeety_click_text", "omeety_click_at", "omeety_fill", "omeety_type_text", "omeety_press_key",
  "omeety_select", "omeety_scroll", "omeety_get_user_pick", "omeety_get_user_picks", "omeety_upload_file",
  "omeety_navigate", "omeety_reload", "omeety_go_back", "omeety_execute_js", "omeety_get_console_logs",
  "omeety_wait_for", "omeety_hover",
])

for (const tool of TOOLS) {
  if (!PINNABLE_BROWSER_TOOLS.has(tool.name)) continue
  tool.inputSchema.properties ||= {}
  tool.inputSchema.properties.tabId ||= {
    type: "integer",
    description: "Operate this exact browser tab even if the user switches the active tab during the task",
  }
}
