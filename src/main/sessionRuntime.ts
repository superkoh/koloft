import { EventEmitter } from 'events'
import type { BackgroundItem, SessionStatus } from '@shared/types'
import type { SessionEvent } from '@shared/sessionEvent'

export function envMs(name: string, dflt: number): number {
  const v = process.env[name]
  const n = v && v.trim() ? Number(v) : NaN
  return isFinite(n) && n >= 0 ? n : dflt
}

const IDLE_MS = envMs('KOLOFT_IDLE_MS', 4 * 60_000)
// CC§12
const AUTO_CLOSE_MS = envMs('KOLOFT_IDLE_CLOSE_MS', 30 * 60_000)

export type Turn = 'working' | 'approval' | 'input' | 'ended'

export function turnOf(event: SessionEvent): Turn | undefined {
  if (event.type === 'prompt') return 'working'
  if (event.type === 'notify') return event.need
  if (event.type === 'stop') return 'ended'
  return undefined
}

export interface StatusSignals {
  turn?: Turn
  heldByBackground: boolean
  background: BackgroundItem[]
  restingSince?: number
}

export function deriveStatus(signals: StatusSignals, now: number): SessionStatus | undefined {
  const { turn, background } = signals
  if (!turn) return undefined
  if (turn === 'working' || turn === 'approval') return turn
  if (
    turn === 'ended' &&
    (signals.heldByBackground || background.some((item) => item.state === 'working'))
  )
    return 'working'
  const idle = signals.restingSince !== undefined && now - signals.restingSince >= IDLE_MS
  return idle ? 'idle' : 'waiting'
}

export interface StatusEdge {
  tabId: string
  prev: SessionStatus | undefined
  next: SessionStatus
}

interface RuntimeEntry extends StatusSignals {
  status?: SessionStatus
  since: number
  wakeupPending: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  closeTimer?: ReturnType<typeof setTimeout>
}

export class SessionRuntime extends EventEmitter {
  private entries = new Map<string, RuntimeEntry>()
  activeTabId?: () => string | null
  heldTabs?: () => ReadonlySet<string>
  needsUser?: (tabId: string) => boolean

  statusOf(tabId: string): SessionStatus | undefined {
    return this.entries.get(tabId)?.status
  }

  protected statusSince(tabId: string): number {
    return this.entries.get(tabId)?.since ?? 0
  }

  protected isHeldByBackground(tabId: string): boolean {
    const e = this.entries.get(tabId)
    return !!e && e.turn === 'ended' && e.heldByBackground
  }

  recordTurn(tabId: string, turn: Turn, heldByBackground = false): void {
    const e = this.entry(tabId)
    e.turn = turn
    e.heldByBackground = heldByBackground
    e.restingSince = undefined
    this.disarmClose(e)
    this.evaluate(tabId, e, Date.now())
  }

  setBackground(tabId: string, items: BackgroundItem[]): boolean {
    const e = this.entry(tabId)
    if (JSON.stringify(items) === JSON.stringify(e.background)) return false
    e.background = items
    this.evaluate(tabId, e, Date.now())
    return true
  }

  setWakeupPending(tabId: string, pending: boolean): void {
    this.entry(tabId).wakeupPending = pending
  }

  noteActivity(tabId: string): void {
    const e = this.entries.get(tabId)
    if (e?.status === 'idle') this.armClose(tabId, e)
  }

  forget(tabId: string): void {
    const e = this.entries.get(tabId)
    if (!e) return
    clearTimeout(e.idleTimer)
    this.disarmClose(e)
    this.entries.delete(tabId)
  }

  protected statusChanged(_tabId: string, _status: SessionStatus): void {}

  protected async workStillRunning(_tabId: string): Promise<boolean> {
    return false
  }

  private entry(tabId: string): RuntimeEntry {
    let e = this.entries.get(tabId)
    if (!e) {
      e = { heldByBackground: false, background: [], since: 0, wakeupPending: false }
      this.entries.set(tabId, e)
    }
    return e
  }

  private evaluate(tabId: string, e: RuntimeEntry, now: number): void {
    const status = deriveStatus(e, now)
    const resting = status === 'waiting' || status === 'idle'
    e.restingSince = resting ? (e.restingSince ?? now) : undefined
    clearTimeout(e.idleTimer)
    e.idleTimer = undefined
    if (status === 'waiting') {
      const due = (e.restingSince ?? now) + IDLE_MS
      e.idleTimer = setTimeout(
        () => this.evaluate(tabId, e, Math.max(Date.now(), due)),
        Math.max(0, due - now)
      )
    }
    if (status === e.status || !status) return
    const prev = e.status
    e.status = status
    if (status === 'idle') {
      this.armClose(tabId, e)
    } else {
      e.since = now
      this.disarmClose(e)
    }
    this.statusChanged(tabId, status)
    this.emit('status', { tabId, prev, next: status } satisfies StatusEdge)
  }

  private armClose(tabId: string, e: RuntimeEntry): void {
    this.disarmClose(e)
    e.closeTimer = setTimeout(() => void this.tryAutoClose(tabId, e), AUTO_CLOSE_MS)
  }

  private disarmClose(e: RuntimeEntry): void {
    clearTimeout(e.closeTimer)
    e.closeTimer = undefined
  }

  // CODEX§4
  private async tryAutoClose(tabId: string, e: RuntimeEntry): Promise<void> {
    e.closeTimer = undefined
    const held =
      tabId === this.activeTabId?.() ||
      e.wakeupPending ||
      e.background.length > 0 ||
      !!this.heldTabs?.().has(tabId) ||
      !!this.needsUser?.(tabId)
    if (held) {
      this.armClose(tabId, e)
      return
    }
    const running = await this.workStillRunning(tabId)
    if (this.entries.get(tabId) !== e || e.status !== 'idle' || e.closeTimer) return
    if (running) {
      this.armClose(tabId, e)
      return
    }
    this.emit('auto-close', { tabId })
  }
}
