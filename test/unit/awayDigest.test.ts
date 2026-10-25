import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import type { AttentionEvent } from '../../src/shared/types'
import {
  AwayDigest,
  BUTLER_CHECKED_AGAIN_MS,
  DIGEST_GATHERS_MS,
  VERDICT_WAITED_AT_MOST_MS
} from '../../src/main/awayDigest'

const LEFT_AT = 1_000

function setup() {
  const state = {
    away: true,
    reachable: true,
    busy: false,
    marks: [] as AttentionEvent[],
    judging: new Set<string>(),
    handedOff: new Set<string>(),
    butlerSide: new Set<string>(),
    replies: new Map<string, string>()
  }
  const told: string[] = []
  const digest = new AwayDigest({
    away: () => state.away,
    lastHandsAt: () => LEFT_AT,
    reachable: () => state.reachable,
    marks: () => state.marks,
    butlerSide: (tab) => state.butlerSide.has(tab),
    judging: (tab) => state.judging.has(tab),
    handedOff: (tab) => state.handedOff.has(tab),
    itemOf: (m) => ({
      kind: m.kind,
      title: m.title,
      sessionId: m.sessionId,
      workspace: 'koloft',
      reply: state.replies.get(m.tabId)
    }),
    butlerBusy: () => state.busy,
    tell: (text) => told.push(text),
    now: Date.now,
    gatherMs: DIGEST_GATHERS_MS
  })
  const mark = (tabId: string, kind: AttentionEvent['kind'], extra: Partial<AttentionEvent> = {}) =>
    state.marks.push({
      tabId,
      kind,
      at: Date.now(),
      title: `${tabId} title`,
      sessionId: `${tabId}-id`,
      ...extra
    })
  return { state, told, digest, mark }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(LEFT_AT + 1)
})
afterEach(() => vi.useRealTimers())

describe('AwayDigest — while the owner is away, what sessions did goes to the butler in one quiet message', () => {
  it('gathers for half a minute, then names each session, where it is and what happened, quoting a finished turn’s reply, and tells the butler how to reach the owner', () => {
    const { state, told, digest, mark } = setup()
    state.replies.set('fix', 'Fixed the login bug.\n\nShall I open the PR?')
    mark('fix', 'turn-done')
    digest.marked()
    mark('deps', 'approval')
    digest.marked()
    vi.advanceTimersByTime(DIGEST_GATHERS_MS - 1)
    expect(told).toEqual([])
    vi.advanceTimersByTime(1)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain(
      '1. "fix title" (session fix-id, workspace koloft) finished its turn and waits; it said: "Fixed the login bug. Shall I open the PR?".'
    )
    expect(told[0]).toContain(
      '2. "deps title" (session deps-id, workspace koloft) waits for an answer or an approval.'
    )
    expect(told[0]).toContain('koloft discord send')
    expect(told[0]).not.toContain('\n')
  })

  it('leaves out the butler and its helpers, a turn marked as only news, a reply already handed to the session that asked for it, and what happened before the owner last touched Koloft', () => {
    const { state, told, digest, mark } = setup()
    state.butlerSide.add('helper')
    state.handedOff.add('child')
    mark('helper', 'approval')
    mark('news', 'turn-done', { fyi: true })
    mark('child', 'turn-done')
    mark('seen', 'turn-done', { at: LEFT_AT - 1 })
    digest.marked()
    vi.advanceTimersByTime(DIGEST_GATHERS_MS)
    expect(told).toEqual([])
    mark('crash', 'exited')
    digest.marked()
    vi.advanceTimersByTime(DIGEST_GATHERS_MS)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('"crash title"')
    expect(told[0]).toContain('stopped unexpectedly')
    expect(told[0]).not.toMatch(/helper|news|child|seen/)
  })

  it('says nothing while the owner is at Koloft, or while Discord cannot reach them', () => {
    const { state, told, digest, mark } = setup()
    state.away = false
    mark('fix', 'turn-done')
    digest.marked()
    vi.advanceTimersByTime(DIGEST_GATHERS_MS)
    state.away = true
    state.reachable = false
    digest.marked()
    vi.advanceTimersByTime(DIGEST_GATHERS_MS)
    expect(told).toEqual([])
  })

  it('once the owner turns out to be away, hands over what happened since they last touched Koloft, and each thing only once', () => {
    const { state, told, digest, mark } = setup()
    state.away = false
    digest.check()
    mark('fix', 'turn-done')
    state.away = true
    digest.check()
    vi.advanceTimersByTime(DIGEST_GATHERS_MS)
    expect(told).toHaveLength(1)
    digest.check()
    digest.marked()
    vi.advanceTimersByTime(DIGEST_GATHERS_MS)
    expect(told).toHaveLength(1)
    vi.advanceTimersByTime(1)
    mark('fix', 'approval')
    digest.marked()
    vi.advanceTimersByTime(DIGEST_GATHERS_MS)
    expect(told).toHaveLength(2)
  })

  it('waits up to a minute for the Assist to judge a finished turn, leaving it out when it was only news, and hands the rest on after a minute either way', () => {
    const { state, told, digest, mark } = setup()
    mark('news', 'turn-done')
    mark('slow', 'turn-done')
    state.judging.add('news')
    state.judging.add('slow')
    digest.marked()
    vi.advanceTimersByTime(DIGEST_GATHERS_MS)
    expect(told).toEqual([])
    state.judging.delete('news')
    state.marks[0].fyi = true
    vi.advanceTimersByTime(VERDICT_WAITED_AT_MOST_MS)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('"slow title"')
    expect(told[0]).not.toContain('"news title"')
  })

  it('waits while the butler is in the middle of a turn, so the notice never joins a turn the owner’s words are in', () => {
    const { state, told, digest, mark } = setup()
    state.busy = true
    mark('fix', 'turn-done')
    digest.marked()
    vi.advanceTimersByTime(DIGEST_GATHERS_MS + 10 * BUTLER_CHECKED_AGAIN_MS)
    expect(told).toEqual([])
    state.busy = false
    vi.advanceTimersByTime(BUTLER_CHECKED_AGAIN_MS)
    expect(told).toHaveLength(1)
  })
})
