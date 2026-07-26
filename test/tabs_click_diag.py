# 诊断：鼠标点击 tab 时，click 事件到底有没有到达 .tab？
# 注入 capture 阶段监听，记录点击命中的元素链 + 坐标 + activeElement。
# 测 2-tab 和 3-tab 两种配置，看是否与 tab 数量/位置有关。
import sys, time, tempfile, re
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT_DIR = str(Path(__file__).resolve().parents[1] / "extension")

INJECT = r"""
(function(){
  window.__clicks = [];
  // capture 阶段：最先捕获，看 click 真实命中的 target 及其祖先链
  document.addEventListener("click", function(e){
    const chain = [];
    let n = e.target;
    for (let i=0; i<6 && n; i++){ chain.push(n.tagName + (n.className ? "."+String(n.className).slice(0,30) : "") + (n.id ? "#"+n.id : "")); n = n.parentElement; }
    window.__clicks.push({ x:e.clientX, y:e.clientY, target: chain[0], chain });
  }, true);
})();
"""

def active_idx(page):
    return page.eval_on_selector_all(".tab", "els => els.findIndex(e => e.classList.contains('active'))")

def tab_box(page, idx):
    return page.eval_on_selector_all(".tab", f"els => {{ const r = els[{idx}].getBoundingClientRect(); return {{x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:Math.round(r.width), left:Math.round(r.x), top:Math.round(r.y)}}; }}")

def click_and_report(page, label, click_idx):
    page.evaluate("window.__clicks = []")
    before = active_idx(page)
    box = tab_box(page, click_idx)
    print(f"\n[{label}] active={before}, 点击 tab#{click_idx} 中心 box={box}", flush=True)
    page.mouse.click(box["x"], box["y"])
    page.wait_for_timeout(500)
    after = active_idx(page)
    clicks = page.evaluate("window.__clicks")
    ae = page.evaluate("document.activeElement && (document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0,30))")
    print(f"  -> 点击后 active={after}  (切换 {'OK' if before!=after else 'FAIL'})", flush=True)
    print(f"  -> 捕获到 {len(clicks)} 个 click 事件:", flush=True)
    for c in clicks:
        print(f"     ({c['x']},{c['y']}) target={c['target']}  chain={c['chain'][:4]}", flush=True)
    print(f"  -> activeElement={ae}", flush=True)
    return before != after

with sync_playwright() as p:
    udd = tempfile.mkdtemp(prefix="omeety_ext_")
    context = p.chromium.launch_persistent_context(
        user_data_dir=udd, headless=False,
        args=[f"--disable-extensions-except={EXT_DIR}", f"--load-extension={EXT_DIR}"],
        viewport={"width": 520, "height": 640},
    )
    ext_id = None
    for _ in range(50):
        for sw in context.service_workers:
            m = re.match(r"chrome-extension://([a-z]+)", sw.url)
            if m: ext_id = m.group(1); break
        if ext_id: break
        time.sleep(0.2)
    page = context.new_page()
    page.on("pageerror", lambda e: print("[PAGEERROR]", str(e)[:300], flush=True))
    page.goto(f"chrome-extension://{ext_id}/sidepanel.html")
    page.wait_for_selector(".tab", timeout=10000)
    page.wait_for_timeout(1000)
    page.evaluate(INJECT)

    # ===== 场景 A：2 个 tab =====
    print("\n========== 场景 A：2 个 tab ==========", flush=True)
    click_and_report(page, "A-点 idx0", 0)

    # ===== 场景 B：3 个 tab（再点一次 +）=====
    print("\n========== 场景 B：建第 3 个 tab ==========", flush=True)
    page.click("#tabNew"); page.wait_for_timeout(700)
    page.evaluate(INJECT)  # 新 tab 后重新注入（__clicks 在 document 上，其实不用，但保险）
    print("  tab 数:", page.locator(".tab").count(), flush=True)
    # 此时 active 是新建的 idx2。点 idx0：
    click_and_report(page, "B-点 idx0(active=2)", 0)
    # 再点 idx1：
    click_and_report(page, "B-点 idx1", 1)

    page.wait_for_timeout(1200)
    context.close()
