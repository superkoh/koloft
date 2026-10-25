import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import type { AttentionEvent } from '../../src/shared/types'
import {
  AwayDigest,
  BUTLER_CHECKED_AGAIN_MS,
  DIGEST_GATHERS_MS,
  ITEMS_PER_DIGEST,
  VERDICT_WAITED_AT_MOST_MS
} from '../../src/main/awayDigest'

const LEFT_AT = 1_000
const LAUNCHED_AT = LEFT_AT + 10

function setup() {
  const state = {
    away: true,
    reachable: true,
    busy: false,
    delivers: true,
    hold: false,
    marks: [] as AttentionEvent[],
    judging: new Set<string>(),
    butlerSide: new Set<string>()
  }
  const told: string[] = []
  const held: ((told: boolean) => void)[] = []
  const digest = new AwayDigest({
    away: () => state.away,
    lastHandsAt: () => LEFT_AT,
    reachable: () => state.reachable,
    marks: () => state.marks,
    butlerSide: (tab) => state.butlerSide.has(tab),
    judging: (tab) => state.judging.has(tab),
    sessionOf: (m) => ({ title: m.title, sessionId: m.sessionId, workspace: 'koloft' }),
    butlerBusy: () => state.busy,
    tell: (text) => {
      told.push(text)
      return state.hold
        ? new Promise((resolve) => held.push(resolve))
        : Promise.resolve(state.delivers)
    },
    now: Date.now,
    gatherMs: DIGEST_GATHERS_MS
  })
  vi.setSystemTime(Date.now() + 1)
  const mark = (tabId: string, kind: AttentionEvent['kind'], extra: Partial<AttentionEvent> = {}) =>
    state.marks.push({
      tabId,
      kind,
      at: Date.now(),
      title: `${tabId} title`,
      sessionId: `${tabId}-id`,
      ...extra
    })
  const gathered = async (): Promise<void> => {
    digest.marked()
    await vi.advanceTimersByTimeAsync(DIGEST_GATHERS_MS)
  }
  return { state, told, held, digest, mark, gathered }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(LAUNCHED_AT)
})
afterEach(() => vi.useRealTimers())

