#!/usr/bin/env node

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deflateRawSync } from "node:zlib"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, "..", "..")

// Runtime release contents are deliberately enumerated. New runtime files must be
// reviewed and added here; arbitrary workspace files are never copied.
const RELEASE_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "README.en.md",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/images/omeety-demo.gif",
  "docs/images/omeety-terminal.png",
  "extension/background.js",
  "extension/browser-adapter.js",
  "extension/cdp-input.js",
  "extension/content.css",
  "extension/content.js",
  "extension/manifest.json",
  "extension/offscreen.html",
  "extension/offscreen.js",
  "extension/output-replay-buffer.js",
  "extension/sidepanel.css",
  "extension/sidepanel.html",
  "extension/sidepanel.js",
  "extension/storage.js",
  "extension/terminal.js",
  "extension/tool-runtime.js",
  "extension/vendor/terminal.bundle.js",
  "extension/vendor/xterm.css",
  "host/bin/omeety.cmd",
  "host/bin/omeety.js",
  "host/package-lock.json",
  "host/package.json",
  "host/scripts/fix-node-pty-permissions.cjs",
  "host/scripts/package-release.mjs",
  "host/src/bootstrap.cjs",
  "host/src/browser-core/audit-store.js",
  "host/src/browser-core/index.js",
  "host/src/browser-core/policy-engine.js",
  "host/src/browser-core/target-registry.js",
  "host/src/download-manager.js",
  "host/src/index.js",
  "host/src/log.js",
  "host/src/mcp-server.js",
  "host/src/nm-stdio.js",
  "host/src/pty.js",
  "host/src/relay.js",
  "host/src/tools.meta.js",
  "installer/configure-agents.cjs",
  "installer/install.bat",
  "installer/install.ps1",
  "installer/install.sh",
  "installer/uninstall.bat",
  "installer/uninstall.ps1",
  "installer/uninstall.sh",
  "shared/protocol.md",
]

const REQUIRED_MODULES = [
  "@modelcontextprotocol/sdk/server/index.js",
  "@modelcontextprotocol/sdk/server/sse.js",
  "@modelcontextprotocol/sdk/server/streamableHttp.js",
  "@modelcontextprotocol/sdk/types.js",
  "express",
  "node-pty",
  "undici",
]
const FORBIDDEN_PARTS = new Set([".git", ".idea", ".vscode", "profile", "profile_copy", "user data", "__pycache__"])
const FORBIDDEN_BASENAMES = new Set([
  ".env", ".npmrc", "cookies", "host-debug.log", "host-manifest.json", "login data", "local state", "web data",
])
const FORBIDDEN_SUFFIXES = [".bak", ".key", ".log", ".p12", ".pem", ".pfx"]
const PRIVATE_KEY_BLOCK = /-----BEGIN ((?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY)-----[\r\n]+[A-Za-z0-9+/=\r\n]{64,}-----END \1-----/

function parseArgs(argv) {
  const options = { force: false, keepStage: false, outputDir: path.join(projectRoot, "dist") }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--force") options.force = true
    else if (arg === "--keep-stage") options.keepStage = true
    else if (arg === "--output-dir") {
      const value = argv[++index]
      if (!value) throw new Error("--output-dir requires a path")
      options.outputDir = path.resolve(projectRoot, value)
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run package:release -- [--force] [--output-dir PATH] [--keep-stage]")
      process.exit(0)
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function portable(relativePath) {
  return relativePath.split(path.sep).join("/")
}

function assertSafeRelativePath(relativePath) {
  const normalized = portable(path.normalize(relativePath)).replace(/^\.\//, "")
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error(`Unsafe release path: ${relativePath}`)
  }
  const parts = normalized.toLowerCase().split("/")
  const basename = parts.at(-1)
  if (parts.some((part) => FORBIDDEN_PARTS.has(part))) throw new Error(`Forbidden release path: ${normalized}`)
  if (FORBIDDEN_BASENAMES.has(basename) || basename.startsWith(".env.")) throw new Error(`Forbidden release file: ${normalized}`)
  if (FORBIDDEN_SUFFIXES.some((suffix) => basename.endsWith(suffix)) || basename.includes(".bak-")) {
    throw new Error(`Forbidden release file: ${normalized}`)
  }
  if (basename.startsWith("browser-audit.jsonl")) throw new Error(`Forbidden release file: ${normalized}`)
  return normalized
}

function isExecutable(relativePath, sourceMode = 0) {
  const normalized = portable(relativePath)
  return Boolean(sourceMode & 0o111)
    || normalized === "host/bin/omeety.js"
    || normalized === "installer/install.sh"
    || normalized === "installer/uninstall.sh"
}

async function copyAllowlistedFiles(destinationRoot) {
  for (const relativePath of RELEASE_FILES) {
    const normalized = assertSafeRelativePath(relativePath)
    const source = path.join(projectRoot, ...normalized.split("/"))
    const destination = path.join(destinationRoot, ...normalized.split("/"))
    const stat = await fs.lstat(source).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Missing or invalid allowlisted file: ${normalized}`)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
    if (isExecutable(normalized)) await fs.chmod(destination, 0o755).catch(() => {})
  }
}

async function walkFiles(root) {
  const files = []
  async function visit(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"))
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in release packages: ${relativePath}`)
      if (entry.isDirectory()) await visit(absolutePath, relativePath)
      else if (entry.isFile()) files.push({ absolutePath, relativePath: assertSafeRelativePath(relativePath) })
      else throw new Error(`Unsupported release entry: ${relativePath}`)
    }
  }
  await visit(root)
  return files
}

async function sha256File(filePath) {
  const hash = createHash("sha256")
  const handle = await fs.open(filePath, "r")
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk))
  } finally {
    await handle.close().catch(() => {})
  }
  return hash.digest("hex")
}

