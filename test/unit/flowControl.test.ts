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

function makeOutput(opts: { rendererUp?: boolean } = {}): {
  out: TerminalOutput
  sent: { id: string; data: string }[]
  calls: string[]
  drainAcking(): void
} {
  vi.useFakeTimers()
  const sent: { id: string; data: string }[] = []
  const calls: string[] = []
  let unacked: { id: string; data: string }[] = []
  const out = new TerminalOutput({
    pause: (id) => calls.push(`pause ${id}`),
    resume: (id) => calls.push(`resume ${id}`),
    send: (id, data) => {
      sent.push({ id, data })
      unacked.push({ id, data })
      return true
    },
    rendererUp: () => opts.rendererUp ?? true,
    now: () => Date.now()
  })
  const drainAcking = (): void => {
    for (;;) {
      vi.runAllTimers()
      if (!unacked.length) return
      const acks = unacked
      unacked = []
      for (const { id, data } of acks) out.ack(id, data.length)
    }
  }
  return { out, sent, calls, drainAcking }
}

describe('TerminalOutput — what reaches the view, and when', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a key echo on an idle tab goes out at once; output right behind it goes as one, one frame after the echo', () => {
    const { out, sent } = makeOutput()
    out.attach('t')
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
    const { out, sent } = makeOutput()
    const read = 'y'.repeat(4000)
    for (let i = 0; i < 70; i++) {
      out.push('a', read)
      out.push('b', read)
    }
    out.attach('a')
    out.attach('b')
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
    const { out, sent } = makeOutput()
    out.attach('a')
    out.attach('b')
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
    const { out, sent } = makeOutput()
    out.push('t', 'prompt$ ')
    vi.advanceTimersByTime(100)
    out.push('t', 'more')
    vi.runAllTimers()
    expect(sent).toEqual([])
    out.attach('t')
    vi.runAllTimers()
    expect(sent).toEqual([{ id: 't', data: 'prompt$ more' }])
  })

  it('a view that stops acking holds the rest back past the send window, and its acks let the rest out', () => {
    const { out, sent, drainAcking } = makeOutput()
    out.attach('t')
    const flood = 'x'.repeat(FLOW_SEND_HIGH * 2)
    out.push('t', flood)
    vi.runAllTimers()
    const before = sent.map((s) => s.data).join('').length
    expect(before).toBeGreaterThan(FLOW_SEND_HIGH)
    expect(before).toBeLessThan(flood.length)
    drainAcking()
    expect(sent.map((s) => s.data).join('')).toBe(flood)
  })

  it('an ack that is not a positive count is ignored', () => {
    const { out, sent } = makeOutput()
    out.attach('t')
    out.push('t', 'x'.repeat(FLOW_SEND_HIGH * 2))
    vi.runAllTimers()
    const held = sent.length
    for (const bad of [0, -FLOW_SEND_HIGH, NaN, Infinity, String(FLOW_SEND_HIGH)]) out.ack('t', bad)
    vi.runAllTimers()
    expect(sent).toHaveLength(held)
  })

  it('an attached tab whose backlog passes the pause watermark pauses its pty, and resumes once it drains', () => {
    const { out, calls, drainAcking } = makeOutput()
    out.attach('t')
    out.push('t', 'x'.repeat(FLOW_QUEUE_PAUSE + 2 * FLOW_SLICE_UTF16_UNITS))
    expect(calls).toEqual(['pause t'])
    drainAcking()
    expect(calls).toEqual(['pause t', 'resume t'])
  })

  it('a tab no view shows yet never pauses its pty: past its cap the oldest output goes and the newest stays', () => {
    const { out, sent, calls } = makeOutput()
    const half = HELD_FOR_AN_UNSEEN_TAB_MAX / 2
    out.push('t', 'a'.repeat(half))
    out.push('t', 'b'.repeat(half))
    out.push('t', 'newest')
    vi.runAllTimers()
    expect(calls).toEqual([])
    out.attach('t')
    vi.runAllTimers()
    expect(sent.map((s) => s.data).join('')).toBe('b'.repeat(half) + 'newest')
  })

  it('with no window to show it, output is dropped and never pauses the pty', () => {
    const { out, sent, calls } = makeOutput({ rendererUp: false })
    out.push('t', 'x'.repeat(FLOW_QUEUE_PAUSE + 1))
    out.attach('t')
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

  it('a tab that ends unpauses its pty, and a new pty on the same tab id waits for its view to attach again', () => {
    const { out, sent, calls } = makeOutput()
    out.attach('t')
    out.push('t', 'x'.repeat(FLOW_QUEUE_PAUSE + 2 * FLOW_SLICE_UTF16_UNITS))
    out.end('t', false)
    expect(calls).toEqual(['pause t', 'resume t'])
    const before = sent.length
    out.push('t', 'restarted$ ')
    vi.runAllTimers()
    expect(sent).toHaveLength(before)
    out.attach('t')
    vi.runAllTimers()
    expect(sent.at(-1)).toEqual({ id: 't', data: 'restarted$ ' })
  })

  it('when the window goes, every paused pty resumes and held output is dropped; the new window starts each tab detached, with no flow stats left from the old one', () => {
    const { out, sent, calls } = makeOutput()
    out.attach('a')
    out.push('a', 'x'.repeat(FLOW_QUEUE_PAUSE + 2 * FLOW_SLICE_UTF16_UNITS))
    out.push('b', 'unseen')
    out.clear()
    expect(calls).toEqual(['pause a', 'resume a'])
    expect(out.stats()).toEqual([])
    const before = sent.length
    vi.runAllTimers()
    out.push('a', 'after reload')
    vi.runAllTimers()
    expect(sent).toHaveLength(before)
    out.attach('a')
    out.attach('b')
    vi.runAllTimers()
    expect(sent.slice(before)).toEqual([{ id: 'a', data: 'after reload' }])
  })

  it('flow stats report each tab the view attached, with what was sent and acked', () => {
    const { out, drainAcking } = makeOutput()
    out.attach('t')
    out.push('t', 'hello')
    drainAcking()
    expect(out.stats()).toMatchObject([{ tabId: 't', sentUnits: 5, ackedUnits: 5, attached: true }])
  })
})

