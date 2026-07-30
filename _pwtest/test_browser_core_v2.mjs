import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, realpathSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "extension")
const EXTENSION_ID = "fjhjkmpldbepgcpfkhpolnnheccjaamg"
const RESULT = path.join(ROOT, "_pwtest", "browser-core-v2.local.json")
const PANEL_SCREENSHOT = path.join(ROOT, "_pwtest", "browser-core-v2-panel.png")

async function loadPlaywright() {
  try {
    return await import("playwright")
  } catch {
    const bin = execFileSync("/usr/bin/which", ["playwright"], { encoding: "utf8" }).trim()
    const moduleRoot = path.dirname(path.dirname(realpathSync(bin)))
    const candidates = [path.join(moduleRoot, "index.mjs")]
    const nvmRoot = path.join(os.homedir(), ".nvm", "versions", "node")
    if (existsSync(nvmRoot)) {
      for (const version of readdirSync(nvmRoot).reverse()) candidates.push(path.join(nvmRoot, version, "lib", "node_modules", "playwright", "index.mjs"))
    }
    const entry = candidates.find(existsSync)
    if (!entry) throw new Error("Playwright Node module not found")
    return await import(pathToFileURL(entry))
  }
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

const childServer = await listen((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" })
  res.end("<!doctype html><title>Child</title><button id='child'>Child action</button><script>window.crossOriginClicks=0;document.querySelector('#child').addEventListener('click',()=>window.crossOriginClicks+=1)</script>")
})
const childPort = childServer.address().port
const mainServer = await listen((req, res) => {
  if (req.url === "/app.js") {
    res.writeHead(200, { "content-type": "text/javascript" })
    res.end("if(localStorage.getItem('durable')==='1')document.querySelector('#persist-status').textContent='saved-durable';document.addEventListener('click',e=>{if(e.target.id==='stable')document.querySelector('#status').textContent='clicked';if(e.target.closest('#contact-card'))document.querySelector('#contact-status').textContent='contact-clicked';if(e.target.closest('#conversation')){document.querySelector('#conversation').setAttribute('aria-selected','true');document.querySelector('#conversation').classList.add('is-selected');document.querySelector('#conversation-title').textContent='Alice'};if(e.target.closest('#send')){const editor=document.querySelector('#editor');const text=editor.innerText.replace(/[\\u200B-\\u200D\\uFEFF]/g,'').trim();editor.innerHTML='<p><br></p>';document.querySelector('#messages').insertAdjacentHTML('beforeend','<div class=message>'+text.replace(/</g,'&lt;')+'</div>')};if(e.target.id==='persist'){localStorage.setItem('durable','1');document.querySelector('#persist-status').textContent='saved-durable'}});document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k')document.querySelector('#shortcut-status').textContent='shortcut-open'})")
    return
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'self' http://localhost:*; script-src 'self'; frame-src http://localhost:*",
  })
  const denseControls = Array.from({ length: 40 }, (_, index) => `<section class="workspace"><div class="toolbar"><div class="action-slot"><button id="action-${index}">Action ${index}</button></div></div></section>`).join("")
  res.end(`<!doctype html><title>Browser Core v2</title><button id="stable" aria-label="Save record">Save record</button><div id="status">idle</div><div id="contact-card" class="contact-card" style="cursor:pointer"><span class="contact-name">王宇楠</span></div><div id="contact-status">idle</div><div id="conversation" role="tab" aria-selected="false"><span>Alice</span></div><div id="conversation-title">Inbox</div><div id="editor" role="textbox" contenteditable="true"><p><br></p></div><button id="send"><svg data-icon="SendColorful"><title>Send message</title></svg></button><div id="messages"></div><input id="shortcut"><div id="shortcut-status">idle</div><button id="noop">No-op</button><div id="already">already-there</div><button id="persist">Persist</button><div id="persist-status">idle</div>${denseControls}<iframe src="http://localhost:${childPort}/"></iframe><script src="/app.js"></script>`)
})

