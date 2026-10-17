import type { CodexRpc } from './codexTransport'

export const SIDE_SERVER_IDLE_MS = 60_000

interface SideServer {
  rpc: CodexRpc
  asking: number
  idle?: ReturnType<typeof setTimeout>
}

// CODEX§15
export class CodexSideServers {
  private open = new Map<string | undefined, SideServer>()

  constructor(private start: (home: string | undefined) => CodexRpc) {}

  async ask<T>(home: string | undefined, use: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    let side = this.open.get(home)
    if (!side || side.rpc.isClosed) {
      side = { rpc: this.start(home), asking: 0 }
      this.open.set(home, side)
    }
    clearTimeout(side.idle)
    side.asking++
    try {
      return await use(side.rpc)
    } finally {
      side.asking--
      if (!side.asking && this.open.get(home) === side)
        side.idle = setTimeout(() => void this.forget(home), SIDE_SERVER_IDLE_MS)
    }
  }

  async forget(home: string | undefined): Promise<void> {
    const side = this.open.get(home)
    if (!side) return
    this.open.delete(home)
    clearTimeout(side.idle)
    await side.rpc.close().catch(() => {})
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((home) => this.forget(home)))
  }
}
