# 复现 tab 切换 bug：加载真实 sidepanel.html（chrome.* 用 addInitScript stub 掉），
# 点 + 建 2 号 tab，再点非激活 tab，用 DOM 断言判断"点击是否真的切换了 active"。
# 抓全部 console + pageerror（init/newTab/setActive 抛异常时这里是唯一信号）。
import sys, time, json
from playwright.sync_api import sync_playwright

URL = "http://localhost:8765/extension/sidepanel.html"
HEADED = "--headed" in sys.argv

CHROME_STUB = r"""
window.chrome = {
  runtime: {
    connect(info) {
      const name = (info && info.name) || "?";
      return {
        onMessage: { addListener(fn) {} },
        onDisconnect: { addListener(fn) {} },
        postMessage(m) { console.log("[stub port:" + name + "]", JSON.stringify(m).slice(0, 160)); },
        disconnect() {},
      };
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
console.log("[stub] chrome installed");
"""

def tabs_state(page):
    return page.eval_on_selector_all(
        ".tab",
        "els => els.map(e => ({title: e.querySelector('.tab-title') ? e.querySelector('.tab-title').textContent : '?', active: e.classList.contains('active')}))",
    )

def term_state(page):
    return page.eval_on_selector_all(
        "#terminalHost .terminal-tab",
        "els => els.map((e,i) => ({i, active: e.classList.contains('active'), guard: e.dataset.omeetyCursorGuard || '', renderer: e.dataset.omeetyRenderer || ''}))",
    )

with sync_playwright() as p:
    browser = p.chromium.launch(headless=not HEADED)
    page = browser.new_page(viewport={"width": 520, "height": 600})
    logs = []
    page.on("console", lambda m: print("[console:" + m.type + "]", m.text, flush=True))
    page.on("pageerror", lambda e: print("[PAGEERROR]", str(e), flush=True))
    page.add_init_script(CHROME_STUB)
    page.goto(URL)

    try:
        page.wait_for_selector(".tab", timeout=10000)
    except Exception as e:
        print("!!! 首个 .tab 没出现 —— connectPanel/newTab/initTerminal 在首轮就挂了:", e, flush=True)
        page.wait_for_timeout(1500)
        browser.close()
        sys.exit(1)

    print("=== 初始 tab 数:", page.locator(".tab").count(), flush=True)
    print("=== 初始 term 状态:", term_state(page), flush=True)

    # 点 + 建 2 号 tab
    try:
        page.click("#tabNew", timeout=4000)
    except Exception as e:
        print("!!! 点 #tabNew 失败:", e, flush=True)
    page.wait_for_timeout(500)

    n = page.locator(".tab").count()
    print("=== 点 + 后 tab 数:", n, flush=True)
    print("=== term 状态:", term_state(page), flush=True)

    if n < 2:
        print("\n##### 根因定位：newTab()/initTerminal() 在第 2 次调用时抛异常 → 只剩 1 个 tab，无 tab 可切 #####", flush=True)
        page.wait_for_timeout(1500)
        browser.close()
        sys.exit(2)

    print("\n--- 点非激活 tab 前 ---", flush=True)
    print("tabs:", tabs_state(page), flush=True)

    before = tabs_state(page)
    # 用真实鼠标点击非激活 tab 中心点（isTrusted，最贴近用户；避开 locator API 歧义）
    try:
        coords = page.eval_on_selector(
            ".tab:not(.active)",
            "el => { const r = el.getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; }",
        )
        print("=== 非激活 tab 中心坐标:", coords, flush=True)
        page.mouse.click(coords["x"], coords["y"])
        print("=== mouse.click 已派发", flush=True)
    except Exception as e:
        print("!!! 点非激活 tab 失败:", e, flush=True)
    page.wait_for_timeout(600)

    after = tabs_state(page)
    print("\n--- 点非激活 tab 后 ---", flush=True)
    print("tabs:", after, flush=True)
    print("term:", term_state(page), flush=True)

    # 判定：active 是否从原来的 tab 移到了另一个
    before_active = [t["title"] for t in before if t["active"]]
    after_active = [t["title"] for t in after if t["active"]]
    switched = before_active != after_active
    print("\n##### 点击" + ("【切换成功】" if switched else "【完全没反应·复现】") + "#####", flush=True)
    print("    before active:", before_active, "-> after active:", after_active, flush=True)

    page.wait_for_timeout(1500)
    browser.close()
    sys.exit(0 if switched else 3)
