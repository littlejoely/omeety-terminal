import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const helperPath = join(root, "extension", "tool-runtime.js")
const helperSource = await readFile(helperPath, "utf8")

// Import the browser ESM helper as a data URL so this test does not require an
// extension/package.json solely to tell Node that .js is an ES module.
const helperUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`
const { buildPageEvaluationExpression, isTransientContentErrorMessage } = await import(helperUrl)
const { makeToolContent } = await import(new URL("../host/src/mcp-server.js", import.meta.url))

assert.equal(isTransientContentErrorMessage("The page moved into back/forward cache, message channel closed."), true)
assert.equal(isTransientContentErrorMessage("Could not establish connection. Receiving end does not exist."), true)
assert.equal(isTransientContentErrorMessage("SyntaxError: invalid selector"), false)

const success = await eval(buildPageEvaluationExpression("return { answer: await Promise.resolve(42) }"))
assert.deepEqual(success, { ok: true, value: '{"answer":42}' })

const failure = await eval(buildPageEvaluationExpression('throw new Error("expected failure")'))
assert.equal(failure.ok, false)
assert.match(failure.error, /expected failure/)

const imageContent = makeToolContent({
  title: "context bundle",
  screenshot: { dataUrl: "data:image/jpeg;base64,aGVsbG8=", width: 10 },
})
assert.equal(imageContent.length, 2)
assert.equal(imageContent[0].type, "text")
assert.doesNotMatch(imageContent[0].text, /base64,aGVsbG8=/)
assert.deepEqual(imageContent[1], { type: "image", mimeType: "image/jpeg", data: "aGVsbG8=" })

const background = await readFile(join(root, "extension", "background.js"), "utf8")
const content = await readFile(join(root, "extension", "content.js"), "utf8")
const sidepanel = await readFile(join(root, "extension", "sidepanel.js"), "utf8")
const terminal = await readFile(join(root, "extension", "terminal.js"), "utf8")
const host = await readFile(join(root, "host", "src", "index.js"), "utf8")
assert.doesNotMatch(background, /new\s+AsyncFunction|new\s+Function\s*\(/)
assert.match(background, /Runtime\.evaluate/)
assert.match(background, /waitForAcrossNavigation/)
assert.match(background, /buildContextBundle/)
assert.match(background, /actAndVerify/)
assert.match(background, /m\?\.type === "restart"/)
assert.match(content, /args\.probeOnly/)
assert.match(content, /finalizePageSnapshot/)
assert.match(content, /getContextBundle/)
assert.match(content, /setTimeout\(\(\) => element\.click\(\), 0\)/)
assert.match(sidepanel, /setSettingsOpen\(false\)/)
assert.match(sidepanel, /type: "restart"/)
assert.match(sidepanel, /type: "list_sessions"/)
assert.match(sidepanel, /msg\?\.type === "sessions_list"/)
assert.match(sidepanel, /t\.term\?\.setActive\?\.\(active\)/)
assert.match(sidepanel, /scheduleTabMeta/)
assert.match(terminal, /webglAddon\.dispose\(\)/)
assert.match(terminal, /setScrollback\(lines\)/)
assert.match(host, /case "restart"/)
assert.match(host, /case "list_sessions"/)
assert.match(host, /keepAliveMode === "30m"/)
assert.match(host, /msg\?\.type !== "session_meta"/)

console.log("PASS extension runtime: navigation guards + session recovery + inactive-tab renderer budget")
