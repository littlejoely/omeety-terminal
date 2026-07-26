"""Capture reproducible public launch assets from a real Omeety stack.

The capture launches a temporary Edge profile, a test-only MCP port, the real
extension, Native Messaging host, ConPTY terminal, and a deterministic MCP
client. It never touches the user's normal browser profile or production port.
"""

import base64
import io
import os
import shutil
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

from test_cursor_probe import EXT, EXT_ID, PROFILE_ROOT


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "images"
DEMO_AGENT = ROOT / "_pwtest" / "launch_demo_agent.mjs"
MCP_PORT = 49475
os.environ["OMEETY_MCP_PORT"] = str(MCP_PORT)


TARGET_HTML = r"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Omeety Launch Lab</title>
<style>
  *{box-sizing:border-box} body{margin:0;min-height:100vh;color:#eef3ff;background:#07101f;
  font:15px/1.5 "Segoe UI",Arial,sans-serif;overflow:hidden}
  body:before{content:"";position:fixed;inset:-30%;background:
  radial-gradient(circle at 24% 24%,#213b784f 0 17%,transparent 38%),
  radial-gradient(circle at 82% 72%,#653f8b40 0 13%,transparent 35%);filter:blur(12px)}
  header{height:68px;padding:0 32px;display:flex;align-items:center;justify-content:space-between;
  border-bottom:1px solid #8aa1c329;background:#0a1425d9;backdrop-filter:blur(16px);position:relative}
  .brand{display:flex;gap:12px;align-items:center;font-weight:750;font-size:17px}.mark{width:31px;height:31px;
  border-radius:10px;background:#171a31;display:grid;place-items:center;color:#7dd3fc;font:700 18px Consolas}
  .tag{color:#8da0bd;font-size:12px;border:1px solid #60738e55;padding:5px 9px;border-radius:99px}
  main{position:relative;padding:58px 62px}.eyebrow{color:#76d8ff;text-transform:uppercase;letter-spacing:.18em;
  font-size:11px;font-weight:700}.hero{font-size:52px;line-height:1.03;letter-spacing:-.045em;margin:14px 0 20px;
  max-width:650px}.hero span{color:#9daefc}.sub{color:#9cacc4;font-size:17px;max-width:590px}
  .card{margin-top:38px;width:620px;padding:22px 24px;border:1px solid #92a7ca32;border-radius:18px;
  background:#101c31cc;box-shadow:0 24px 80px #0008;display:flex;align-items:center;justify-content:space-between}
  .label{font-size:12px;color:#8292ac;text-transform:uppercase;letter-spacing:.11em}.state{font-size:20px;
  font-weight:720;margin-top:5px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#ffbd66;
  box-shadow:0 0 20px #ffbd66;margin-right:9px}.card.linked{border-color:#5ee7b174;background:#0e2a2aee}
  .card.linked .dot{background:#5ee7b1;box-shadow:0 0 24px #5ee7b1}.card.linked .state{color:#b9ffe3}
  button{border:0;color:#07101f;background:#eaf1ff;border-radius:11px;padding:12px 17px;font-weight:750;
  cursor:pointer;transition:.2s}button:hover{transform:translateY(-1px);background:#fff}.card.linked button{background:#5ee7b1}
  .tools{display:flex;gap:10px;margin-top:25px}.tool{color:#9fb0c9;border:1px solid #657a9a3d;
  padding:7px 10px;border-radius:9px;background:#0b1728}
</style>
<header><div class="brand"><div class="mark">&lt;•&gt;</div>Omeety Launch Lab</div><div class="tag">ACTIVE BROWSER TAB</div></header>
<main>
  <div class="eyebrow">Agent-neutral browser control</div>
  <div class="hero">Your CLI agent now has<br><span>browser eyes & hands.</span></div>
  <div class="sub">Keep the real local terminal. Give Codex, Claude Code, Kimi Code, or any MCP client the same reliable browser tools.</div>
  <div class="card" id="connection-card"><div><div class="label">Browser bridge</div><div class="state"><i class="dot"></i><span id="status">Waiting for agent</span></div></div><button id="connect-browser">Connect browser</button></div>
  <div class="tools"><span class="tool">Current tab</span><span class="tool">32 MCP tools</span><span class="tool">Native Messaging</span><span class="tool">ConPTY</span></div>
</main>
<script>
document.getElementById('connect-browser').addEventListener('click',()=>{
  const card=document.getElementById('connection-card');card.classList.add('linked');
  document.getElementById('status').textContent='Browser linked';
  const button=document.getElementById('connect-browser');button.textContent='Connected ✓';button.disabled=true;
  document.body.dataset.demoState='linked';
});
</script>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        data = TARGET_HTML.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def terminal_text(panel):
    return panel.evaluate(
        """() => {
          const t = document.querySelector('.terminal-tab.active')?.__omeetyTerm;
          const b = t?.buffer?.active;
          if (!b) return '';
          const lines = [];
          for (let i = Math.max(0, b.length - 80); i < b.length; i++)
            lines.push(b.getLine(i)?.translateToString(true) || '');
          return lines.join('\\n');
        }"""
    )


def composite(target_png, panel_png):
    left = Image.open(io.BytesIO(target_png)).convert("RGB")
    right = Image.open(io.BytesIO(panel_png)).convert("RGB")
    canvas = Image.new("RGB", (1280, 720), "#070b12")
    canvas.paste(left.resize((780, 720), Image.Resampling.LANCZOS), (0, 0))
    canvas.paste(right.resize((499, 720), Image.Resampling.LANCZOS), (781, 0))
    return canvas


def save_gif(frames):
    # A shared adaptive palette keeps the launch GIF small enough for a README
    # while preserving terminal text and the product's blue/green accents.
    sample = frames[len(frames) // 2].quantize(colors=96, method=Image.Quantize.MEDIANCUT)
    palette = sample.getpalette()
    indexed = []
    for frame in frames:
        pal = Image.new("P", frame.size)
        pal.putpalette(palette)
        indexed.append(frame.quantize(palette=pal, dither=Image.Dither.NONE))
    indexed[0].save(
        OUTPUT / "omeety-demo.gif",
        save_all=True,
        append_images=indexed[1:],
        duration=420,
        loop=0,
        optimize=True,
        disposal=2,
    )


def render_social_preview(context, final_frame):
    buffer = io.BytesIO()
    final_frame.save(buffer, format="JPEG", quality=88)
    shot = base64.b64encode(buffer.getvalue()).decode("ascii")
    logo = base64.b64encode((ROOT / "extension" / "icons" / "icon-128.png").read_bytes()).decode("ascii")
    page = context.new_page()
    page.set_viewport_size({"width": 1280, "height": 640})
    page.set_content(
        f"""<!doctype html><style>
        *{{box-sizing:border-box}}body{{margin:0;width:1280px;height:640px;overflow:hidden;color:#f6f8ff;
        font-family:'Segoe UI',Arial,sans-serif;background:#070b14}}
        body:before{{content:'';position:absolute;inset:0;background:radial-gradient(circle at 12% 12%,#203e7a 0,transparent 38%),radial-gradient(circle at 94% 90%,#49316e 0,transparent 40%)}}
        .copy{{position:absolute;left:72px;top:68px;width:535px;z-index:2}}.brand{{display:flex;align-items:center;gap:15px;font-size:22px;font-weight:750}}.brand img{{width:54px;height:54px;border-radius:14px}}
        h1{{font-size:55px;line-height:1.02;letter-spacing:-.045em;margin:38px 0 20px}}h1 span{{color:#94a9ff}}p{{font-size:19px;line-height:1.45;color:#a8b6cc;max-width:510px}}
        .chips{{display:flex;gap:9px;margin-top:27px}}.chips i{{font-style:normal;font:600 13px Consolas;padding:8px 11px;border:1px solid #7286aa55;border-radius:9px;background:#101a2b}}
        .shot{{position:absolute;left:620px;top:76px;width:720px;height:492px;border-radius:20px;overflow:hidden;border:1px solid #adc2e344;box-shadow:0 30px 90px #000a;transform:perspective(1200px) rotateY(-5deg)}}
        .shot img{{width:875px;height:492px;object-fit:cover;object-position:right top}}.glow{{position:absolute;inset:auto 0 0;height:2px;background:linear-gradient(90deg,#6ee7c2,#7aa5ff,#c28aff)}}
        </style><div class='copy'><div class='brand'><img src='data:image/png;base64,{logo}'>Omeety Terminal</div><h1>The browser <span>exoskeleton</span><br>for CLI agents.</h1><p>A real local terminal in Edge/Chrome. One set of browser eyes and hands for Codex, Claude Code, Kimi Code, and any MCP client.</p><div class='chips'><i>Real PTY</i><i>32 MCP tools</i><i>Agent-neutral</i><i>Local-first</i></div></div><div class='shot'><img src='data:image/jpeg;base64,{shot}'></div><div class='glow'></div>""",
        wait_until="load",
    )
    page.screenshot(path=str(OUTPUT / "social-preview.png"))
    page.close()


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="launch-assets-", dir=PROFILE_ROOT))
    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/"
    frames = []
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                str(profile),
                channel="msedge",
                headless=False,
                viewport={"width": 780, "height": 720},
                args=[
                    f"--disable-extensions-except={EXT}",
                    f"--load-extension={EXT}",
                    "--enable-extensions",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            )
            try:
                target = context.new_page()
                target.set_viewport_size({"width": 780, "height": 720})
                target.goto(url, wait_until="domcontentloaded")
                panel = context.new_page()
                panel.set_viewport_size({"width": 500, "height": 720})
                panel.goto(f"chrome-extension://{EXT_ID}/sidepanel.html", wait_until="domcontentloaded")
                try:
                    panel.click("#ackBtn", timeout=3000)
                except Exception:
                    pass
                panel.wait_for_function(
                    "() => document.getElementById('statusText').textContent.includes('已连接')",
                    timeout=15000,
                )
                panel.click(".terminal-tab.active")
                for _ in range(3):
                    panel.keyboard.press("Control+=")
                panel.keyboard.type("Clear-Host", delay=2)
                panel.keyboard.press("Enter")
                panel.wait_for_timeout(500)
                command = f"$env:OMEETY_MCP_URL='http://127.0.0.1:{MCP_PORT}/mcp'; node '{DEMO_AGENT}'"
                panel.keyboard.type(command, delay=1)
                panel.keyboard.press("Enter")
                target.bring_to_front()

                deadline = time.time() + 24
                completed_at = None
                while time.time() < deadline:
                    frames.append(composite(target.screenshot(type="png"), panel.screenshot(type="png")))
                    linked = target.locator("body").get_attribute("data-demo-state") == "linked"
                    complete = "Demo complete" in terminal_text(panel)
                    if linked and complete and completed_at is None:
                        completed_at = time.time()
                    if completed_at and time.time() - completed_at >= 2.0:
                        break
                    time.sleep(0.08)
                if not completed_at:
                    raise AssertionError(f"launch demo did not complete; terminal={terminal_text(panel)[-1600:]!r}")

                final_frame = frames[-1]
                final_frame.save(OUTPUT / "omeety-terminal-clean.png", quality=92)
                save_gif(frames)
                render_social_preview(context, final_frame)
            finally:
                context.close()
    finally:
        server.shutdown()
        resolved = profile.resolve()
        if PROFILE_ROOT.resolve() in resolved.parents:
            shutil.rmtree(resolved, ignore_errors=True)

    print(f"PASS launch assets: {len(frames)} GIF frames")
    for name in ("omeety-demo.gif", "omeety-terminal-clean.png", "social-preview.png"):
        path = OUTPUT / name
        print(f"  {name}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
