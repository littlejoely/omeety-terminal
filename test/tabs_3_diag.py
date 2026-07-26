# 精确复现 3-tab 场景：2 次 #tabNew 建 3 个 tab，active=2，反复点 idx0/idx1，
# 带点击目标日志，确认是否真有"3-tab 下点击失效"。
import sys, time, tempfile, re
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT_DIR = str(Path(__file__).resolve().parents[1] / "extension")

INJECT = r"""
(function(){
  window.__clicks = [];
  document.addEventListener("click", function(e){
    let n = e.target, chain=[];
    for (let i=0;i<5 && n;i++){ chain.push(n.tagName+"."+(String(n.className||"").slice(0,24))); n=n.parentElement; }
    window.__clicks.push({x:e.clientX,y:e.clientY,target:chain[0],chain});
  }, true);
})();
"""

def active_idx(page):
    return page.eval_on_selector_all(".tab", "els => els.findIndex(e => e.classList.contains('active'))")

def tab_box(page, idx):
    return page.eval_on_selector_all(".tab", f"els => {{ const r=els[{idx}].getBoundingClientRect(); return {{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),left:Math.round(r.x),vis: els[{idx}].offsetParent!==null}}; }}")

def click_idx(page, idx):
    page.evaluate("window.__clicks=[]")
    before = active_idx(page)
    box = tab_box(page, idx)
    page.mouse.click(box["x"], box["y"])
    page.wait_for_timeout(450)
    after = active_idx(page)
    clicks = page.evaluate("window.__clicks")
    tgt = clicks[0]["target"] if clicks else "(none)"
    ok = before != after
    print(f"  点 idx{idx}: active {before}->{after} box(x={box['x']},w={box['w']},left={box['left']},vis={box['vis']}) 命中={tgt}  {'OK' if ok else 'FAIL'}", flush=True)
    return ok

with sync_playwright() as p:
    udd = tempfile.mkdtemp(prefix="omeety_ext_")
    context = p.chromium.launch_persistent_context(
        user_data_dir=udd, headless=False,
        args=[f"--disable-extensions-except={EXT_DIR}", f"--load-extension={EXT_DIR}"],
        viewport={"width": 520, "height": 640},
    )
    ext_id = None
    try:
        sw = context.wait_for_event("serviceworker", timeout=15000)
        m = re.match(r"chrome-extension://([a-z]+)", sw.url)
        if m: ext_id = m.group(1)
    except Exception:
        pass
    if not ext_id:
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

    # 建 3 个 tab
    page.click("#tabNew"); page.wait_for_timeout(700)
    page.click("#tabNew"); page.wait_for_timeout(700)
    print("=== tab 数:", page.locator(".tab").count(), " active=", active_idx(page), flush=True)
    print("\n--- 反复点 idx0（当前 active=2）---", flush=True)
    for _ in range(3):
        click_idx(page, 0)
    print("\n--- 现在点 idx2（应切回最右）---", flush=True)
    click_idx(page, 2)
    print("\n--- 点 idx1 ---", flush=True)
    click_idx(page, 1)

    page.wait_for_timeout(1000)
    context.close()
