// Bounded PTY output replay buffer.
//
// Native output often arrives as many tiny chunks. Array.shift() makes every
// eviction O(n), which turns a long-running noisy terminal into avoidable
// service-worker CPU and allocation churn. Keep a logical head and compact only
// occasionally so the hot push/evict path stays amortized O(1).
export class OutputReplayBuffer {
  constructor(maxLength = 65536) {
    this.maxLength = Math.max(1, Number(maxLength) || 65536)
    this.entries = []
    this.head = 0
    this.totalLength = 0
  }

  push(sid, data) {
    if (typeof data !== "string" || data.length === 0) return
    this.entries.push({ sid, data })
    this.totalLength += data.length
    while (this.totalLength > this.maxLength && this.entries.length - this.head > 1) {
      this.totalLength -= this.entries[this.head].data.length
      this.head++
    }
    // Compact rarely and only after enough stale slots accumulated. This keeps
    // retained references bounded without reintroducing per-chunk array copies.
    if (this.head >= 256 && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head)
      this.head = 0
    }
  }

  read(sid) {
    let result = ""
    for (let i = this.head; i < this.entries.length; i++) {
      const entry = this.entries[i]
      if (entry.sid === sid) result += entry.data
    }
    return result
  }

  get entryCount() {
    return this.entries.length - this.head
  }
}
