// 浏览器工具的 JSON Schema（镜像 extension/content.js 与 background.js 契约）。MCP inputSchema 用。

export const TOOLS = [
  {
    name: "omeety_get_page_snapshot",
    description:
      "Capture a snapshot of the current page: url/title/visibleText/overview + interactive[] (each element has a stable uid, role, text, bbox, selector) + viewport{width,height,devicePixelRatio,scrollX,scrollY}. Pass an element's uid to omeety_click/fill/type_text/select — far more reliable than guessing CSS selectors (SPAs use dynamic classes). If an item has NO uid (a plain <div> like Feishu chat-list rows), use omeety_click_text on its visible text instead. Works for ALL models including text-only — the DEFAULT choice. Note: snapshot bbox is in CSS pixels; omeety_capture_visible_tab returns physical pixels (= CSS × devicePixelRatio) — divide screenshot coords by dpr before click_at.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["light", "detailed"], default: "light" },
        includeElements: { type: "boolean" },
        maxTextLength: { type: "integer", minimum: 0, maximum: 60000 },
        maxInteractive: { type: "integer", minimum: 1, maximum: 500, default: 120 },
      },
    },
  },
  {
    name: "omeety_get_selected_context",
    description: "Return the user's current text selection plus its enclosing element.",
    inputSchema: { type: "object", properties: {} },
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
    description: "Click an element by uid (preferred, from snapshot.interactive[].uid) or CSS selector. Dangerous labels auto-trigger a user confirm unless confirmed:true. Optional waitForSelector/waitForText: after clicking, poll every 200ms until the selector/text appears before returning — use after opening a menu or navigating, instead of guessing a sleep.",
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
      "Return the element the user selected with the sidebar 📌 选取 picker (click pick button → click an element on the page). Call this when the user says they 'selected / picked / 选中' an element. Returns {uid:'pick', tag, role, text, selector, bbox, url} or {pick:null}. To act on the picked element, call omeety_click/fill/type_text with uid:'pick'.",
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
      "Escape hatch: execute arbitrary JavaScript in the active page's MAIN world (can read/write page variables, call page functions, await async logic — runs as an async function body, use `return` for the value). world:'ISOLATED' runs in the content-script world instead. Use for anything the dedicated tools don't cover (read framework state, call page APIs, complex DOM extraction). The return value must be JSON-serializable (truncated at 200KB).",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" }, world: { type: "string", enum: ["MAIN", "ISOLATED"], default: "MAIN" } },
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
    name: "omeety_wait_for",
    description:
      "Wait until a CSS selector matches a visible element OR a text string appears in the page (whichever condition is given), polling every 200ms up to timeoutMs (default 10000, max 60000). Call after navigate/click instead of guessing fixed sleeps.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, text: { type: "string" }, timeoutMs: { type: "integer", minimum: 500, maximum: 60000 } },
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
]
