export const FLOW_SEND_HIGH = 512 * 1024
export const FLOW_SEND_LOW = 128 * 1024
// PLATFORM§21
export const FLOW_QUEUE_PAUSE = 8 * 1024 * 1024
export const FLOW_QUEUE_RESUME = 2 * 1024 * 1024

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
    return !this.attached || !this.blocked
  }

  onForwarded(utf16Units: number): void {
    this.sentTotal += utf16Units
    if (!this.attached) return
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
