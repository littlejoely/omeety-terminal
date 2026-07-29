const MAX_AX_NODES = 500

function valueOf(axValue) {
  return axValue && typeof axValue === "object" ? axValue.value ?? null : axValue ?? null
}

function flattenFrameTree(tree, out = []) {
  if (!tree?.frame) return out
  out.push({
    id: tree.frame.id,
    parentId: tree.frame.parentId || null,
    url: tree.frame.url,
    name: tree.frame.name || null,
    securityOrigin: tree.frame.securityOrigin || null,
  })
  for (const child of tree.childFrames || []) flattenFrameTree(child, out)
  return out
}

export class BrowserAdapter {
  constructor({ sendCommand, emit }) {
    this.sendCommand = sendCommand
    this.emit = emit
    this.configuredTabs = new Set()
    this.frames = new Map()
    this.targets = new Map()
  }

  async configure(tabId) {
    if (this.configuredTabs.has(tabId)) return
    await this.sendCommand({ tabId }, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [
        { type: "iframe", exclude: false },
        { type: "worker", exclude: false },
        { type: "shared_worker", exclude: false },
        { type: "service_worker", exclude: false },
      ],
    }).catch(() => null)
    this.configuredTabs.add(tabId)
    this.emit({ type: "cdp.attached", tabId, at: Date.now() })
  }

  async onEvent(source, method, params = {}) {
    const tabId = source?.tabId
    if (!Number.isInteger(tabId)) return
    if (method === "Target.attachedToTarget") {
      const child = { ...source, sessionId: params.sessionId }
      const info = params.targetInfo || {}
      this.targets.set(`${tabId}:${params.sessionId}`, { ...info, sessionId: params.sessionId })
      this.emit({ type: "target.attached", tabId, sessionId: params.sessionId, targetId: info.targetId, targetType: info.type, url: info.url, at: Date.now() })
      await Promise.allSettled([
        this.sendCommand(child, "Runtime.enable", {}),
        this.sendCommand(child, "Page.enable", {}),
        this.sendCommand(child, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }],
        }),
      ])
      return
    }
    if (method === "Target.detachedFromTarget") {
      const key = `${tabId}:${params.sessionId}`
      const info = this.targets.get(key)
      this.targets.delete(key)
      this.emit({ type: "target.detached", tabId, sessionId: params.sessionId, targetId: info?.targetId, at: Date.now() })
      return
    }
    if (method === "Page.frameAttached") {
      this.frames.set(`${tabId}:${params.frameId}`, { frameId: params.frameId, parentFrameId: params.parentFrameId })
      this.emit({ type: "frame.attached", tabId, frameId: params.frameId, parentFrameId: params.parentFrameId, at: Date.now() })
      return
    }
    if (method === "Page.frameNavigated") {
      const frame = params.frame || {}
      this.frames.set(`${tabId}:${frame.id}`, frame)
      this.emit({ type: "frame.navigated", tabId, frameId: frame.id, parentFrameId: frame.parentId, url: frame.url, name: frame.name, at: Date.now() })
      return
    }
    if (method === "Page.frameDetached") {
      this.frames.delete(`${tabId}:${params.frameId}`)
      this.emit({ type: "frame.detached", tabId, frameId: params.frameId, reason: params.reason, at: Date.now() })
    }
  }

  onDetach(tabId, reason) {
    this.configuredTabs.delete(tabId)
    for (const key of [...this.frames.keys()]) if (key.startsWith(`${tabId}:`)) this.frames.delete(key)
    for (const key of [...this.targets.keys()]) if (key.startsWith(`${tabId}:`)) this.targets.delete(key)
    this.emit({ type: "cdp.detached", tabId, reason, at: Date.now() })
  }

  async deepObserve(tabId, options = {}) {
    await this.configure(tabId)
    const maxAxNodes = Math.min(Math.max(Number(options.maxAccessibilityNodes) || 160, 1), MAX_AX_NODES)
    const childTargets = [...this.targets.entries()]
      .filter(([key, info]) => key.startsWith(`${tabId}:`) && info.type === "iframe")
      .map(([, info]) => info)
    const sessions = [{ source: { tabId }, targetId: null, sessionId: null }, ...childTargets.map((info) => ({ source: { tabId, sessionId: info.sessionId }, targetId: info.targetId, sessionId: info.sessionId }))]
    const captures = await Promise.all(sessions.map(async (session) => {
      const [frameTree, domSnapshot, axTree] = await Promise.all([
        this.sendCommand(session.source, "Page.getFrameTree", {}).catch((error) => ({ error: String(error?.message || error) })),
        this.sendCommand(session.source, "DOMSnapshot.captureSnapshot", {
          computedStyles: ["display", "visibility", "pointer-events"],
          includePaintOrder: true,
          includeDOMRects: true,
        }).catch((error) => ({ error: String(error?.message || error) })),
        this.sendCommand(session.source, "Accessibility.getFullAXTree", { depth: 12 }).catch((error) => ({ error: String(error?.message || error) })),
      ])
      return { ...session, frameTree, domSnapshot, axTree }
    }))

    const documents = captures.flatMap((capture) => capture.domSnapshot.documents || [])
    const nodes = captures.flatMap((capture) => (capture.axTree.nodes || []).map((node) => ({ ...node, __targetId: capture.targetId })))
    const interactiveRoles = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "menuitem", "tab", "option", "slider", "spinbutton", "treeitem", "gridcell"])
    const accessibility = nodes
      .filter((node) => !node.ignored && interactiveRoles.has(String(valueOf(node.role) || "").toLowerCase()))
      .slice(0, maxAxNodes)
      .map((node) => ({
        nodeId: node.nodeId,
        backendNodeId: node.backendDOMNodeId || null,
        role: valueOf(node.role),
        name: valueOf(node.name),
        description: valueOf(node.description),
        value: valueOf(node.value),
        properties: Object.fromEntries((node.properties || []).slice(0, 20).map((property) => [property.name, valueOf(property.value)])),
        targetId: node.__targetId,
      }))

    const frames = []
    const seenFrames = new Set()
    for (const capture of captures) {
      if (!capture.frameTree.frameTree) continue
      for (const frame of flattenFrameTree(capture.frameTree.frameTree)) {
        if (seenFrames.has(frame.id)) continue
        seenFrames.add(frame.id)
        frames.push({ ...frame, targetId: capture.targetId })
      }
    }

    return {
      transport: "chrome.debugger/CDP",
      frames,
      targets: [...this.targets.entries()].filter(([key]) => key.startsWith(`${tabId}:`)).map(([, info]) => ({ targetId: info.targetId, type: info.type, url: info.url, sessionId: info.sessionId })),
      dom: {
        documentCount: documents.length,
        nodeCount: documents.reduce((sum, document) => sum + (document.nodes?.nodeType?.length || 0), 0),
        layoutNodeCount: documents.reduce((sum, document) => sum + (document.layout?.nodeIndex?.length || 0), 0),
        shadowRootCount: documents.reduce((sum, document) => sum + (document.nodes?.shadowRootType?.index?.length || 0), 0),
        clickableCount: documents.reduce((sum, document) => sum + (document.nodes?.isClickable?.index?.length || 0), 0),
        errors: captures.map((capture) => capture.domSnapshot.error).filter(Boolean),
      },
      accessibility: {
        totalNodes: nodes.length,
        returnedInteractiveNodes: accessibility.length,
        nodes: accessibility,
        errors: captures.map((capture) => capture.axTree.error).filter(Boolean),
      },
      frameErrors: captures.map((capture) => capture.frameTree.error).filter(Boolean),
    }
  }

  status() {
    return {
      version: 2,
      configuredTabs: [...this.configuredTabs],
      frameCount: this.frames.size,
      targetCount: this.targets.size,
    }
  }
}
