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

assert.equal(isTransientContentErrorMessage("The page moved into back/forward cache, message channel closed."), true)
assert.equal(isTransientContentErrorMessage("Could not establish connection. Receiving end does not exist."), true)
assert.equal(isTransientContentErrorMessage("SyntaxError: invalid selector"), false)

const success = await eval(buildPageEvaluationExpression("return { answer: await Promise.resolve(42) }"))
assert.deepEqual(success, { ok: true, value: '{"answer":42}' })

const failure = await eval(buildPageEvaluationExpression('throw new Error("expected failure")'))
assert.equal(failure.ok, false)
assert.match(failure.error, /expected failure/)

const background = await readFile(join(root, "extension", "background.js"), "utf8")
const content = await readFile(join(root, "extension", "content.js"), "utf8")
const sidepanel = await readFile(join(root, "extension", "sidepanel.js"), "utf8")
const host = await readFile(join(root, "host", "src", "index.js"), "utf8")
assert.doesNotMatch(background, /new\s+AsyncFunction|new\s+Function\s*\(/)
assert.match(background, /Runtime\.evaluate/)
assert.match(background, /waitForAcrossNavigation/)
assert.match(background, /m\?\.type === "restart"/)
assert.match(content, /args\.probeOnly/)
assert.match(content, /setTimeout\(\(\) => element\.click\(\), 0\)/)
assert.match(sidepanel, /setSettingsOpen\(false\)/)
assert.match(sidepanel, /type: "restart"/)
assert.match(host, /case "restart"/)

console.log("PASS extension runtime: CSP/navigation guards + atomic settings reconnect protocol")
