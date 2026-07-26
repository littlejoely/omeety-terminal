# 有头模式：打开 ime.html，用户用真实中文 IME 操作，自动抓 console.log 的 [omeety-ime] 序列。
# 捕获满 6 条或 270s 后退出。
import sys, time
from playwright.sync_api import sync_playwright

FILE = "http://localhost:8765/test/ime.html"
captured = []

def on_console(msg):
    try:
        t = msg.text
    except Exception:
        t = str(msg)
    print("[console]", t, flush=True)
    if "[omeety-ime]" in t:
        captured.append(t)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page()
    page.on("console", on_console)
    page.on("pageerror", lambda e: print("[pageerror]", e, flush=True))
    try:
        page.goto(FILE)
    except Exception as e:
        print("[goto error]", e, flush=True)
    print("=== BROWSER OPEN ===", flush=True)
    print("请在浏览器窗口里：点终端 → 切中文输入法 → 按 Shift+\" → 按 ' → 敲拼音", flush=True)
    deadline = time.time() + 240
    while time.time() < deadline and len(captured) < 60:
        try:
            page.wait_for_timeout(1000)
        except Exception:
            break
    print(f"=== DONE: captured {len(captured)} [omeety-ime] lines ===", flush=True)
    for c in captured:
        print("[RESULT]", c, flush=True)
    try:
        browser.close()
    except Exception:
        pass
