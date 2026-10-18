import type { CodexRpc } from './codexTransport'

export const SIDE_SERVER_IDLE_MS = 60_000

interface SideServer {
  rpc: CodexRpc
  asking: number
  idle?: ReturnType<typeof setTimeout>
}

// CODEX§15
export class CodexSideServers<Key = string | undefined> {
  private open = new Map<Key, SideServer>()

  constructor(private start: (key: Key) => CodexRpc) {}

  get anyOpen(): boolean {
    return this.open.size > 0
  }

  async ask<T>(key: Key, use: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    let side = this.open.get(key)
    if (!side || side.rpc.isClosed) {
      side = { rpc: this.start(key), asking: 0 }
      this.open.set(key, side)
    }
    clearTimeout(side.idle)
    side.asking++
    try {
      return await use(side.rpc)
    } finally {
      side.asking--
      if (!side.asking && this.open.get(key) === side)
        side.idle = setTimeout(() => void this.forget(key), SIDE_SERVER_IDLE_MS)
    }
  }

  async forget(key: Key): Promise<void> {
    const side = this.open.get(key)
    if (!side) return
    this.open.delete(key)
    clearTimeout(side.idle)
    await side.rpc.close().catch(() => {})
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((key) => this.forget(key)))
  }
}
