import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const source = await readFile(join(root, "extension", "output-replay-buffer.js"), "utf8")
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
const { OutputReplayBuffer } = await import(moduleUrl)

const replay = new OutputReplayBuffer(10)
replay.push("a", "1234")
replay.push("b", "xy")
replay.push("a", "5678")
assert.equal(replay.read("a"), "12345678")
replay.push("b", "zzzz")
assert.equal(replay.read("a"), "5678")
assert.equal(replay.read("b"), "xyzzzz")

// Thousands of single-character chunks exercise logical-head compaction while
// retaining exactly the latest bounded suffix.
const noisy = new OutputReplayBuffer(64)
for (let i = 0; i < 5000; i++) noisy.push("term", String(i % 10))
assert.equal(noisy.read("term").length, 64)
assert.ok(noisy.entryCount <= 64)

// A single oversized native chunk is kept intact, matching the old replay
// behavior (never discard the newest/only output record).
const oversized = new OutputReplayBuffer(4)
oversized.push("term", "abcdefgh")
assert.equal(oversized.read("term"), "abcdefgh")

console.log("PASS output replay buffer: bounded amortized-O(1) eviction")
