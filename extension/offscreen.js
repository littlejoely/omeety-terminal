// offscreen document 唯一职责：维持一条到 background service worker 的长连接，让 SW 不被回收。
// 这样侧栏关闭后 native 端口不断、host/PTY 不死，重开侧栏能复用之前的 shell 会话。
// （MV3 限制：Edge 完全退出时 SW 仍会死，会话无法跨浏览器重启保留。）

let port = null

function connectKeepalive() {
  try {
    port = chrome.runtime.connect({ name: "keepalive" })
    // 每次新 port 都重新注册断线监听；旧实现只监听首条 port，第二次断线后不会再恢复。
    port.onDisconnect.addListener(() => {
      port = null
      setTimeout(connectKeepalive, 1000)
    })
  } catch {
    port = null
    setTimeout(connectKeepalive, 1000)
  }
}

connectKeepalive()

// 周期性发消息，确保 SW 有“活动”（对抗 MV3 的闲置回收）
setInterval(() => {
  try {
    port?.postMessage({ t: "ping" })
  } catch {
    /* port closed */
  }
}, 20000)