describe('TerminalOutput — a tab off screen gets its output in fewer, larger batches', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const offScreenTab = (): ReturnType<typeof makeOutput> => {
    const o = makeOutput()
    o.out.attach('t')
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
    // PLATFORM§35 CODEX§37 MUSE§23 AGY§33
    for (const question of [
      '\x1b[6n',
      '\x1b[c',
      '\x1b[>c',
      '\x1b[>q',
      '\x1b[?u',
      '\x1b[?996n',
      '\x1b[?2026$p',
      '\x1b[?2027$p',
      '\x1b]11;?\x07',
      '\x1b]10;?\x1b\\',
      '\x1b]4;15;?\x07',
      '\x1b]7501;?\x1b\\',
      '\x1b[14;2t'
    ]) {
      const { out, sent } = offScreenTab()
      out.push('t', 'a')
      vi.advanceTimersByTime(1)
      out.push('t', 'b' + question)
      expect(sent.map((s) => s.data)).toEqual(['a', 'b' + question])
      vi.useRealTimers()
    }
  })

  it('a question split across several reads is still not kept waiting', () => {
    const { out, sent } = offScreenTab()
    out.push('t', 'a')
    vi.advanceTimersByTime(1)
    out.push('t', 'b\x1b]')
    out.push('t', '11;')
    out.push('t', '?\x07')
    expect(sent.map((s) => s.data)).toEqual(['a', 'b\x1b]11;?\x07'])
  })

  it('output after a question that went out waits for the batch again', () => {
    const { out, sent } = offScreenTab()
    out.push('t', 'a')
    vi.advanceTimersByTime(1)
    out.push('t', 'b\x1b[6n')
    vi.advanceTimersByTime(1)
    out.push('t', 'c')
    expect(sent.map((s) => s.data)).toEqual(['a', 'b\x1b[6n'])
  })

  it('an off-screen tab the view stops acking still pauses its pty past the watermark', () => {
    const { out, calls } = makeOutput()
    out.attach('t')
    out.onScreen('t', false)
    for (let i = 0; i < 2 * (FLOW_QUEUE_PAUSE / FLOW_SLICE_UTF16_UNITS); i++)
      out.push('t', 'x'.repeat(FLOW_SLICE_UTF16_UNITS))
    expect(calls).toEqual(['pause t'])
  })

  it('a tab that restarts while off screen keeps getting its output in batches', () => {
    const { out, sent } = offScreenTab()
    out.end('t', true)
    out.attach('t')
    out.push('t', 'a')
    vi.advanceTimersByTime(1)
    out.push('t', 'b')
    vi.advanceTimersByTime(PTY_OUTPUT_COALESCE_ONE_FRAME_MS)
    expect(sent.map((s) => s.data)).toEqual(['a'])
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
