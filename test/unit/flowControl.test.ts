import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  FlowGate,
  TerminalOutput,
  nextSlice,
  FLOW_SEND_HIGH,
  FLOW_SEND_LOW,
  FLOW_QUEUE_PAUSE,
  FLOW_QUEUE_RESUME,
  FLOW_SLICE_UTF16_UNITS,
  HELD_FOR_AN_UNSEEN_TAB_MAX,
  PTY_OUTPUT_COALESCE_ONE_FRAME_MS,
  PTY_OUTPUT_COALESCE_OFF_SCREEN_MS,
  asksTheTerminal
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

describe('FlowGate — before a consumer attaches', () => {
  it('lets nothing through until the view attaches, then opens with an empty window', () => {
    const { g, calls } = makeGate()
    expect(g.maySend()).toBe(false)
    g.attach()
    expect(g.maySend()).toBe(true)
    expect(g.stats('t').inflight).toBe(0)
    expect(calls).toEqual([])
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
  it('unpauses the pty and zeroes accounting, so a fresh attach starts with an open window', () => {
    const { g, calls } = makeGate()
    g.attach()
    g.onForwarded(1500)
    g.onBacklog(10_001)
    expect(calls).toEqual(['pause'])
    g.reset()
    expect(calls).toEqual(['pause', 'resume'])
    expect(g.stats('t').inflight).toBe(0)
    g.attach()
    expect(g.maySend()).toBe(true)
  })

  it('stays silent when nothing was paused (no spurious resume on a live fd)', () => {
    const { g, calls } = makeGate()
    g.attach()
    g.onForwarded(100)
    g.reset()
    expect(calls).toEqual([])
  })

  it('DETACHES: after a reset nothing is let through until the view attaches again', () => {
    const { g, calls } = makeGate()
    g.attach()
    g.onForwarded(500)
    g.reset()
    expect(g.stats('t').attached).toBe(false)
    expect(g.maySend()).toBe(false)
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
    g.attach()
    g.onForwarded(100)
    g.reset()
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

function makeOutput(opts: { rendererUp?: boolean; sendHigh?: number } = {}): {
  out: TerminalOutput
  sent: { id: string; data: string }[]
  gate(id: string): FlowGate
  calls: string[]
} {
  vi.useFakeTimers()
  const sent: { id: string; data: string }[] = []
  const calls: string[] = []
  const gates = new Map<string, FlowGate>()
  const gate = (id: string): FlowGate => {
    let g = gates.get(id)
    if (!g) {
      g = new FlowGate(
        { onPause: () => calls.push(`pause ${id}`), onResume: () => calls.push(`resume ${id}`) },
        opts.sendHigh
      )
      gates.set(id, g)
    }
    return g
  }
  const out = new TerminalOutput({
    gate,
    send: (id, data) => {
      sent.push({ id, data })
      return true
    },
    rendererUp: () => opts.rendererUp ?? true,
    now: () => Date.now()
  })
  return { out, sent, gate, calls }
}

describe('TerminalOutput — what reaches the view, and when', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a key echo on an idle tab goes out at once; output right behind it goes as one, one frame after the echo', () => {
    const { out, sent, gate } = makeOutput()
    gate('t').attach()
    out.push('t', 'a')
    expect(sent).toEqual([{ id: 't', data: 'a' }])
    vi.advanceTimersByTime(2)
    out.push('t', 'b')
    out.push('t', 'c')
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(PTY_OUTPUT_COALESCE_ONE_FRAME_MS - 2)
    expect(sent).toEqual([
      { id: 't', data: 'a' },
      { id: 't', data: 'bc' }
    ])
  })

  it('a backlog of many small reads leaves in full slices, one per tab per turn, in order and whole', () => {
    const { out, sent, gate } = makeOutput({ sendHigh: Infinity })
    const read = 'y'.repeat(4000)
    for (let i = 0; i < 70; i++) {
      out.push('a', read)
      out.push('b', read)
    }
    gate('a').attach()
    gate('b').attach()
    out.wake('a')
    out.wake('b')
    vi.advanceTimersToNextTimer()
    expect(sent.map((s) => s.id)).toEqual(['a', 'b'])
    vi.advanceTimersToNextTimer()
    expect(sent.map((s) => s.id)).toEqual(['a', 'b', 'a', 'b'])
    vi.runAllTimers()
    expect(sent.map((s) => s.data.length)).toEqual([
      FLOW_SLICE_UTF16_UNITS,
      FLOW_SLICE_UTF16_UNITS,
      FLOW_SLICE_UTF16_UNITS,
      FLOW_SLICE_UTF16_UNITS,
      70 * 4000 - 2 * FLOW_SLICE_UTF16_UNITS,
      70 * 4000 - 2 * FLOW_SLICE_UTF16_UNITS
    ])
    for (const id of ['a', 'b'])
      expect(
        sent
          .filter((s) => s.id === id)
          .map((s) => s.data)
          .join('')
      ).toBe(read.repeat(70))
  })

  it("one tab draining a backlog does not hurry another tab's one-frame wait", () => {
    const { out, sent, gate } = makeOutput({ sendHigh: Infinity })
    gate('a').attach()
    gate('b').attach()
    out.push('a', 'x'.repeat(FLOW_SLICE_UTF16_UNITS * 4))
    out.push('b', 'echo')
    vi.advanceTimersByTime(1)
    out.push('b', 'more')
    vi.advanceTimersByTime(2)
    expect(sent.filter((s) => s.id === 'b').map((s) => s.data)).toEqual(['echo'])
    vi.advanceTimersByTime(PTY_OUTPUT_COALESCE_ONE_FRAME_MS)
    expect(sent.filter((s) => s.id === 'b').map((s) => s.data)).toEqual(['echo', 'more'])
  })

  it('a slice never ends between the two halves of an emoji', () => {
    const data = 'x'.repeat(FLOW_SLICE_UTF16_UNITS - 1) + '😀' + 'tail'
    const slice = nextSlice(data)
    expect(slice).toBe('x'.repeat(FLOW_SLICE_UTF16_UNITS - 1))
    expect(slice + nextSlice(data.slice(slice.length))).toBe(data)
  })

  it('output from before the view attaches is held, then arrives in order once it attaches', () => {
    const { out, sent, gate } = makeOutput()
    out.push('t', 'prompt$ ')
    vi.advanceTimersByTime(100)
    out.push('t', 'more')
    vi.runAllTimers()
    expect(sent).toEqual([])
    gate('t').attach()
    out.wake('t')
    vi.runAllTimers()
    expect(sent).toEqual([{ id: 't', data: 'prompt$ more' }])
  })

  it('an attached tab whose backlog passes the pause watermark pauses its pty, and resumes once it drains', () => {
    const { out, gate, calls } = makeOutput({ sendHigh: Infinity })
    gate('t').attach()
    out.push('t', 'x'.repeat(FLOW_QUEUE_PAUSE + 2 * FLOW_SLICE_UTF16_UNITS))
    expect(calls).toEqual(['pause t'])
    vi.runAllTimers()
    expect(calls).toEqual(['pause t', 'resume t'])
  })

  it('a tab no view shows yet never pauses its pty: past its cap the oldest output goes and the newest stays', () => {
    const { out, sent, gate, calls } = makeOutput()
    const half = HELD_FOR_AN_UNSEEN_TAB_MAX / 2
    out.push('t', 'a'.repeat(half))
    out.push('t', 'b'.repeat(half))
    out.push('t', 'newest')
    vi.runAllTimers()
    expect(calls).toEqual([])
    gate('t').attach()
    out.wake('t')
    vi.runAllTimers()
    expect(sent.map((s) => s.data).join('')).toBe('b'.repeat(half) + 'newest')
  })

  it('with no window to show it, output is dropped and never pauses the pty', () => {
    const { out, sent, gate, calls } = makeOutput({ rendererUp: false })
    out.push('t', 'x'.repeat(FLOW_QUEUE_PAUSE + 1))
    gate('t').attach()
    out.wake('t')
    vi.runAllTimers()
    expect(calls).toEqual([])
    expect(sent).toEqual([])
  })

  it('a tab that ends hands the view its held tail in slices, gate or no gate', () => {
    const { out, sent } = makeOutput()
    const tail = 'z'.repeat(FLOW_SLICE_UTF16_UNITS * 2 + 1)
    out.push('t', tail)
    out.end('t', true)
    expect(sent.map((s) => s.data.length)).toEqual([
      FLOW_SLICE_UTF16_UNITS,
      FLOW_SLICE_UTF16_UNITS,
      1
    ])
    expect(sent.map((s) => s.data).join('')).toBe(tail)
  })
})

describe('TerminalOutput — a tab off screen gets its output in fewer, larger batches', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const offScreenTab = (): ReturnType<typeof makeOutput> => {
    const o = makeOutput({ sendHigh: Infinity })
    o.gate('t').attach()
    o.out.onScreen('t', false)
    return o
  }

  it('output streaming into a tab off screen goes out once per off-screen batch, whole and in order', () => {
    const { out, sent } = offScreenTab()
    out.push('t', 'a')
    for (let ms = 10; ms < PTY_OUTPUT_COALESCE_OFF_SCREEN_MS; ms += 10) {
      vi.advanceTimersByTime(10)
      out.push('t', 'b')
    }
    expect(sent.map((s) => s.data)).toEqual(['a'])
    vi.advanceTimersByTime(10)
    expect(sent.map((s) => s.data)).toEqual(['a', 'b'.repeat(19)])
  })

  it('a tab coming back on screen gets what was held at once', () => {
    const { out, sent } = offScreenTab()
    out.push('t', 'a')
    vi.advanceTimersByTime(1)
    out.push('t', 'held')
    out.onScreen('t', true)
    expect(sent.map((s) => s.data)).toEqual(['a', 'held'])
    vi.advanceTimersByTime(1)
    out.push('t', 'x')
    vi.advanceTimersByTime(PTY_OUTPUT_COALESCE_ONE_FRAME_MS)
    expect(sent.map((s) => s.data)).toEqual(['a', 'held', 'x'])
  })

  it('a flush hands over everything held before a screen read', () => {
    const { out, sent } = offScreenTab()
    out.push('t', 'a')
    vi.advanceTimersByTime(1)
    out.push('t', 'last line')
    out.flush('t')
    expect(sent.map((s) => s.data)).toEqual(['a', 'last line'])
  })

  it('a program asking the terminal a question off screen is not kept waiting for the batch', () => {
    for (const question of ['\x1b[6n', '\x1b[c', '\x1b[>q', '\x1b[?2026$p', '\x1b]11;?\x07']) {
      const { out, sent } = offScreenTab()
      out.push('t', 'a')
      vi.advanceTimersByTime(1)
      out.push('t', 'b' + question)
      expect(sent.map((s) => s.data)).toEqual(['a', 'b' + question])
      vi.useRealTimers()
    }
  })

  it('a link or a cursor move is not a question', () => {
    expect(asksTheTerminal('\x1b]8;;https://x.test/?q=1\x07link\x1b]8;;\x07')).toBe(false)
    expect(asksTheTerminal('\x1b[u\x1b[2 q\x1b[22;0t')).toBe(false)
  })

  it('a large backlog off screen does not wait for the batch', () => {
    const { out, sent } = offScreenTab()
    out.push('t', 'a')
    vi.advanceTimersByTime(1)
    out.push('t', 'x'.repeat(FLOW_SLICE_UTF16_UNITS))
    expect(sent.map((s) => s.data.length)).toEqual([1, FLOW_SLICE_UTF16_UNITS])
  })
})
