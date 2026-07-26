# IME 诊断测试 v2：用 charCode 明确字符，消除终端编码歧义。
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

FILE = (Path(__file__).resolve().parent / "ime.html").as_uri()
LDQ = "“"  # U+201C

def codes(arr):
    return [[c for c in s] and [hex(ord(c)) for c in s] for s in arr]

def snap(page):
    return page.evaluate("""() => ({
        delivered: window.__delivered.slice(),
        events: window.__events.slice(),
        comp: window.__compEvents.slice(),
        taValue: window.__ta.value,
        fires: window.__fires||0, stimeout: window.__stimeout||0,
        ieLogs: window.__inputEventLogs || [],
    })""")

def reset(page):
    page.evaluate("() => { window.__delivered=[]; window.__events=[]; window.__compEvents=[]; window.__fires=0; window.__stimeout=0; if(window.__ta) window.__ta.value=''; }")

def show(title, s):
    print(f"\n=== {title} ===")
    print("  events    :", json.dumps(s["events"], ensure_ascii=False))
    print("  comp/input:", json.dumps(s["comp"], ensure_ascii=False))
    print("  taValue   :", [hex(ord(c)) for c in s["taValue"]])
    print("  delivered :", codes(s["delivered"]), "(count=%d)" % len(s["delivered"]))
    print("  ieLogs    :", json.dumps(s.get("ieLogs",[]), ensure_ascii=False))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(FILE)
    page.wait_for_function("window.__ready")
    page.wait_for_timeout(200)

    # A: 真实键盘 Shift+Quote（英文，无 IME）→ 期望单个 0x22
    page.focus(".xterm-helper-textarea")
    page.keyboard.press("Shift+Quote")
    page.wait_for_timeout(120)
    show('A. real keyboard Shift+Quote (English, expect [0x22])', snap(page))

    reset(page)
    page.focus(".xterm-helper-textarea")
    page.keyboard.press("Quote")
    page.wait_for_timeout(120)
    show('A2. real keyboard Quote (English, expect [0x27])', snap(page))

    # B: 模拟 IME 直接转换（Shift+" → U+201C）→ 期望单个 0x201c
    reset(page)
    page.focus(".xterm-helper-textarea")
    b = page.evaluate("""async () => {
        const ta = window.__ta; ta.focus();
        const ev = new KeyboardEvent('keydown',{code:'Quote',key:'"',keyCode:222,shiftKey:true,bubbles:true,cancelable:true});
        Object.defineProperty(ev,'keyCode',{get:()=>222});
        ta.dispatchEvent(ev);
        ta.value = '“';
        ta.dispatchEvent(new InputEvent('input',{data:'“',inputType:'insertText',bubbles:true}));
        await new Promise(r=>setTimeout(r,60));
        return {delivered: window.__delivered.slice(), fires: window.__fires, stimeout: window.__stimeout};
    }""")
    print('\n=== B. simulated IME Shift+" -> U+201C (keyCode=222, direct) ===')
    print('  fires/stimeout:', b["fires"], "/", b["stimeout"])
    print('  delivered :', codes(b["delivered"]), "(count=%d)" % len(b["delivered"]))
    ok = len(b["delivered"]) == 1 and any(ord(c)==0x201c for c in b["delivered"][0])
    print('  =>', 'PASS：单个中文双引号' if ok else 'FAIL')

    # B2: 同上但 keyCode=229（IME 处理的标准信号）→ 看 xterm 是否单发
    reset(page)
    page.focus(".xterm-helper-textarea")
    b2 = page.evaluate("""async () => {
        const ta = window.__ta; ta.focus();
        const ev = new KeyboardEvent('keydown',{code:'Quote',key:'Process',keyCode:229,shiftKey:true,bubbles:true,cancelable:true});
        Object.defineProperty(ev,'keyCode',{get:()=>229});
        ta.dispatchEvent(ev);
        ta.value = '“';
        ta.dispatchEvent(new InputEvent('input',{data:'“',inputType:'insertText',bubbles:true}));
        await new Promise(r=>setTimeout(r,60));
        return {delivered: window.__delivered.slice()};
    }""")
    print('\n=== B2. simulated IME Shift+" (keyCode=229, direct) ===')
    print('  delivered :', codes(b2["delivered"]), "(count=%d)" % len(b2["delivered"]))
    ok = len(b2["delivered"]) == 1 and any(ord(c)==0x201c for c in b2["delivered"][0])
    print('  =>', 'PASS：单个中文双引号' if ok else 'FAIL')

    # D: 开启"光标稳定器 textarea 重定位"后再测 IME direct 229，看重定位是否破坏交付
    reset(page)
    page.evaluate("() => { window.__stabOn = true; window.__stab(); }")
    page.focus(".xterm-helper-textarea")
    d = page.evaluate("""async () => {
        const ta = window.__ta; ta.focus();
        window.__stab();
        const ev = new KeyboardEvent('keydown',{code:'Quote',key:'Process',keyCode:229,shiftKey:true,bubbles:true,cancelable:true});
        Object.defineProperty(ev,'keyCode',{get:()=>229});
        ta.dispatchEvent(ev);
        ta.value = '“';
        ta.dispatchEvent(new InputEvent('input',{data:'“',inputType:'insertText',bubbles:true}));
        await new Promise(r=>setTimeout(r,60));
        return {delivered: window.__delivered.slice()};
    }""")
    print('\n=== D. IME direct 229 WITH stabilizer textarea-reposition ===')
    print('  delivered :', codes(d["delivered"]), "(count=%d)" % len(d["delivered"]))
    ok = len(d["delivered"]) == 1 and any(ord(c)==0x201c for c in d["delivered"][0])
    print('  =>', 'PASS：重定位不影响交付' if ok else 'FAIL：重定位破坏了 IME！')

    # C: 模拟 IME composition（229 + compositionend）→ 期望单个 0x201c
    reset(page)
    page.focus(".xterm-helper-textarea")
    c = page.evaluate("""async () => {
        const ta = window.__ta; ta.focus();
        ta.dispatchEvent(new KeyboardEvent('keydown',{code:'Quote',key:'Process',keyCode:229,shiftKey:true,bubbles:true,cancelable:true}));
        ta.dispatchEvent(new CompositionEvent('compositionstart',{data:''}));
        ta.value = '“';
        ta.dispatchEvent(new CompositionEvent('compositionupdate',{data:'“'}));
        ta.dispatchEvent(new CompositionEvent('compositionend',{data:'“'}));
        await new Promise(r=>setTimeout(r,60));
        return {delivered: window.__delivered.slice()};
    }""")
    print('\n=== C. simulated IME composition (229 + compositionend) ===')
    print('  delivered :', codes(c["delivered"]), "(count=%d)" % len(c["delivered"]))
    ok = len(c["delivered"]) == 1 and any(ord(x)==0x201c for x in c["delivered"][0]) if c["delivered"] else False
    print('  =>', 'PASS' if ok else 'FAIL (composition 路径, xterm 原生处理)')

    browser.close()
