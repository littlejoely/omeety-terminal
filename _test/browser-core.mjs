import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { rm } from "node:fs/promises"
import { BrowserCore } from "../host/src/browser-core/index.js"
import { AuditStore } from "../host/src/browser-core/audit-store.js"
import { PolicyEngine, redactAuditValue } from "../host/src/browser-core/policy-engine.js"
import { TargetRegistry } from "../host/src/browser-core/target-registry.js"

const root = path.join(os.tmpdir(), `omeety-browser-core-${process.pid}`)
const auditStore = new AuditStore({ filePath: path.join(root, "audit.jsonl"), maxBytes: 4096 })
const calls = []
const core = new BrowserCore({
  auditStore,
  dispatch: async (name, args) => {
    calls.push({ name, args })
    if (name === "omeety_open_tab") return { ok: true, result: { id: 22, url: args.url } }
    return { ok: true, result: { tabId: args.tabId || 17, url: args.url || "https://app.example.com/page", verified: true } }
  },
})

core.ingestEvent({ type: "tab.activated", tabId: 17 })
core.ingestEvent({ type: "tab.updated", tabId: 17, url: "https://app.example.com/page", title: "App" })
core.ingestEvent({ type: "frame.navigated", tabId: 17, frameId: "main", url: "https://app.example.com/page" })

const observed = await core.call("omeety_browser_observe", { tabId: 17, deep: false })
assert.equal(observed.ok, true)
assert.equal(calls.at(-1).name, "omeety_browser_observe")
assert.equal(observed.result.browserCore.version, 2)

await core.call("omeety_browser_act", { tabId: 17, action: "click", uid: "u1" })
assert.equal(calls.at(-1).name, "omeety_act_and_verify")
assert.equal(calls.at(-1).args.verify, true)

await core.call("omeety_browser_tabs", { operation: "open", url: "https://example.com" })
assert.equal(calls.at(-1).name, "omeety_open_tab")

core.updatePolicy({ mode: "read" })
const readAllowed = await core.call("omeety_get_context_bundle", { tabId: 17 })
assert.equal(readAllowed.ok, true)
const screenshotAllowed = await core.call("omeety_capture_visible_tab", { tabId: 17 })
assert.equal(screenshotAllowed.ok, true)
const blocked = await core.call("omeety_browser_act", { tabId: 17, action: "click", uid: "u1" })
assert.equal(blocked.ok, false)
assert.match(blocked.error, /只读/)

core.updatePolicy({ mode: "act" })
const blockedConfirmedSubmit = await core.call("omeety_browser_act", { tabId: 17, action: "click", text: "提交", confirmed: true })
assert.equal(blockedConfirmedSubmit.ok, false)
assert.match(blockedConfirmedSubmit.error, /提交模式/)

core.updatePolicy({ mode: "submit" })
await core.call("omeety_execute_js", { tabId: 17, code: "return window.secret", confirmed: true })
const audit = core.status({ includeAudit: true }).audit.at(-1)
assert.match(audit.args.code, /^\[redacted:/)
assert.equal(core.status().tabs[0].frameCount, 1)
assert.equal(core.status().totals.calls, 8)
assert.equal(core.status().totals.failures, 2)

const sensitiveAudit = redactAuditValue({
  action: "type",
  selector: "input[type=password]",
  text: "message-secret",
  value: "correct-horse-battery-staple",
  headers: { "X-Api-Key": "sk-live-secret", Accept: "application/json" },
  nested: { accessToken: "token-secret", valueEquals: "assertion-secret", note: "kept for diagnostics" },
  url: "https://alice:url-pass-secret@app.example.com/path?access_token=query-secret&view=compact#api_key=fragment-secret",
})
const serializedSensitiveAudit = JSON.stringify(sensitiveAudit)
for (const secret of ["message-secret", "correct-horse-battery-staple", "sk-live-secret", "token-secret", "assertion-secret", "url-pass-secret", "query-secret", "fragment-secret"]) {
  assert.doesNotMatch(serializedSensitiveAudit, new RegExp(secret))
}
assert.match(sensitiveAudit.text, /^\[redacted:/)
assert.match(sensitiveAudit.value, /^\[redacted:/)
assert.match(sensitiveAudit.headers, /^\[redacted:/)
assert.match(sensitiveAudit.nested.accessToken, /^\[redacted:/)
assert.match(sensitiveAudit.nested.valueEquals, /^\[redacted:/)
assert.equal(sensitiveAudit.nested.note, "kept for diagnostics")
assert.match(sensitiveAudit.url, /redacted/i)

await rm(root, { recursive: true, force: true })

const policy = new PolicyEngine()
policy.update({ mode: "act" })
assert.equal(policy.check("omeety_act_and_verify", { steps: [{ action: "click", text: "发送" }] }, "https://app.example.com").allowed, false)
policy.update({ mode: "submit" })
assert.deepEqual(policy.snapshot(), { mode: "submit" })
assert.equal(policy.check("omeety_list_tabs", {}, "https://outside.test").allowed, true)

const registry = new TargetRegistry()
registry.ingest({ type: "tab.updated", tabId: 1, windowId: 10, url: "https://one.example" })
registry.ingest({ type: "tab.activated", tabId: 1, windowId: 10, focused: true })
registry.ingest({ type: "tab.updated", tabId: 2, windowId: 20, url: "https://two.example" })
registry.ingest({ type: "tab.activated", tabId: 2, windowId: 20, focused: false })
assert.equal(registry.urlFor(), "https://one.example")
registry.ingest({ type: "window.focused", tabId: 2, windowId: 20 })
assert.equal(registry.urlFor(), "https://two.example")
assert.equal(registry.summary().find((tab) => tab.tabId === 2).focused, true)

console.log("PASS Browser Core: mapping + recursive policy + focused target registry + redacted audit")
