import { describe, it, expect } from 'vitest'
import {
  FlowGate,
  FLOW_SEND_HIGH,
  FLOW_SEND_LOW,
  FLOW_QUEUE_PAUSE,
  FLOW_QUEUE_RESUME
} from '../../src/main/flowControl'

// Requirement: a flood must not overrun xterm's input buffer (it silently
// discards past a hard ~50MB cap) — but the throttle must act on FORWARDING, never
// coupling the child process to the renderer except as an extreme-backlog memory
// backstop. A regression here means real data loss (tail of a flood), a visually
// frozen tab (send window stuck shut), or a frozen CHILD (pty stuck paused).

function makeGate(
  sendHigh = 1000,
  sendLow = 250,
  queuePause = 10_000,
  queueResume = 2_000
): { g: FlowGate; calls: string[] } {
  const calls: string[] = []
  const g = new FlowGate(
    { onPause: () => calls.push('pause'), onResume: () => calls.push('resume') },
    sendHigh,
    sendLow,
    queuePause,
    queueResume
  )
  return { g, calls }
}

describe('FlowGate — pre-attach passthrough', () => {
  it('never blocks and never counts before a consumer attaches (unackable ≠ inflight)', () => {
    const { g, calls } = makeGate()
    // a huge pre-mount burst (rc files, --resume replay) forwarded fire-and-forget
    g.onForwarded(5000)
    expect(g.maySend()).toBe(true)
    expect(g.stats('t').inflight).toBe(0)
    expect(calls).toEqual([])
    // attach starts accounting from ZERO — the burst must not skew the window shut
    g.attach()
    expect(g.maySend()).toBe(true)
    expect(g.stats('t').inflight).toBe(0)
  })
})

describe('FlowGate — send window (forwarding throttle)', () => {
  it('shuts the window when unacked inflight crosses HIGH; pty is NOT paused', () => {
    const { g, calls } = makeGate()
    g.attach()
    g.onForwarded(600)
    expect(g.maySend()).toBe(true)
    g.onForwarded(600) // 1200 > 1000
    expect(g.maySend()).toBe(false)
    // the child keeps running: no pause callback for a mere send-window closure
    expect(calls).toEqual([])
  })

  it('reopens only when acks drop inflight strictly below LOW, exactly once', () => {
    const { g } = makeGate()
    g.attach()
    g.onForwarded(1201)
    expect(g.maySend()).toBe(false)
    expect(g.onAck(900)).toBe(false) // 301 — between LOW and HIGH: stay shut (hysteresis)
    expect(g.maySend()).toBe(false)
    expect(g.onAck(52)).toBe(true) // 249 < 250 → reopen, and signal the caller to pump
    expect(g.maySend()).toBe(true)
    expect(g.onAck(100)).toBe(false) // further acks are not another reopen edge
  })

  it('a full shut→open→shut cycle keeps accounting consistent', () => {
    const { g } = makeGate()
    g.attach()
    g.onForwarded(1100)
    expect(g.onAck(1100)).toBe(true)
    g.onForwarded(1100)
    expect(g.maySend()).toBe(false)
  })

  it('an over-ack clamps at zero and the next flood still shuts the window', () => {
    const { g } = makeGate()
    g.attach()
    g.onForwarded(100)
    g.onAck(500) // duplicate/late ack must not drive inflight negative
    expect(g.stats('t').inflight).toBe(0)
    g.onForwarded(1001) // a negative-poisoned counter would swallow this crossing
    expect(g.maySend()).toBe(false)
  })
})

describe('FlowGate — pty backstop (memory guard, not throttle)', () => {
  it('pauses the pty only past the queue watermark, resumes below the low one', () => {
    const { g, calls } = makeGate()
    g.attach()
    g.onBacklog(9_000)
    expect(calls).toEqual([]) // large but under the backstop: memory, not pause
    g.onBacklog(10_001)
    expect(calls).toEqual(['pause'])
    g.onBacklog(11_000) // still huge — no pause storm
    expect(calls).toEqual(['pause'])
    g.onBacklog(2_500) // draining, but not under resume level yet
    expect(calls).toEqual(['pause'])
    g.onBacklog(1_999)
    expect(calls).toEqual(['pause', 'resume'])
  })
})

