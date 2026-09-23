import { describe, it, expect } from 'vitest'
import {
  FlowGate,
  FLOW_SEND_HIGH,
  FLOW_SEND_LOW,
  FLOW_QUEUE_PAUSE,
  FLOW_QUEUE_RESUME
} from '../../src/main/flowControl'

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
    g.onForwarded(5000)
    expect(g.maySend()).toBe(true)
    expect(g.stats('t').inflight).toBe(0)
    expect(calls).toEqual([])
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
    g.onForwarded(600)
    expect(g.maySend()).toBe(false)
    expect(calls).toEqual([])
  })

  it('reopens only when acks drop inflight strictly below LOW, exactly once', () => {
    const { g } = makeGate()
    g.attach()
    g.onForwarded(1201)
    expect(g.maySend()).toBe(false)
    expect(g.onAck(900)).toBe(false)
    expect(g.maySend()).toBe(false)
    expect(g.onAck(52)).toBe(true)
    expect(g.maySend()).toBe(true)
    expect(g.onAck(100)).toBe(false)
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
    g.onAck(500)
    expect(g.stats('t').inflight).toBe(0)
    g.onForwarded(1001)
    expect(g.maySend()).toBe(false)
  })
})

describe('FlowGate — pty backstop (memory guard, not throttle)', () => {
  it('pauses the pty only past the queue watermark, resumes below the low one', () => {
    const { g, calls } = makeGate()
    g.attach()
    g.onBacklog(9_000)
    expect(calls).toEqual([])
    g.onBacklog(10_001)
    expect(calls).toEqual(['pause'])
    g.onBacklog(11_000)
    expect(calls).toEqual(['pause'])
    g.onBacklog(2_500)
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
    const { g, calls } = makeGate()
    g.attach()
    g.onForwarded(500)
    g.reset()
    expect(g.stats('t').attached).toBe(false)
    g.onForwarded(5000)
    expect(g.maySend()).toBe(true)
    expect(g.stats('t').inflight).toBe(0)
    expect(calls).toEqual([])
  })

  it('re-arms after reset → attach: adoption re-attaches the SAME pty id', () => {
    const { g } = makeGate()
    g.attach()
    g.onForwarded(500)
    g.reset()
    g.attach()
    expect(g.stats('t').attached).toBe(true)
    g.onForwarded(1001)
    expect(g.maySend()).toBe(false)
    expect(g.onAck(1001)).toBe(true)
    expect(g.maySend()).toBe(true)
  })
})

describe('FlowGate — cumulative stats (the e2e ack-loop probe)', () => {
  it('sent/acked totals accumulate across attach and reset', () => {
    const { g } = makeGate()
    g.onForwarded(100)
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

// PLATFORM§21
const XTERM_INPUT_DISCARD_CAP_BYTES = 50_000_000
const XTERM_GUIDE_MAX_PENDING_BYTES = 512 * 1024

describe('flow watermarks — requirements, not implementation echoes', () => {
  it('send window sits at the xterm-guide magnitude, far under the discard cap, with real hysteresis', () => {
    expect(FLOW_SEND_HIGH).toBeLessThanOrEqual(XTERM_GUIDE_MAX_PENDING_BYTES)
    expect(FLOW_SEND_HIGH).toBeGreaterThanOrEqual(64 * 1024)
    expect(FLOW_SEND_LOW).toBeGreaterThan(0)
    expect(FLOW_SEND_LOW).toBeLessThanOrEqual(FLOW_SEND_HIGH / 2)
  })

  it('pty backstop engages only for a runaway backlog, bounded well under the cap', () => {
    expect(FLOW_QUEUE_PAUSE).toBeGreaterThan(FLOW_SEND_HIGH * 4)
    expect(FLOW_QUEUE_PAUSE).toBeLessThan(XTERM_INPUT_DISCARD_CAP_BYTES / 2)
    expect(FLOW_QUEUE_RESUME).toBeGreaterThan(0)
    expect(FLOW_QUEUE_RESUME).toBeLessThan(FLOW_QUEUE_PAUSE)
  })
})
