const MAX_EVENTS = 500

export class TargetRegistry {
  constructor() {
    this.tabs = new Map()
    this.events = []
    this.focusedTabId = null
  }

  ingest(event = {}) {
    const type = String(event.type || "unknown")
    const tabId = Number(event.tabId)
    const at = Number(event.at) || Date.now()
    const normalized = { ...event, type, at }
    this.events.push(normalized)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)

    if (!Number.isInteger(tabId) || tabId <= 0) return
    if (type === "tab.removed") {
      this.tabs.delete(tabId)
      if (this.focusedTabId === tabId) this.focusedTabId = null
      return
    }
    const current = this.tabs.get(tabId) || {
      tabId,
      active: false,
      attached: false,
      documentEpoch: 0,
      frames: new Map(),
      targets: new Map(),
      windowId: Number.isInteger(Number(event.windowId)) ? Number(event.windowId) : null,
    }
    if (type === "tab.activated") {
      const windowId = Number.isInteger(Number(event.windowId)) ? Number(event.windowId) : current.windowId
      for (const tab of this.tabs.values()) if (tab.windowId === windowId) tab.active = false
      current.windowId = windowId
      current.active = true
      if (event.focused) this.focusedTabId = tabId
    }
    if (type === "window.focused") {
      this.focusedTabId = tabId
      current.active = true
    }
    if (type === "tab.updated") {
      if (event.url && event.url !== current.url) current.documentEpoch += 1
      Object.assign(current, {
        url: event.url ?? current.url,
        title: event.title ?? current.title,
        status: event.status ?? current.status,
        windowId: Number.isInteger(Number(event.windowId)) ? Number(event.windowId) : current.windowId,
      })
    }
    if (type === "cdp.attached") current.attached = true
    if (type === "cdp.detached") {
      current.attached = false
      current.frames.clear()
      current.targets.clear()
    }
    if (type === "frame.navigated" || type === "frame.attached") {
      const frameId = String(event.frameId || "")
      if (frameId) current.frames.set(frameId, { ...event, frameId, at })
      if (type === "frame.navigated" && !event.parentFrameId) current.documentEpoch += 1
    }
    if (type === "frame.detached") current.frames.delete(String(event.frameId || ""))
    if (type === "target.attached") {
      const targetId = String(event.targetId || "")
      if (targetId) current.targets.set(targetId, { ...event, targetId, at })
    }
    if (type === "target.detached") current.targets.delete(String(event.targetId || ""))
    current.lastEventAt = at
    this.tabs.set(tabId, current)
  }

  observeResult(result = {}) {
    const tabId = Number(result.tabId)
    if (!Number.isInteger(tabId) || tabId <= 0) return
    const current = this.tabs.get(tabId) || {
      tabId,
      active: false,
      attached: false,
      documentEpoch: 0,
      frames: new Map(),
      targets: new Map(),
    }
    if (result.url && result.url !== current.url) current.documentEpoch += 1
    current.url = result.url ?? current.url
    current.title = result.title ?? current.title
    current.snapshotId = result.snapshotId ?? current.snapshotId
    current.lastObservedAt = Date.now()
    this.tabs.set(tabId, current)
  }

  summary() {
    return [...this.tabs.values()].map((tab) => ({
      tabId: tab.tabId,
      active: tab.active,
      focused: tab.tabId === this.focusedTabId,
      windowId: tab.windowId,
      attached: tab.attached,
      url: tab.url,
      title: tab.title,
      status: tab.status,
      documentEpoch: tab.documentEpoch,
      frameCount: tab.frames.size,
      targetCount: tab.targets.size,
      lastObservedAt: tab.lastObservedAt,
      lastEventAt: tab.lastEventAt,
    }))
  }

  recentEvents(limit = 50) {
    const count = Math.min(Math.max(Number(limit) || 50, 1), MAX_EVENTS)
    return this.events.slice(-count)
  }

  urlFor(tabId) {
    const requested = Number(tabId)
    if (Number.isInteger(requested) && this.tabs.has(requested)) return this.tabs.get(requested).url || null
    if (this.focusedTabId && this.tabs.has(this.focusedTabId)) return this.tabs.get(this.focusedTabId).url || null
    return null
  }
}
