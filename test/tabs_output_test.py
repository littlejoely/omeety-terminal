# 假设：真实终端有持续输出（codex TUI 的 CUP 重绘 + ?2026h/l synchronized output），
# 让 cgPinned() 常驻 true。此时 _syncTextArea/renderRows 走我加的自定义路径——
# 若那条路径在切 tab 的 rAF 里抛异常，可能破坏切换。
# 本脚本：stub 端口持续往每个终端灌 codex 风格重绘块，然后点击切换，看 active 切不切得动。
import sys, time
from playwright.sync_api import sync_playwright

URL = "http://localhost:8765/extension/sidepanel.html"
HEADED = "--headed" in sys.argv

# stub：connect 返回的 port 在收到 hello 后，setInterval 持续向该 sid 灌 codex 风格重绘块。
CHROME_STUB = r"""
window.__sids = [];
window.chrome = {
  runtime: {
    connect(info) {
      const name = (info && info.name) || "?";
      const msgListeners = [];
      const port = {
        onMessage: { addListener(fn) { msgListeners.push(fn); } },
        onDisconnect: { addListener(fn) {} },
        postMessage(m) {
          if (!m) return;
          if (m.type === "hello" && m.sid) {
            window.__sids.push(m.sid);
            // 启动持续输出泵：每 16ms 灌一个 codex 风格 synchronized-output 重绘块
            if (!port.__pump) {
              port.__pump = setInterval(() => {
                const sids = window.__sids;
                for (const sid of sids) {
                  const chunk =
                    "\x1b[?2026h"            // begin synchronized output
                    + "\x1b[H"                // CUP home（重绘类 → cgUnsafeChunk）
                    + "\x1b[2J"               // clear
                    + "\x1b[1;1Htab " + sid + " codex redraw " + Date.now() + "\r\n"
                    + "\x1b[23;1H> input here_"
                    + "\x1b[24;1H[ status bar ]"
                    + "\x1b[23;11H"           // CUP 回输入行（重绘类）
                    + "\x1b[?2026l";           // end sync → 触发 cgArmSettle（cgPinned 常驻）
                  for (const fn of msgListeners) {
                    try { fn({ type: "output", sid: sid, data: chunk }); } catch (e) {}
                  }
                }
              }, 16);
            }
          }
          console.log("[stub port:" + name + "]", JSON.stringify(m).slice(0, 100));
        },
        disconnect() {},
      };
      return port;
    },
    connectNative() { return null; },
    lastError: null,
  },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  tabs: { create(){}, update(){}, query: async()=>[], remove(){}, get:async()=>({}), sendMessage:async()=>{}, goBack(){}, goForward(){}, reload(){} },
  scripting: { executeScript:async()=>[], insertCSS:async()=>[] },
  sidePanel: { setPanelBehavior: async()=>{} },
  offscreen: { hasDocument: async()=>true, createDocument: async()=>{} },
  debugger: {},
};
console.log("[stub] chrome installed (with codex output pump)");
"""

def tabs_state(page):
    return page.eval_on_selector_all(
        ".tab",
        "els => els.map(e => ({title: e.querySelector('.tab-title') ? e.querySelector('.tab-title').textContent : '?', active: e.classList.contains('active')}))",
    )

with sync_playwright() as p:
    browser = p.chromium.launch(headless=not HEADED)
    page = browser.new_page(viewport={"width": 520, "height": 600})
    errs = []
    page.on("console", lambda m: print("[console:" + m.type + "]", m.text[:200], flush=True))
    page.on("pageerror", lambda e: (errs.append(str(e)), print("[PAGEERROR]", str(e)[:300], flush=True)))
    page.add_init_script(CHROME_STUB)
    page.goto(URL)
    page.wait_for_selector(".tab", timeout=10000)

    print("=== 初始 tab 数:", page.locator(".tab").count(), flush=True)
    # 让输出泵跑一会，确保 cgPinned 进入常驻态
    page.wait_for_timeout(800)

    # 建 2 号 tab
    page.click("#tabNew")
    page.wait_for_timeout(800)
    n = page.locator(".tab").count()
    print("=== 建 2 号后 tab 数:", n, flush=True)
    if n < 2:
        print("!!! 只有 1 个 tab", flush=True)
        browser.close(); sys.exit(2)

    # 再让两个 tab 都被泵一会
    page.wait_for_timeout(600)

    before = tabs_state(page)
    print("\n--- 点击前 --- tabs:", before, flush=True)
    print("    pinned 状态:", page.eval_on_selector_all("#terminalHost .terminal-tab",
        "els => els.map(e => ({i:e.dataset.omeetyCursorGuard, pinned: e.dataset.omeetyCursorPinned, committed: e.dataset.omeetyCursorCommitted}))"), flush=True)

    # 点非激活 tab
    coords = page.eval_on_selector(".tab:not(.active)",
        "el => { const r = el.getBoundingClientRect(); return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}; }")
    print("=== 点击坐标:", coords, flush=True)
    page.mouse.click(coords["x"], coords["y"])
    page.wait_for_timeout(800)  # 等 rAF + settle

    after = tabs_state(page)
    print("\n--- 点击后 --- tabs:", after, flush=True)

    ba = [t["title"] for t in before if t["active"]]
    aa = [t["title"] for t in after if t["active"]]
    switched = ba != aa
    print("\n##### 持续输出下点击：" + ("【切换成功】" if switched else "【失效·复现！】") + "#####", flush=True)
    print("    before:", ba, "-> after:", aa, flush=True)
    print("    期间 pageerror 数:", len(errs), flush=True)
    for e in errs[:5]:
        print("    ERR:", e[:300], flush=True)

    page.wait_for_timeout(1000)
    browser.close()
    sys.exit(0 if switched else 3)
