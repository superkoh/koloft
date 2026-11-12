import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { enrollWebgl, hideWebgl, releaseWebgl, showWebgl } from '../../src/renderer/src/webglPool'

const live = new Set<string>()
const events: string[] = []
const enrolled: string[] = []
let peak = 0

function enroll(id: string): void {
  enrollWebgl(
    id,
    () => {
      live.add(id)
      peak = Math.max(peak, live.size)
      events.push(`attach ${id}`)
    },
    () => {
      live.delete(id)
      events.push(`detach ${id}`)
    }
  )
  enrolled.push(id)
}

function glance(id: string): void {
  showWebgl(id)
  hideWebgl(id)
}

function switchAsReactDoes(from: string, to: string): void {
  hideWebgl(from)
  showWebgl(to)
}

const LONGER_THAN_THE_HAND_BACK_DELAY_MS = 2000
const SHORTER_THAN_THE_HAND_BACK_DELAY_MS = 600

function letTheSwitchSettle(): void {
  vi.advanceTimersByTime(LONGER_THAN_THE_HAND_BACK_DELAY_MS)
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const id of enrolled.splice(0)) releaseWebgl(id)
  live.clear()
  events.length = 0
  peak = 0
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('webglPool', () => {
  it('a terminal mounted but never shown holds no context; it takes one the first time it is shown', () => {
    for (let i = 1; i <= 20; i++) enroll(`t${i}`)
    expect(live.size).toBe(0)

    showWebgl('t5')
    expect(events).toEqual(['attach t5'])
  })

  it('once a switch has settled, only the two hidden terminals looked at last keep a context: the older ones are handed back, and showing one of those again re-attaches it', () => {
    for (let i = 1; i <= 4; i++) enroll(`t${i}`)
    showWebgl('t1')
    switchAsReactDoes('t1', 't2')
    switchAsReactDoes('t2', 't3')

    events.length = 0
    switchAsReactDoes('t3', 't4')
    expect(events).toEqual(['attach t4'])
    letTheSwitchSettle()
    expect(events).toEqual(['attach t4', 'detach t1'])

    events.length = 0
    switchAsReactDoes('t4', 't1')
    letTheSwitchSettle()
    expect(events).toEqual(['attach t1', 'detach t2'])
  })

  it('switching back to either kept hidden terminal re-attaches nothing, though the terminal being left is hidden before the other is shown', () => {
    for (let i = 1; i <= 3; i++) enroll(`t${i}`)
    showWebgl('t1')
    switchAsReactDoes('t1', 't2')
    switchAsReactDoes('t2', 't3')
    letTheSwitchSettle()

    events.length = 0
    switchAsReactDoes('t3', 't1')
    letTheSwitchSettle()
    switchAsReactDoes('t1', 't3')
    letTheSwitchSettle()
    expect(events).toEqual([])
  })

  it('the terminal on screen hidden and shown again in one go costs no hidden terminal its context', () => {
    for (let i = 1; i <= 3; i++) enroll(`t${i}`)
    showWebgl('t1')
    switchAsReactDoes('t1', 't2')
    switchAsReactDoes('t2', 't3')
    letTheSwitchSettle()

    events.length = 0
    switchAsReactDoes('t3', 't3')
    letTheSwitchSettle()
    expect(events).toEqual([])
  })

  it('switching again and again without a pause still hands the older hidden terminals back', () => {
    for (let i = 1; i <= 8; i++) enroll(`t${i}`)
    showWebgl('t1')
    for (let i = 1; i < 8; i++) {
      switchAsReactDoes(`t${i}`, `t${i + 1}`)
      vi.advanceTimersByTime(SHORTER_THAN_THE_HAND_BACK_DELAY_MS)
    }
    expect(peak).toBeLessThanOrEqual(5)
  })

  it('terminals on screen together all keep their context, and a hidden one is handed back only when a third joins the hidden ones', () => {
    for (let i = 1; i <= 6; i++) enroll(`t${i}`)
    for (let i = 1; i <= 6; i++) showWebgl(`t${i}`)
    letTheSwitchSettle()
    expect(live.size).toBe(6)

    events.length = 0
    hideWebgl('t1')
    hideWebgl('t2')
    letTheSwitchSettle()
    expect(events).toEqual([])
    hideWebgl('t3')
    letTheSwitchSettle()
    expect(events).toEqual(['detach t1'])
  })

  it('keeps at most 12 live contexts: a 13th terminal on screen takes the context of a hidden holder before that of one still on screen', () => {
    for (let i = 1; i <= 14; i++) enroll(`t${i}`)
    for (let i = 1; i <= 11; i++) showWebgl(`t${i}`)
    glance('t12')

    events.length = 0
    showWebgl('t13')
    expect(events).toEqual(['detach t12', 'attach t13'])

    events.length = 0
    showWebgl('t14')
    expect(events).toEqual(['detach t1', 'attach t14'])
    expect(peak).toBe(12)
  })

  it('a terminal whose WebGL fails to attach and releases itself does not keep a slot', () => {
    for (let i = 1; i <= 11; i++) {
      enroll(`t${i}`)
      showWebgl(`t${i}`)
    }
    enrollWebgl(
      'broken',
      () => releaseWebgl('broken'),
      () => {}
    )
    showWebgl('broken')

    enroll('t13')
    events.length = 0
    showWebgl('t13')
    expect(events).toEqual(['attach t13'])
  })
})
