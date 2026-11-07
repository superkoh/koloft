export const FLOW_SEND_HIGH = 512 * 1024
export const FLOW_SEND_LOW = 128 * 1024
// PLATFORM§21
export const FLOW_QUEUE_PAUSE = 8 * 1024 * 1024
export const FLOW_QUEUE_RESUME = 2 * 1024 * 1024
export const FLOW_SLICE_UTF16_UNITS = 128 * 1024
export const PTY_OUTPUT_COALESCE_ONE_FRAME_MS = 16

import type { FlowStats } from '@shared/types'

export interface FlowGateCallbacks {
  onPause(): void
  onResume(): void
}

// PLATFORM§5 PLATFORM§29
export class FlowGate {
  private inflight = 0
  private blocked = false
  private paused = false
  private attached = false
  private sentTotal = 0
  private ackedTotal = 0

  constructor(
    private readonly cb: FlowGateCallbacks,
    private readonly sendHigh = FLOW_SEND_HIGH,
    private readonly sendLow = FLOW_SEND_LOW,
    private readonly queuePause = FLOW_QUEUE_PAUSE,
    private readonly queueResume = FLOW_QUEUE_RESUME
  ) {}

  maySend(): boolean {
    return this.attached && !this.blocked
  }

  onForwarded(utf16Units: number): void {
    this.sentTotal += utf16Units
    this.inflight += utf16Units
    if (!this.blocked && this.inflight > this.sendHigh) this.blocked = true
  }

  onAck(utf16Units: number): boolean {
    this.ackedTotal += utf16Units
    this.inflight = Math.max(0, this.inflight - utf16Units)
    if (this.blocked && this.inflight < this.sendLow) {
      this.blocked = false
      return true
    }
    return false
  }

  onBacklog(utf16Units: number): void {
    if (!this.paused && utf16Units > this.queuePause) {
      this.paused = true
      this.cb.onPause()
    } else if (this.paused && utf16Units < this.queueResume) {
      this.paused = false
      this.cb.onResume()
    }
  }

  attach(): void {
    this.attached = true
    this.inflight = 0
    this.blocked = false
  }

  reset(): void {
    this.attached = false
    this.inflight = 0
    this.blocked = false
    if (this.paused) {
      this.paused = false
      this.cb.onResume()
    }
  }

  stats(tabId: string): FlowStats {
    return {
      tabId,
      sentUnits: this.sentTotal,
      ackedUnits: this.ackedTotal,
      blocked: this.blocked,
      paused: this.paused,
      inflight: this.inflight,
      attached: this.attached
    }
  }
}

export function nextSlice(data: string, maxUnits = FLOW_SLICE_UTF16_UNITS): string {
  if (data.length <= maxUnits) return data
  const last = data.charCodeAt(maxUnits - 1)
  const endsOnHighSurrogate = last >= 0xd800 && last <= 0xdbff
  return data.slice(0, endsOnHighSurrogate ? maxUnits - 1 : maxUnits)
}

export interface TerminalOutputDeps {
  gate(id: string): FlowGate
  send(id: string, data: string): boolean
  rendererUp(): boolean
  now(): number
}

export class TerminalOutput {
  private readonly held = new Map<string, string>()
  private readonly lastSentAt = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly d: TerminalOutputDeps) {}

  push(id: string, data: string): void {
    const queued = (this.held.get(id) ?? '') + data
    this.held.set(id, queued)
    const last = this.lastSentAt.get(id)
    const idle = last === undefined || this.d.now() - last >= PTY_OUTPUT_COALESCE_ONE_FRAME_MS
    if (!idle) this.schedule(PTY_OUTPUT_COALESCE_ONE_FRAME_MS)
    else if (this.sendSlice(id, queued)) this.schedule(0)
  }

  flush(): void {
    this.timer = null
    let more = false
    for (const [id, data] of this.held) if (this.sendSlice(id, data)) more = true
    if (more) this.schedule(0)
  }

  wake(): void {
    this.schedule(0)
  }

  take(id: string): string | undefined {
    const data = this.held.get(id)
    this.held.delete(id)
    this.lastSentAt.delete(id)
    return data
  }

  clear(): void {
    this.held.clear()
    this.lastSentAt.clear()
  }

  private schedule(ms: number): void {
    if (!this.timer) this.timer = setTimeout(() => this.flush(), ms)
  }

  private sendSlice(id: string, data: string): boolean {
    const gate = this.d.gate(id)
    if (!gate.maySend()) {
      if (this.d.rendererUp()) gate.onBacklog(data.length)
      else this.held.delete(id)
      return false
    }
    const slice = nextSlice(data)
    if (!this.d.send(id, slice)) {
      gate.reset()
      this.held.delete(id)
      return false
    }
    this.lastSentAt.set(id, this.d.now())
    gate.onForwarded(slice.length)
    const rest = data.slice(slice.length)
    gate.onBacklog(rest.length)
    if (!rest) {
      this.held.delete(id)
      return false
    }
    this.held.set(id, rest)
    return gate.maySend()
  }
}
