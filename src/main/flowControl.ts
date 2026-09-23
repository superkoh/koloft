/**
 * Flow control between a pty and the renderer's xterm.
 *
 * xterm consumes ~5–35 MB/s and silently DISCARDS input past a hard ~50 MB cap, so an
 * unthrottled flood can lose output. The naive fix — pausing the pty the moment the
 * renderer lags — couples the CHILD PROCESS's speed to the renderer: Chromium throttles
 * a hidden window's timers (a minimized Koloft would slow the build itself, not just its
 * display), a closed window means acks can never arrive (the child freezes forever),
 * and a pty paused at process exit races node-pty's 200ms socket teardown into
 * discarding the very tail the feature exists to protect.
 *
 * So the gate throttles FORWARDING, not the pty. Unforwarded output stays in main's
 * per-tab coalescing buffer (bounded, far under xterm's cap) and is pumped out as the
 * renderer acks. Only a runaway backlog — a genuinely wedged renderer — pauses the pty,
 * as a last-resort memory backstop. Accounting starts when the tab's TerminalView
 * attaches: chunks forwarded before anyone listens can never be acked, and counting
 * them would permanently skew the send window shut.
 *
 * Units are UTF-16 code units (string .length): both processes count the same strings
 * with the same metric, and terminal output is ASCII-dominated, so it tracks bytes
 * closely enough for watermarks.
 */

/** stop forwarding above this many unacked units (xterm guide magnitude: ≤ ~500KB) */
export const FLOW_SEND_HIGH = 512 * 1024
/** resume forwarding below this — 4:1 hysteresis avoids flapping */
export const FLOW_SEND_LOW = 128 * 1024
/** pause the pty itself only past this held backlog (memory backstop, not throttle) */
export const FLOW_QUEUE_PAUSE = 8 * 1024 * 1024
/** resume the pty below this backlog */
export const FLOW_QUEUE_RESUME = 2 * 1024 * 1024

import type { FlowStats } from '@shared/types'

export interface FlowGateCallbacks {
  /** stop the pty producing (socket pause — only the extreme-backlog backstop) */
  onPause(): void
  /** let the pty produce again */
  onResume(): void
}

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

  /** may the coalescing buffer forward this tab's next chunk right now?
   *  Pre-attach there is no consumer to ack, so forwarding is legacy fire-and-forget. */
  maySend(): boolean {
    return !this.attached || !this.blocked
  }

  /** a chunk went out over terminal:data */
  onForwarded(units: number): void {
    this.sentTotal += units
    if (!this.attached) return
    this.inflight += units
    if (!this.blocked && this.inflight > this.sendHigh) this.blocked = true
  }

  /** xterm consumed units (renderer ack). Returns true exactly when the send window
   *  just reopened — the caller must pump the held backlog then, because a child that
   *  already finished writing produces no further pty data to arm the flush timer.
   *  Clamped at 0 so a duplicate/late ack can never mask a real backlog. */
  onAck(units: number): boolean {
    this.ackedTotal += units
    this.inflight = Math.max(0, this.inflight - units)
    if (this.blocked && this.inflight < this.sendLow) {
      this.blocked = false
      return true
    }
    return false
  }

  /** current held-backlog size for this tab; drives the pty-pause backstop */
  onBacklog(units: number): void {
    if (!this.paused && units > this.queuePause) {
      this.paused = true
      this.cb.onPause()
    } else if (this.paused && units < this.queueResume) {
      this.paused = false
      this.cb.onResume()
    }
  }

  /** the tab's TerminalView subscribed and will ack from here on: start accounting
   *  from zero (anything sent earlier is unackable and must not count). */
  attach(): void {
    this.attached = true
    this.inflight = 0
    this.blocked = false
  }

  /** tab exit / renderer loss: drop accounting, reopen the window, and never leave
   *  the pty paused — a stale pause would freeze the child forever. Also DETACH:
   *  the consumer that would have acked died with the renderer. An adopting
   *  renderer re-attaches this very gate — but until that attach, a
   *  still-attached gate would count unackable forwards against a window nothing
   *  can ever reopen, and the backstop would freeze the orphan pty. */
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
