# 决定性验证：窄侧栏（360px，接近真实 Edge 侧栏）下，可见的 tab 是否一定能点；
# 被滚出屏幕的 tab 是否点不到。逐 tab 打印 left/可见性/点击结果。
import sys, time, tempfile, re
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT_DIR = str(Path(__file__).resolve().parents[1] / "extension")

def each_tab(page):
    return page.eval_on_selector_all(".tab", """els => {
      const host = document.getElementById('tabs');
      const hr = host.getBoundingClientRect();
      const out = [];
      els.forEach((e,i) => {
        const r = e.getBoundingClientRect();
        const cx = Math.round(r.x + r.width/2);
        // 中心点是否落在 tabs 容器可见区间内
        const visible = cx >= hr.left && cx <= hr.right;
        out.push({i, left:Math.round(r.x), w:Math.round(r.width), cx, visible, active:e.classList.contains('active'),
                  title: e.querySelector('.tab-title') ? e.querySelector('.tab-title').textContent.slice(0,18) : '?'});
      });
      return {hostLeft:Math.round(hr.left), hostRight:Math.round(hr.right), hostW:Math.round(hr.width), tabs:out};
    }""")

def click_cx(page, cx, cy=18):
    page.evaluate("window.__clicks=[]")
    page.mouse.click(cx, cy)
    page.wait_for_timeout(400)
    return page.evaluate("window.__clicks[0] ? window.__clicks[0].target : '(none)'")

with sync_playwright() as p:
    udd = tempfile.mkdtemp(prefix="omeety_ext_")
    context = p.chromium.launch_persistent_context(
        user_data_dir=udd, headless=False,
        args=[f"--disable-extensions-except={EXT_DIR}", f"--load-extension={EXT_DIR}"],
        viewport={"width": 360, "height": 600},
    )
    page = context.new_page()
    page.on("pageerror", lambda e: print("[PAGEERROR]", str(e)[:300], flush=True))
    page.add_init_script("""document.addEventListener('click',e=>{window.__clicks=window.__clicks||[];let n=e.target;window.__clicks.push({target:n.tagName+'.'+String(n.className||'').slice(0,20)})},true);""")
    try:
        sw = context.wait_for_event("serviceworker", timeout=15000)
        ext_id = re.match(r"chrome-extension://([a-z]+)", sw.url).group(1)
    except Exception:
        ext_id = None
        for _ in range(50):
            for sw in context.service_workers:
                m = re.match(r"chrome-extension://([a-z]+)", sw.url)
                if m: ext_id=m.group(1); break
            if ext_id: break
            time.sleep(0.2)
    page.goto(f"chrome-extension://{ext_id}/sidepanel.html")
    page.wait_for_selector(".tab", timeout=10000)
    page.wait_for_timeout(1200)

    for k in range(3):  # 建到 4 个 tab
        page.click("#tabNew"); page.wait_for_timeout(700)

    st = each_tab(page)
    print(f"\n=== viewport=360, tabs容器宽={st['hostW']} (left={st['hostLeft']},right={st['hostRight']}) ===", flush=True)
    for t in st["tabs"]:
        flag = "可见" if t["visible"] else "❌滚出屏幕"
        act = " [active]" if t["active"] else ""
        print(f"  tab#{t['i']} '{t['title']}' left={t['left']} w={t['w']} cx={t['cx']} {flag}{act}", flush=True)

    print("\n--- 逐个点每个 tab 的中心点，看命中谁 ---", flush=True)
    for t in st["tabs"]:
        if t["active"]:
            print(f"  tab#{t['i']}: 已是 active，跳过", flush=True); continue
        tgt = click_cx(page, t["cx"])
        # 点完重读 active
        st2 = each_tab(page)
        newactive = next((x["i"] for x in st2["tabs"] if x["active"]), -1)
        ok = newactive == t["i"]
        print(f"  点 tab#{t['i']} (cx={t['cx']}, {'可见' if t['visible'] else '滚出'}): 命中={tgt} -> active={newactive} {'✅OK' if ok else '❌FAIL'}", flush=True)

    page.wait_for_timeout(1000)
    context.close()
