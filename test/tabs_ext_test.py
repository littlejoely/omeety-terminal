# 真实扩展 tab 切换完整测试：3 tab · 鼠标点击切换 · 键盘 Ctrl+Alt+←/→ 切换。
# 判定按 active 的 index（不按 title——多 tab 同 shell 时 title 相同）。
import sys, os, time, tempfile, re
from pathlib import Path
from playwright.sync_api import sync_playwright

EXT_DIR = str(Path(__file__).resolve().parents[1] / "extension")

def active_idx(page):
    return page.eval_on_selector_all(
        ".tab",
        "els => { const i = els.findIndex(e => e.classList.contains('active')); return i; }",
    )

def click_non_active_tab(page):
    coords = page.eval_on_selector(".tab:not(.active)",
        "el => { const r = el.getBoundingClientRect(); return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}; }")
    page.mouse.click(coords["x"], coords["y"])

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
    print("=== 扩展 ID:", ext_id, flush=True)

    page = context.new_page()
    errs = []
    page.on("pageerror", lambda e: (errs.append(str(e)), print("[PAGEERROR]", str(e)[:400], flush=True)))
    page.goto(f"chrome-extension://{ext_id}/sidepanel.html")
    page.wait_for_selector(".tab", timeout=10000)
    page.wait_for_timeout(1200)

    # 建 3 个 tab（初始 1 个 + 点 2 次 +）
    page.click("#tabNew"); page.wait_for_timeout(600)
    page.click("#tabNew"); page.wait_for_timeout(600)
    n = page.locator(".tab").count()
    print("=== tab 数:", n, "（期望 3）", flush=True)

    results = []

    # --- 测试 1：鼠标点最后一个 tab（index 2）---
    # 当前 active 应是 index 2（新建的）。点 index 0。
    before = active_idx(page)
    # 点 index 0：用 nth
    c0 = page.eval_on_selector(".tab:nth-child(1)",
        "el => { const r=el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; }")
    page.mouse.click(c0["x"], c0["y"])
    page.wait_for_timeout(700)
    after = active_idx(page)
    ok1 = (before != after)
    results.append(("鼠标点击切换", ok1, before, after))
    print(f"鼠标点击: before idx={before} -> after idx={after}  {'OK' if ok1 else 'FAIL'}", flush=True)

    # --- 测试 2：键盘 Ctrl+Alt+→ 切到下一个 ---
    before = active_idx(page)
    page.keyboard.press("Control+Alt+ArrowRight")
    page.wait_for_timeout(500)
    after = active_idx(page)
    expected = (before + 1) % n
    ok2 = (after == expected)
    results.append(("键盘 Ctrl+Alt+→", ok2, before, after, f"期望 {expected}"))
    print(f"键盘 Ctrl+Alt+→: before idx={before} -> after idx={after} (期望 {expected})  {'OK' if ok2 else 'FAIL'}", flush=True)

    # --- 测试 3：键盘 Ctrl+Alt+← 切到上一个 ---
    before = active_idx(page)
    page.keyboard.press("Control+Alt+ArrowLeft")
    page.wait_for_timeout(500)
    after = active_idx(page)
    expected = (before - 1 + n) % n
    ok3 = (after == expected)
    results.append(("键盘 Ctrl+Alt+←", ok3, before, after, f"期望 {expected}"))
    print(f"键盘 Ctrl+Alt+←: before idx={before} -> after idx={after} (期望 {expected})  {'OK' if ok3 else 'FAIL'}", flush=True)

    print("\n========== 汇总 ==========", flush=True)
    allok = all(r[1] for r in results)
    for r in results:
        print(("  ✅" if r[1] else "  ❌") + " " + r[0], flush=True)
    print("期间 pageerror 数:", len(errs), flush=True)
    for e in errs[:8]:
        print("  ERR:", e[:400], flush=True)
    print("\n##### " + ("全部切换正常——当前代码无 bug" if allok else "存在切换失败") + " #####", flush=True)

    page.wait_for_timeout(1500)
    context.close()
    sys.exit(0 if allok else 4)
