// IME 诊断测试：用真实 Chromium 键盘事件 + 手动模拟 IME 转换，
// 搞清 Shift+" / ' 的事件签名、xterm textarea 是否收到字符、我的交付路径是否生效。
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = pathToFileURL(join(HERE, 'ime.html')).href;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(FILE);
await page.waitForFunction('window.__ready');
await page.waitForTimeout(200);

const snap = () => page.evaluate(() => ({
  delivered: window.__delivered.slice(),
  events: window.__events.slice(),
  comp: window.__compEvents.slice(),
  taValue: window.__ta.value,
}));
const reset = () => page.evaluate(() => { window.__delivered=[]; window.__events=[]; window.__compEvents=[]; });

function log(title, s) {
  console.log('\n=== ' + title + ' ===');
  console.log('  events    :', JSON.stringify(s.events));
  console.log('  comp/input:', JSON.stringify(s.comp));
  console.log('  taValue   :', JSON.stringify(s.taValue));
  console.log('  delivered :', JSON.stringify(s.delivered));
}

// ---------- Test A：真实键盘 Shift+Quote（Playwright 走 CDP 真实事件）----------
await page.focus('.xterm-helper-textarea');
await page.keyboard.press('Shift+Quote');
await page.waitForTimeout(120);
log('A. real keyboard Shift+Quote (期望 delivered 含 ")', await snap());

// ---------- Test A2：真实键盘 Quote ----------
await reset();
await page.focus('.xterm-helper-textarea');
await page.keyboard.press('Quote');
await page.waitForTimeout(120);
log('A2. real keyboard Quote (期望 delivered 含 \')', await snap());

// ---------- Test B：模拟 IME 直接转换（无 composition，只改 textarea.value + input）----------
// 即微软拼音等对 Shift+" 的真实行为：不发 229、不发 composition，直接把 "" 写进 textarea。
await reset();
await page.focus('.xterm-helper-textarea');
const b = await page.evaluate(async () => {
  const ta = window.__ta;
  ta.focus();
  // 模拟 keydown（Shift+Quote，keyCode=222，不发 229）—— 触发我的 (c) 路径
  const ev = new KeyboardEvent('keydown', { code:'Quote', key:'"', keyCode:222, shiftKey:true, bubbles:true, cancelable:true });
  Object.defineProperty(ev, 'keyCode', { get: () => 222 });
  ta.dispatchEvent(ev);
  // 浏览器默认动作：IME 把转换结果写进 textarea
  ta.value = '“';            // “
  ta.dispatchEvent(new InputEvent('input', { data:'“', inputType:'insertText', bubbles:true }));
  await new Promise(r => setTimeout(r, 60));  // 等 _handleAnyTextareaChanges 的 setTimeout
  return { delivered: window.__delivered.slice(), comp: window.__compEvents.slice(), taValue: ta.value };
});
console.log('\n=== B. simulated IME Shift+" → “ (直接转换) ===');
console.log('  comp/input:', JSON.stringify(b.comp));
console.log('  taValue   :', JSON.stringify(b.taValue));
console.log('  delivered :', JSON.stringify(b.delivered));
console.log('  =>', b.delivered.includes('“') ? 'PASS：中文双引号已送达 PTY' : 'FAIL：未送达');

// ---------- Test C：模拟 IME 组合转换（compositionstart→compositionend）----------
await reset();
await page.focus('.xterm-helper-textarea');
const c = await page.evaluate(async () => {
  const ta = window.__ta;
  ta.focus();
  ta.dispatchEvent(new KeyboardEvent('keydown', { code:'Quote', key:'Process', keyCode:229, shiftKey:true, bubbles:true, cancelable:true }));
  ta.dispatchEvent(new CompositionEvent('compositionstart', { data:'' }));
  ta.value = '“';  // 预编辑/候选
  ta.dispatchEvent(new CompositionEvent('compositionupdate', { data:'“' }));
  ta.dispatchEvent(new CompositionEvent('compositionend', { data:'“' }));
  ta.value = '';
  await new Promise(r => setTimeout(r, 60));
  return { delivered: window.__delivered.slice(), comp: window.__compEvents.slice() };
});
console.log('\n=== C. simulated IME composition (compositionend 路径) ===');
console.log('  comp/input:', JSON.stringify(c.comp));
console.log('  delivered :', JSON.stringify(c.delivered));
console.log('  =>', c.delivered.includes('“') ? 'PASS' : 'FAIL');

await browser.close();