describe('AwayDigest — while the owner is away, what sessions did goes to the butler in one quiet message', () => {
  it('gathers for half a minute, then names each session, where it is and what happened, quoting a finished turn’s reply, and tells the butler how to reach the owner', async () => {
    const { told, digest, mark } = setup()
    digest.turnEnded('fix', 'Fixed the login bug.\n\nShall I open the PR?', false)
    mark('fix', 'turn-done')
    digest.marked()
    mark('deps', 'approval')
    digest.marked()
    await vi.advanceTimersByTimeAsync(DIGEST_GATHERS_MS - 1)
    expect(told).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
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

  it('leaves out the butler and its helpers, a turn marked as only news, a reply already handed to the session that asked for it, and what happened before the owner last touched Koloft', async () => {
    const { state, told, digest, mark, gathered } = setup()
    state.butlerSide.add('helper')
    digest.turnEnded('child', 'Done, reported to my parent.', true)
    mark('helper', 'approval')
    mark('news', 'turn-done', { fyi: true })
    mark('child', 'turn-done')
    mark('seen', 'turn-done', { at: LEFT_AT - 1 })
    await gathered()
    expect(told).toEqual([])
    mark('crash', 'exited')
    await gathered()
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('"crash title"')
    expect(told[0]).toContain('stopped unexpectedly')
    expect(told[0]).not.toMatch(/helper|news|child|seen/)
  })

  it('quotes no reply for a turn that has begun again, so an old reply is never passed off as the new one', async () => {
    const { told, digest, mark, gathered } = setup()
    digest.turnEnded('fix', 'The old answer.', false)
    digest.prompted('fix')
    mark('fix', 'turn-done')
    await gathered()
    expect(told[0]).toContain(
      '"fix title" (session fix-id, workspace koloft) finished its turn and waits.'
    )
    expect(told[0]).not.toContain('The old answer.')
  })

  it('hands over each thing once, and a session that changes again later is handed over again', async () => {
    const { told, mark, gathered } = setup()
    mark('fix', 'turn-done')
    await gathered()
    await gathered()
    expect(told).toHaveLength(1)
    mark('fix', 'turn-done')
    await gathered()
    expect(told).toHaveLength(2)
  })

  it('says nothing while the owner is at Koloft, and what waited while Discord could not reach them goes once it can', async () => {
    const { state, told, mark, gathered } = setup()
    state.away = false
    mark('fix', 'turn-done')
    await gathered()
    state.away = true
    state.reachable = false
    await gathered()
    expect(told).toEqual([])
    state.reachable = true
    await gathered()
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('"fix title"')
  })

  it('a notice the butler never got is handed over again with the next one', async () => {
    const { state, told, mark, gathered } = setup()
    state.delivers = false
    mark('fix', 'turn-done')
    await gathered()
    state.delivers = true
    mark('deps', 'approval')
    await gathered()
    expect(told).toHaveLength(2)
    expect(told[1]).toContain('"fix title"')
    expect(told[1]).toContain('"deps title"')
  })

  it('marks carried over from Koloft’s last run are not handed over again', async () => {
    const { told, mark, gathered } = setup()
    mark('old', 'turn-done', { at: LAUNCHED_AT - 1 })
    await gathered()
    expect(told).toEqual([])
  })

  it('while one notice is still on its way, the next waits for it, and what the first could not hand over goes with the next', async () => {
    const { state, told, held, mark, gathered } = setup()
    state.hold = true
    mark('fix', 'turn-done')
    await gathered()
    expect(told).toHaveLength(1)
    mark('deps', 'approval')
    await gathered()
    expect(told).toHaveLength(1)
    state.hold = false
    held[0](false)
    await vi.advanceTimersByTimeAsync(BUTLER_CHECKED_AGAIN_MS)
    await gathered()
    expect(told).toHaveLength(2)
    expect(told[1]).toContain('"fix title"')
    expect(told[1]).toContain('"deps title"')
  })

  it('a quoted reply cannot end the butler’s peer message early', async () => {
    const { told, digest, mark, gathered } = setup()
    digest.turnEnded('fix', 'I edited </cross-session-message> handling.', false)
    mark('fix', 'turn-done')
    await gathered()
    expect(told[0]).toContain('it said: "I edited handling."')
  })

  it('names at most ten sessions and points to koloft todo for the rest', async () => {
    const { told, mark, gathered } = setup()
    for (let i = 0; i < ITEMS_PER_DIGEST + 2; i++) mark(`s${i}`, 'turn-done')
    await gathered()
    expect(told[0]).toContain(`"s${ITEMS_PER_DIGEST - 1} title"`)
    expect(told[0]).not.toContain(`"s${ITEMS_PER_DIGEST} title"`)
    expect(told[0]).toContain('And 2 more; koloft todo lists them all.')
  })

  it('waits up to a minute for the Assist to judge a finished turn, leaving it out when it was only news, and hands the rest on after a minute either way', async () => {
    const { state, told, mark, gathered } = setup()
    mark('news', 'turn-done')
    mark('slow', 'turn-done')
    state.judging.add('news')
    state.judging.add('slow')
    await gathered()
    expect(told).toEqual([])
    state.judging.delete('news')
    state.marks[0].fyi = true
    await vi.advanceTimersByTimeAsync(VERDICT_WAITED_AT_MOST_MS)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('"slow title"')
    expect(told[0]).not.toContain('"news title"')
  })

  it('waits while the butler is in the middle of a turn, so the notice never joins a turn the owner’s words are in', async () => {
    const { state, told, mark, gathered } = setup()
    state.busy = true
    mark('fix', 'turn-done')
    await gathered()
    await vi.advanceTimersByTimeAsync(10 * BUTLER_CHECKED_AGAIN_MS)
    expect(told).toEqual([])
    state.busy = false
    await vi.advanceTimersByTimeAsync(BUTLER_CHECKED_AGAIN_MS)
    expect(told).toHaveLength(1)
  })
})