async function scanReleaseTree(root) {
  const files = await walkFiles(root)
  for (const file of files) {
    const extension = path.extname(file.relativePath).toLowerCase()
    if ([".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".sh", ".txt"].includes(extension)) {
      const stat = await fs.stat(file.absolutePath)
      if (stat.size <= 10 * 1024 * 1024) {
        const text = await fs.readFile(file.absolutePath, "utf8")
        if (PRIVATE_KEY_BLOCK.test(text)) throw new Error(`Private key material found in release file: ${file.relativePath}`)
      }
    }
  }
  return files
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, env: process.env, stdio: "inherit", windowsHide: true })
}

async function installCleanDependencies(packageRoot) {
  const hostRoot = path.join(packageRoot, "host")
  console.log("[2/6] Installing a clean production dependency tree from package-lock.json...")
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath) run(process.execPath, [npmExecPath, "ci", "--omit=dev", "--no-audit", "--no-fund"], hostRoot)
  else run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], hostRoot)
  await fs.rm(path.join(hostRoot, "node_modules", ".bin"), { recursive: true, force: true })
  const imports = REQUIRED_MODULES.map((name) => `import(${JSON.stringify(name)})`).join(",")
  run(process.execPath, ["--input-type=module", "-e", `await Promise.all([${imports}]); console.log("Host dependency load check passed")`], hostRoot)
}

async function gitSourceState() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", windowsHide: true }).trim()
    const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8", windowsHide: true }).trim())
    return { commit, dirty }
  } catch {
    return { commit: null, dirty: null }
  }
}

