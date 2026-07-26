// 浏览器工具的 JSON Schema（镜像 extension/content.js 与 background.js 契约）。MCP inputSchema 用。

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
      "Execute one browser action and verify its postcondition as a single transaction. Supports click/click_text/fill/type/press/select, preserves dangerous-action confirmation, can use real CDP input, survives reload/navigation while waiting, and returns before/after state plus timing. Provide expect for strong verification; fill/type/select infer a value postcondition automatically. Without expect, verification is weaker and only checks an observed page/target state change.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "click_text", "fill", "type", "press", "select"] },
        uid: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" },
        text: { type: "string" }, value: { type: "string" }, key: { type: "string" }, exact: { type: "boolean" }, clear: { type: "boolean" },
        cdp: { type: "boolean" }, confirmed: { type: "boolean" }, backgroundTask: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 500, maximum: 60000, default: 8000 },
        settleMs: { type: "integer", minimum: 50, maximum: 2000, default: 250 },
        expect: {
          type: "object",
          properties: {
            selector: { type: "string" }, text: { type: "string" },
            selectorGone: { type: "string" }, textGone: { type: "string" },
            urlIncludes: { type: "string" }, titleIncludes: { type: "string" },
            valueEquals: { type: "string" }, valueIncludes: { type: "string" }, checked: { type: "boolean" },
            match: { type: "string", enum: ["all", "any"], default: "all" },
            timeoutMs: { type: "integer", minimum: 500, maximum: 60000 },
          },
        },
      },
      required: ["action"],
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
    description: "Click at viewport coordinate (x,y). Dangerous target labels require confirmation. Set cdp:true to use a REAL CDP mouse click (chrome.debugger Input.dispatchMouseEvent, isTrusted=true) — needed when the target needs a real cursor/focus to activate (Feishu/Lark search box, contenteditable rich-text editor). Leaves a '正在调试此浏览器' yellow bar.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, confirmed: { type: "boolean" }, cdp: { type: "boolean" } },
      required: ["x", "y"],
    },
  },
  {
    name: "omeety_fill",
    description: "Replace the value of a form field by uid (preferred) or selector (dispatches input+change). Set cdp:true to fill via REAL CDP Input.insertText (native CJK/emoji; clears the field first via Ctrl+A+Backspace) — for rich-text editors (Feishu Lark EditorKit/ProseMirror/Slate) whose model ignores synthetic events. Target must be focused first. Leaves a yellow bar.",
    inputSchema: {
      type: "object",
      properties: { uid: { type: "string" }, selector: { type: "string" }, value: { type: "string" }, cdp: { type: "boolean" } },
      required: ["value"],
    },
  },
  {
    name: "omeety_type_text",
    description: "Type/append text into an editable element resolved by uid (preferred), selector, or x,y. Set cdp:true to type via REAL CDP Input.insertText (native CJK/emoji support — dispatchKeyEvent char mangles CJK like '杨琪'; falls back to char only if insertText unavailable) for rich-text editors whose model ignores synthetic events. CDP mode defaults to clear (Ctrl+A+Backspace first → replace semantics, safe to call repeatedly); pass clear:false to append. Target must be focused first (e.g. omeety_click_at cdp:true). Leaves a yellow bar.",
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
      },
      required: ["text"],
    },
  },
  {
    name: "omeety_press_key",
    description: "Dispatch keydown/keyup for a key (e.g. Enter, Tab, Backspace) on a target (uid/selector/x,y). Set cdp:true to use a REAL CDP keypress (Input.dispatchKeyEvent, isTrusted=true) — needed to trigger rich-text editor shortcuts/submit (e.g. Feishu chat box Enter to send, which ignores synthetic keydown). Leaves a yellow bar.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, uid: { type: "string" }, selector: { type: "string" }, x: { type: "number" }, y: { type: "number" }, cdp: { type: "boolean" } },
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
    description: "Navigate the CURRENT active tab to a new http(s) URL (same tab, not a new one). Navigation is async — call omeety_wait_for (or omeety_get_page_snapshot) to confirm the target page loaded before acting.",
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
      "Escape hatch: execute arbitrary JavaScript in the active page's MAIN world through CDP Runtime.evaluate (works on strict-CSP pages that block unsafe-eval). It can read/write page variables, call page functions, and await async logic; code runs as an async function body, so use `return` for the value. world:'ISOLATED' creates an isolated execution world. Use for anything the dedicated tools don't cover. The return value is stringified and truncated at 200KB. Attaching CDP may show the browser's debugging banner. Dangerous code requires confirmed:true.",
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
      "Wait for one or all page postconditions: selector/text appears, selector/text disappears, URL/title contains, target value equals/includes, or checked state. Polls every 200ms and survives reload, navigation, and BFCache. Defaults to any condition; match:'all' requires every condition.",
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
