const DANGEROUS_RE = /(提交|保存|删除|作废|下架|审核|确认|同意|拒绝|取消|支付|购买|发送|退出|approve|submit|delete|remove|confirm|accept|reject|cancel|pay|purchase|send|logout)/i
const READ_TOOLS = new Set([
  "omeety_browser_observe",
  "omeety_browser_query",
  "omeety_browser_wait",
  "omeety_browser_status",
  "omeety_list_tabs",
  "omeety_wait_for",
])

function transactionSteps(args) {
  return Array.isArray(args?.steps) ? args.steps.filter((step) => step && typeof step === "object") : []
}

export class PolicyEngine {
  constructor() {
    this.mode = "submit"
  }

  update(policy = {}) {
    if (["read", "act", "submit"].includes(policy.mode)) this.mode = policy.mode
    return this.snapshot()
  }

  snapshot() {
    return { mode: this.mode }
  }

  check(name, args = {}) {
    const action = String(args.action || "")
    const steps = transactionSteps(args)
    const text = [name, action, args.text, args.value, args.code, ...steps.flatMap((step) => [step.action, step.text, step.value, step.code])].filter(Boolean).join(" ")
    const method = String(args.method || "GET").toUpperCase()
    const transactionReadOnly = steps.length > 0 && steps.every((step) => step.action === "wait")
    const readOnly = name.startsWith("omeety_get_") || READ_TOOLS.has(name) || name === "omeety_capture_visible_tab" || (name === "omeety_fetch_with_cookie" && ["GET", "HEAD"].includes(method)) || action === "wait" || transactionReadOnly
    const dangerous = Boolean(args.confirmed || steps.some((step) => step.confirmed) || DANGEROUS_RE.test(text))
    if (this.mode === "read" && !readOnly) {
      return { allowed: false, reason: "Browser Core 当前为只读模式" }
    }
    if (this.mode === "act" && dangerous) {
      return { allowed: false, reason: "Browser Core 当前禁止提交类操作；请先切换为提交模式" }
    }
    return { allowed: true, readOnly, dangerous }
  }
}

const AUDIT_SECRET_KEY_RE = /cookie|authorization|token|secret|password|passwd|api[-_]?key|access[-_]?key|credential|private[-_]?key/i
// MCP 参数里的自由文本默认视为敏感负载。审计保留动作、目标和长度，
// 不保留用户输入、断言值、提示内容、HTML/JS 或远端错误原文。
const AUDIT_PAYLOAD_KEY_RE = /^(?:body|code|expression|headers?|value.*|text.*|message|detail|query|html|appendHtml|beforeHtml|afterHtml|error)$/i
const AUDIT_URL_KEY_RE = /(?:^|[-_])(?:url|href)$/i

function auditLength(value) {
  if (typeof value === "string") return value.length
  try { return JSON.stringify(value ?? "").length } catch { return String(value ?? "").length }
}

function redacted(value) {
  return `[redacted:${auditLength(value)}]`
}

function redactUrl(raw) {
  const value = String(raw || "")
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
  try {
    const url = new URL(value, "https://audit.invalid")
    if (url.username) url.username = redacted(url.username)
    if (url.password) url.password = redacted(url.password)
    // URL 查询值可能是签名、一次性令牌或用户内容，参数名本身并不足以可靠判断。
    // 全部隐藏值但保留参数名，仍可用于定位是哪条路由/哪类请求。
    for (const [name, child] of [...url.searchParams.entries()]) url.searchParams.set(name, redacted(child))
    if (url.hash.includes("=")) {
      const params = new URLSearchParams(url.hash.slice(1))
      let changed = false
      for (const [name, child] of [...params.entries()]) {
        params.set(name, redacted(child))
        changed = true
      }
      if (changed) url.hash = params.toString()
    }
    return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`
  } catch {
    return value.length > 500 ? `${value.slice(0, 500)}...[${value.length}]` : value
  }
}

export function redactAuditValue(value, key = "") {
  if (AUDIT_SECRET_KEY_RE.test(key) || AUDIT_PAYLOAD_KEY_RE.test(key)) return redacted(value)
  if (typeof value === "string" && AUDIT_URL_KEY_RE.test(key)) return redactUrl(value)
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}...[${value.length}]` : value
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactAuditValue(item))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactAuditValue(child, childKey)]))
  }
  return value
}