async function writePackageManifest(packageRoot, version) {
  const files = await scanReleaseTree(packageRoot)
  const entries = []
  for (const file of files) {
    const stat = await fs.stat(file.absolutePath)
    entries.push({ path: file.relativePath, bytes: stat.size, sha256: await sha256File(file.absolutePath) })
  }
  const manifest = {
    schemaVersion: 1,
    package: "omeety-terminal-offline",
    version,
    createdAt: new Date().toISOString(),
    source: await gitSourceState(),
    policy: "explicit-runtime-allowlist + clean npm ci --omit=dev",
    fileCount: entries.length,
    files: entries,
  }
  await fs.writeFile(path.join(packageRoot, "PACKAGE-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

async function createZip(sourceRoot, archivePath, archiveRootName) {
  const files = await walkFiles(sourceRoot)
  if (files.length >= 0xffff) throw new Error("ZIP64 is not supported: too many files")
  const output = await fs.open(archivePath, "wx")
  const central = []
  let offset = 0
  try {
    for (const file of files) {
      const raw = await fs.readFile(file.absolutePath)
      const compressed = deflateRawSync(raw, { level: 9 })
      const useDeflate = compressed.length < raw.length
      const payload = useDeflate ? compressed : raw
      const name = Buffer.from(`${archiveRootName}/${file.relativePath}`, "utf8")
      const stat = await fs.stat(file.absolutePath)
      const mode = isExecutable(file.relativePath, stat.mode) ? 0o100755 : 0o100644
      const checksum = crc32(raw)
      if (raw.length > 0xffffffff || payload.length > 0xffffffff || offset > 0xffffffff) throw new Error("ZIP64 is not supported: package is too large")

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0800, 6)
      local.writeUInt16LE(useDeflate ? 8 : 0, 8)
      local.writeUInt16LE(0, 10)
      local.writeUInt16LE(0x0021, 12)
      local.writeUInt32LE(checksum, 14)
      local.writeUInt32LE(payload.length, 18)
      local.writeUInt32LE(raw.length, 22)
      local.writeUInt16LE(name.length, 26)
      await output.write(local)
      await output.write(name)
      await output.write(payload)

      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50, 0)
      record.writeUInt16LE((3 << 8) | 20, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt16LE(0x0800, 8)
      record.writeUInt16LE(useDeflate ? 8 : 0, 10)
      record.writeUInt16LE(0, 12)
      record.writeUInt16LE(0x0021, 14)
      record.writeUInt32LE(checksum, 16)
      record.writeUInt32LE(payload.length, 20)
      record.writeUInt32LE(raw.length, 24)
      record.writeUInt16LE(name.length, 28)
      record.writeUInt32LE((mode << 16) >>> 0, 38)
      record.writeUInt32LE(offset, 42)
      central.push(Buffer.concat([record, name]))
      offset += local.length + name.length + payload.length
    }
    const centralOffset = offset
    for (const record of central) {
      await output.write(record)
      offset += record.length
    }
    const centralSize = offset - centralOffset
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(central.length, 8)
    end.writeUInt16LE(central.length, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(centralOffset, 16)
    await output.write(end)
  } finally {
    await output.close()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "host", "package.json"), "utf8"))
  const version = packageJson.version
  const archiveName = `omeety-terminal-v${version}-offline.zip`
  const archivePath = path.join(options.outputDir, archiveName)
  const checksumPath = `${archivePath}.sha256`
  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omeety-release-"))
  const packageRoot = path.join(stageRoot, "omeety-terminal")
  try {
    await fs.mkdir(options.outputDir, { recursive: true })
    for (const target of [archivePath, checksumPath]) {
      const exists = await fs.stat(target).then(() => true, () => false)
      if (exists && !options.force) throw new Error(`${target} already exists; pass --force to replace it`)
      if (exists) await fs.rm(target)
    }
    console.log("[1/6] Copying reviewed runtime files from the explicit allowlist...")
    await copyAllowlistedFiles(packageRoot)
    await installCleanDependencies(packageRoot)
    console.log("[3/6] Rejecting profiles, logs, local configuration, keys, backups, and symlinks...")
    await scanReleaseTree(packageRoot)
    console.log("[4/6] Writing per-file SHA-256 package manifest...")
    await writePackageManifest(packageRoot, version)
    await scanReleaseTree(packageRoot)
    console.log("[5/6] Creating portable ZIP with executable macOS installer bits...")
    await createZip(packageRoot, archivePath, "omeety-terminal")
    console.log("[6/6] Writing archive checksum...")
    const digest = await sha256File(archivePath)
    await fs.writeFile(checksumPath, `${digest}  ${archiveName}\n`, "utf8")
    const archiveStat = await fs.stat(archivePath)
    console.log(`\nCreated: ${archivePath}`)
    console.log(`SHA-256: ${digest}`)
    console.log(`Size: ${(archiveStat.size / 1024 / 1024).toFixed(2)} MiB`)
    if (options.keepStage) console.log(`Staging directory kept at: ${stageRoot}`)
  } catch (error) {
    await fs.rm(archivePath, { force: true }).catch(() => {})
    await fs.rm(checksumPath, { force: true }).catch(() => {})
    throw error
  } finally {
    if (!options.keepStage) await fs.rm(stageRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`Release packaging failed: ${error.message}`)
  process.exitCode = 1
})
