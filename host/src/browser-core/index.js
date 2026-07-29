import { performance } from "node:perf_hooks"
import { AuditStore } from "./audit-store.js"
import { PolicyEngine } from "./policy-engine.js"
import { TargetRegistry } from "./target-registry.js"

const HIGH_LEVEL_MAP = new Map([
  ["omeety_browser_observe", "omeety_browser_observe"],
  ["omeety_browser_query", "omeety_browser_query"],
  ["omeety_browser_act", "omeety_act_and_verify"],
  ["omeety_browser_transaction", "omeety_act_and_verify"],
  ["omeety_browser_wait", "omeety_wait_for"],
])

function resolveHighLevelCall(name, args) {
  if (name === "omeety_browser_tabs") {
    const operation = String(args.operation || "list")
    const tools = { list: "omeety_list_tabs", open: "omeety_open_tab", switch: "omeety_switch_tab", close: "omeety_close_tab" }
    return { name: tools[operation] || tools.list, args }
  }
  if (name === "omeety_browser_transaction") return { name: "omeety_act_and_verify", args: { ...args, steps: args.steps || [] } }
  if (name === "omeety_browser_act") return { name: "omeety_act_and_verify", args: { ...args, verify: args.verify !== false } }
  return { name: HIGH_LEVEL_MAP.get(name) || name, args }
}

export class BrowserCore {
  constructor({ dispatch, auditStore = new AuditStore() }) {
    this.dispatch = dispatch
    this.audit = auditStore
    this.policy = new PolicyEngine()
    this.targets = new TargetRegistry()
    this.startedAt = Date.now()
    this.calls = 0
    this.successes = 0
    this.failures = 0
    this.totalMs = 0
    this.byTool = new Map()
  }

  ingestEvent(event) {
    this.targets.ingest(event)
  }

  updatePolicy(policy) {
    return this.policy.update(policy)
  }

  status({ includeEvents = false, includeAudit = false } = {}) {
    const tabs = this.targets.summary()
    return {
      version: 2,
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      policy: this.policy.snapshot(),
      totals: {
        calls: this.calls,
        successes: this.successes,
        failures: this.failures,
        averageMs: this.calls ? Math.round((this.totalMs / this.calls) * 10) / 10 : 0,
      },
      tools: [...this.byTool.entries()].map(([name, item]) => ({ name, ...item })).sort((a, b) => b.calls - a.calls),
      tabs,
      ...(includeEvents ? { events: this.targets.recentEvents() } : {}),
      ...(includeAudit ? { audit: this.audit.list() } : {}),
    }
  }

  async call(name, args = {}) {
    if (name === "omeety_browser_status") return { ok: true, result: this.status(args) }
    const resolved = resolveHighLevelCall(name, args || {})
    const mappedName = resolved.name
    const mappedArgs = resolved.args
    const policy = this.policy.check(mappedName, mappedArgs)
    if (!policy.allowed) {
      this.record(mappedName, false, 0)
      this.audit.append({
        kind: "browser.policy",
        requestedTool: name,
        executedTool: mappedName,
        args: mappedArgs,
        ok: false,
        error: policy.reason,
        tabId: mappedArgs.tabId,
        elapsedMs: 0,
      })
      return { ok: false, error: policy.reason }
    }

    const started = performance.now()
    let response
    try {
      response = await this.dispatch(mappedName, mappedArgs)
    } catch (error) {
      response = { ok: false, error: String(error?.message || error) }
    }
    const elapsedMs = Math.round((performance.now() - started) * 10) / 10
    const semanticSuccess = Boolean(response?.ok && response?.result?.completed !== false && response?.result?.verified !== false)
    this.record(mappedName, semanticSuccess, elapsedMs)
    if (response?.result && typeof response.result === "object") this.targets.observeResult(response.result)
    this.audit.append({
      kind: "browser.tool",
      requestedTool: name,
      executedTool: mappedName,
      args: mappedArgs,
      ok: semanticSuccess,
      error: response?.error,
      tabId: response?.result?.tabId ?? mappedArgs.tabId,
      elapsedMs,
    })
    if (response?.ok && response.result && typeof response.result === "object") {
      response.result.browserCore = { version: 2, elapsedMs, policy: this.policy.mode }
    }
    return response
  }

  record(name, ok, elapsedMs) {
    this.calls += 1
    this.totalMs += elapsedMs
    if (ok) this.successes += 1
    else this.failures += 1
    const current = this.byTool.get(name) || { calls: 0, successes: 0, failures: 0, totalMs: 0, maxMs: 0 }
    current.calls += 1
    current.totalMs += elapsedMs
    current.maxMs = Math.max(current.maxMs, elapsedMs)
    if (ok) current.successes += 1
    else current.failures += 1
    current.averageMs = Math.round((current.totalMs / current.calls) * 10) / 10
    this.byTool.set(name, current)
  }
}