const profile = await mkdtemp(path.join(os.tmpdir(), "omeety-browser-core-v2-"))
const url = `http://127.0.0.1:${mainServer.address().port}/`
let context
try {
  const { chromium } = await loadPlaywright()
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      "--enable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--site-per-process",
    ],
  })
  const page = await context.newPage()
  await page.goto(url, { waitUntil: "networkidle" })
  let workers = context.serviceWorkers()
  if (!workers.length) {
    await context.waitForEvent("serviceworker", { timeout: 10_000 })
    workers = context.serviceWorkers()
  }
  const worker = workers[0]

  const testTabId = await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === url)
    if (!tab) throw new Error("test tab missing")
    return tab.id
  }, url)

  const contentTool = (name, args) => worker.evaluate(async ({ tabId, name, args }) => {
    return await chrome.tabs.sendMessage(tabId, { type: "omeety_execute_tool", tool: name, arguments: args })
  }, { tabId: testTabId, name, args })

  const snapshot = await contentTool("omeety_get_page_snapshot", { maxInteractive: 50 })
  const target = snapshot.interactive.find((item) => item.text === "Save record")
  assert.ok(target?.uid, snapshot)
  await page.evaluate(() => {
    document.querySelector("#stable").outerHTML = '<button id="stable" aria-label="Save record">Save record</button>'
  })
  const clicked = await contentTool("omeety_click", { uid: target.uid, confirmed: true })
  await page.waitForFunction(() => document.querySelector("#status").textContent === "clicked")
  const after = await contentTool("omeety_get_page_snapshot", { maxInteractive: 50 })
  assert.equal(clicked.clicked, true)
  assert.ok(after.locatorRecovery.recovered >= 1, after.locatorRecovery)

  const query = await contentTool("omeety_browser_query", { query: "save record", role: "button" })
  assert.ok(query.count >= 1, JSON.stringify(query))
  assert.equal(query.matches[0].uid, target.uid)

  const contactQuery = await contentTool("omeety_browser_query", { query: "王宇楠" })
  assert.ok(contactQuery.count >= 1, JSON.stringify(contactQuery))
  assert.equal(contactQuery.matches[0].locator.id, "contact-card")
  assert.equal(contactQuery.matches[0].promotedFrom, "span")
  const semanticQueryStarted = performance.now()
  for (let index = 0; index < 100; index += 1) await contentTool("omeety_browser_query", { query: "王宇楠", limit: 5 })
  const semanticQueryAverageMs = (performance.now() - semanticQueryStarted) / 100
  assert.ok(semanticQueryAverageMs < 15, `semantic query average ${semanticQueryAverageMs.toFixed(2)}ms`)
  await contentTool("omeety_click", { uid: contactQuery.matches[0].uid, confirmed: true })
  await page.waitForFunction(() => document.querySelector("#contact-status").textContent === "contact-clicked")

  const shortcut = await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === url)
    return await globalThis.__omeetyActAndVerify(tab.id, { action: "press", selector: "#shortcut", key: "k", modifiers: ["Meta"], cdp: true, verify: false })
  }, url)
  assert.deepEqual(shortcut.result.action.result.modifiers, ["Meta"])
  assert.equal(shortcut.result.completionLevel, "dispatched")
  await page.waitForFunction(() => document.querySelector("#shortcut-status").textContent === "shortcut-open")

  let legacyUidHits = 0
  let browserCoreHits = 0
  const recoveryStarted = performance.now()
  for (let index = 0; index < 100; index += 1) {
    await page.evaluate(() => {
      document.querySelector("#stable").outerHTML = '<button id="stable" aria-label="Save record">Save record</button>'
    })
    legacyUidHits += await page.locator(`[data-omeety-uid="${target.uid}"]`).count() ? 1 : 0
    const state = await contentTool("omeety_get_verification_state", { uid: target.uid })
    if (state.target?.exists) browserCoreHits += 1
  }
  const recoveryMs = performance.now() - recoveryStarted
  assert.equal(legacyUidHits, 0)
  assert.equal(browserCoreHits, 100)

  const fullSnapshot = await contentTool("omeety_get_page_snapshot", { maxInteractive: 50 })
  const compactSnapshot = await contentTool("omeety_get_page_snapshot", { maxInteractive: 50, profile: "compact" })
  const unchangedSnapshot = await contentTool("omeety_get_page_snapshot", { maxInteractive: 50, sinceSnapshotId: fullSnapshot.snapshotId })
  const profileMismatchSnapshot = await contentTool("omeety_get_page_snapshot", { maxInteractive: 50, profile: "compact", sinceSnapshotId: fullSnapshot.snapshotId })
  const fullBytes = JSON.stringify(fullSnapshot).length
  const compactBytes = JSON.stringify(compactSnapshot).length
  const unchangedBytes = JSON.stringify(unchangedSnapshot).length
  assert.equal(unchangedSnapshot.unchanged, true)
  assert.equal(profileMismatchSnapshot.incremental, false)
  assert.match(profileMismatchSnapshot.incrementalFallback, /mismatch/)
  assert.ok(compactBytes < fullBytes * 0.65, JSON.stringify({ compactBytes, fullBytes }))
  assert.equal("selector" in compactSnapshot.interactive[0], false)
  assert.equal("selector" in compactSnapshot.interactive[0].locator, false)

  const preexisting = await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === url)
    return await globalThis.__omeetyActAndVerify(tab.id, { action: "click", selector: "#noop", confirmed: true, expect: { text: "already-there" }, timeoutMs: 2000 })
  }, url)
  assert.equal(preexisting.result.verified, false, JSON.stringify(preexisting))
  assert.equal(preexisting.result.verificationStrength, "precondition-already-satisfied")

  const conversation = await worker.evaluate(async (tabId) => {
    return await globalThis.__omeetyActAndVerify(tabId, { action: "click", selector: "#conversation", confirmed: true, expect: { text: "Alice" }, timeoutMs: 2000 })
  }, testTabId)
  assert.equal(conversation.result.verified, true, JSON.stringify(conversation))
  assert.equal(conversation.result.verificationStrength, "target-state-transition")
  assert.equal(conversation.result.after.target.selected, true)

  await page.evaluate(() => { document.querySelector("#editor").innerHTML = "<p>Hello\u200b</p><p>World</p>" })
  const richText = await contentTool("omeety_wait_for", { targetSelector: "#editor", valueEquals: "Hello\nWorld", probeOnly: true })
  assert.equal(richText.found, true, JSON.stringify(richText))
  const semanticSnapshot = await contentTool("omeety_get_page_snapshot", { maxInteractive: 80 })
  const sendButton = semanticSnapshot.interactive.find((item) => item.text === "SendColorful")
  assert.ok(sendButton?.uid, JSON.stringify(semanticSnapshot.interactive))
  const sent = await worker.evaluate(async ({ tabId, uid }) => {
    return await globalThis.__omeetyActAndVerify(tabId, {
      action: "click",
      uid,
      confirmed: true,
      expect: { targetSelector: "#editor", valueEquals: "", text: "Hello", match: "all" },
      timeoutMs: 2000,
    })
  }, { tabId: testTabId, uid: sendButton.uid })
  assert.equal(sent.result.verified, true, JSON.stringify(sent))
  assert.equal((await page.locator("#editor").innerText()).trim(), "")
  assert.match(await page.locator("#messages").innerText(), /Hello.*World/s)

  const durable = await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === url)
    return await globalThis.__omeetyActAndVerify(tab.id, {
      action: "click",
      selector: "#persist",
      confirmed: true,
      expect: { text: "saved-durable", persistAfterReload: true },
      timeoutMs: 5000,
    })
  }, url)
  assert.equal(durable.result.completionLevel, "committed", JSON.stringify(durable))
  assert.equal(durable.result.committed, true)
  await page.waitForLoadState("domcontentloaded")

  const deep = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((item) => item.url === url)
    return await globalThis.__omeetyBrowserAdapterObserve(tab.id, { maxAccessibilityNodes: 100 })
  }, url)
  console.log(JSON.stringify(deep, null, 2))
  assert.ok(deep.dom.nodeCount > 0, JSON.stringify(deep))
  assert.ok(deep.accessibility.totalNodes > 0, JSON.stringify(deep))
  assert.ok(deep.frames.length >= 2, JSON.stringify(deep))

  const foreground = await context.newPage()
  await foreground.goto("about:blank")
  await foreground.bringToFront()
  const backgroundCapture = await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === url)
    return await globalThis.__omeetyCaptureTab(tab.id, { maxWidth: 640 })
  }, url)
  assert.equal(backgroundCapture.ok, true, JSON.stringify(backgroundCapture))
  assert.equal(backgroundCapture.result.transport, "cdp:Page.captureScreenshot")
  assert.match(backgroundCapture.result.dataUrl, /^data:image\/jpeg;base64,/)
  await foreground.close()

  // A UID observed on origin A must produce zero clicks after the same tab moves
  // to origin B, even when both documents have their own first interactive node.
  await page.goto(`http://localhost:${childPort}/`, { waitUntil: "domcontentloaded" })
  const staleUid = await worker.evaluate(async ({ tabId, uid }) => {
    return await globalThis.__omeetyActAndVerify(tabId, { action: "click", uid, confirmed: true, verify: false })
  }, { tabId: testTabId, uid: target.uid })
  assert.equal(staleUid.ok, false, JSON.stringify(staleUid))
  assert.match(staleUid.error, /页面上下文已失效|另一个页面文档|不存在或已失效/)
  assert.equal(await page.evaluate(() => window.crossOriginClicks), 0)

  const panel = await context.newPage()
  await panel.setViewportSize({ width: 420, height: 780 })
  await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`, { waitUntil: "domcontentloaded" })
  await panel.locator("#ackBtn").click().catch(() => {})
  await panel.locator("#settingsToggle").click()
  await panel.locator("#browserPermissionSelect").waitFor({ state: "visible" })
  const ui = await panel.evaluate(() => {
    const rect = document.getElementById("statusText").getBoundingClientRect()
    const statusText = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width }
    return {
      statusText,
      withinViewport: statusText.left >= 0 && statusText.right <= innerWidth,
      permissionVisible: !!document.getElementById("browserPermissionSelect").offsetParent,
      compactControlsRemoved: !document.getElementById("browserMode") && !document.getElementById("stopBrowser"),
    }
  })
  assert.equal(ui.withinViewport, true, JSON.stringify(ui))
  assert.equal(ui.permissionVisible, true, JSON.stringify(ui))
  assert.equal(ui.compactControlsRemoved, true, JSON.stringify(ui))
  await panel.screenshot({ path: PANEL_SCREENSHOT })

  const result = {
    stableLocator: fullSnapshot.locatorRecovery,
    locatorBenchmark: {
      iterations: 100,
      legacyHits: legacyUidHits,
      browserCoreHits,
      recoveryRate: browserCoreHits / 100,
      averageRecoveryMs: Math.round((recoveryMs / 100) * 100) / 100,
    },
    incrementalSnapshot: {
      fullBytes,
      compactBytes,
      compactReductionPercent: Math.round((1 - compactBytes / fullBytes) * 1000) / 10,
      unchangedBytes,
      reductionPercent: Math.round((1 - unchangedBytes / fullBytes) * 1000) / 10,
    },
    queryTopScore: query.matches[0].score,
    semanticQuery: { promotedFrom: contactQuery.matches[0].promotedFrom, queryMs: contactQuery.metrics.queryMs, roundTripAverageMs: Math.round(semanticQueryAverageMs * 100) / 100 },
    durableAction: { completionLevel: durable.result.completionLevel, verificationStrength: durable.result.verificationStrength },
    preexistingCondition: { verified: preexisting.result.verified, verificationStrength: preexisting.result.verificationStrength },
    domNodes: deep.dom.nodeCount,
    layoutNodes: deep.dom.layoutNodeCount,
    accessibilityNodes: deep.accessibility.totalNodes,
    frames: deep.frames.length,
    adapterTargets: deep.targets.length,
    backgroundCapture: { transport: backgroundCapture.result.transport, width: backgroundCapture.result.image.width, height: backgroundCapture.result.image.height },
    ui,
  }
  await writeFile(RESULT, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  console.log("PASS Browser Core v2 real Chromium")
} finally {
  await context?.close().catch(() => {})
  await new Promise((resolve) => mainServer.close(resolve))
  await new Promise((resolve) => childServer.close(resolve))
  await rm(profile, { recursive: true, force: true })
}