describe('FlowGate — reset (tab exit / renderer loss)', () => {
  it('reopens the window, unpauses the pty, and zeroes accounting', () => {
    const { g, calls } = makeGate()
    g.attach()
    g.onForwarded(1500)
    g.onBacklog(10_001)
    expect(calls).toEqual(['pause'])
    g.reset()
    expect(calls).toEqual(['pause', 'resume'])
    expect(g.maySend()).toBe(true)
    expect(g.stats('t').inflight).toBe(0)
  })

  it('stays silent when nothing was paused (no spurious resume on a live fd)', () => {
    const { g, calls } = makeGate()
    g.attach()
    g.onForwarded(100)
    g.reset()
    expect(calls).toEqual([])
  })

  it('DETACHES: post-reset forwards are fire-and-forget again (orphan pty safety)', () => {
    // Renderer gone while the child still runs: the consumer that would have acked
    // died with it, and until (unless) an adopting renderer re-attaches, nothing can
    // ever ack this gate. If reset left the gate attached, the next flood would shut
    // the send window, pile up held backlog, and the backstop would pause the orphan
    // pty forever — a job that survived window-close before flow control existed
    // must still run to completion.
    const { g, calls } = makeGate()
    g.attach()
    g.onForwarded(500)
    g.reset()
    expect(g.stats('t').attached).toBe(false)
    g.onForwarded(5000) // far past HIGH — unackable output must not count as inflight
    expect(g.maySend()).toBe(true)
    expect(g.stats('t').inflight).toBe(0)
    expect(calls).toEqual([])
  })

  it('re-arms after reset → attach: adoption re-attaches the SAME pty id', () => {
    // A reloaded renderer adopts the live pty and its TerminalView attaches this very
    // gate again — reset→attach is the NORMAL path now, not a leak. Full round trip:
    // accounting restarts from zero, a flood blocks the window, an ack-drain reopens
    // it and signals the pump.
    const { g } = makeGate()
    g.attach()
    g.onForwarded(500)
    g.reset() // renderer teardown
    g.attach() // adopting TerminalView subscribed
    expect(g.stats('t').attached).toBe(true)
    g.onForwarded(1001) // flood past makeGate's sendHigh: counts against the fresh window
    expect(g.maySend()).toBe(false)
    expect(g.onAck(1001)).toBe(true) // window reopens → caller must pump
    expect(g.maySend()).toBe(true)
  })
})

describe('FlowGate — cumulative stats (the e2e ack-loop probe)', () => {
  it('sent/acked totals accumulate across attach and reset', () => {
    const { g } = makeGate()
    g.onForwarded(100) // pre-attach passthrough still counts as sent
    g.attach()
    g.onForwarded(200)
    g.onAck(150)
    g.reset()
    const s = g.stats('tab-1')
    expect(s.tabId).toBe('tab-1')
    expect(s.sentUnits).toBe(300)
    expect(s.ackedUnits).toBe(150)
  })
})

describe('flow watermarks — D7 requirements, not implementation echoes', () => {
  it('send window sits at the xterm-guide magnitude with real hysteresis', () => {
    // the guide's rule of thumb is ≤ ~500KB pending; far under the ~50MB discard cap
    expect(FLOW_SEND_HIGH).toBeLessThanOrEqual(512 * 1024)
    expect(FLOW_SEND_HIGH).toBeGreaterThanOrEqual(64 * 1024)
    expect(FLOW_SEND_LOW).toBeGreaterThan(0)
    expect(FLOW_SEND_LOW).toBeLessThanOrEqual(FLOW_SEND_HIGH / 2)
  })

  it('pty backstop engages only for a runaway backlog, bounded well under the cap', () => {
    expect(FLOW_QUEUE_PAUSE).toBeGreaterThan(FLOW_SEND_HIGH * 4)
    expect(FLOW_QUEUE_PAUSE).toBeLessThan(50_000_000 / 2)
    expect(FLOW_QUEUE_RESUME).toBeGreaterThan(0)
    expect(FLOW_QUEUE_RESUME).toBeLessThan(FLOW_QUEUE_PAUSE)
  })
})
