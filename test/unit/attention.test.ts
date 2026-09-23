import { describe, it, expect } from 'vitest'
import { AttentionTracker, type AttentionContext } from '../../src/main/attention'
import type { AttentionEvent } from '../../src/shared/types'

const UNFOCUSED: AttentionContext = { windowFocused: false, activeTabId: 'tab-A' }
const WATCHING_A: AttentionContext = { windowFocused: true, activeTabId: 'tab-A' }

function makeTracker(): {
  t: AttentionTracker
  changes: { pending: AttentionEvent[]; event: AttentionEvent | null }[]
} {
  const changes: { pending: AttentionEvent[]; event: AttentionEvent | null }[] = []
  const t = new AttentionTracker((pending, event) => changes.push({ pending, event }))
  return { t, changes }
}

describe('attention — raising events from status transitions', () => {
  it('working→waiting pends a turn-done with a raised event', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting', UNFOCUSED)
    expect(t.list()).toEqual([expect.objectContaining({ tabId: 'tab-A', kind: 'turn-done' })])
    expect(changes[0].event).toMatchObject({ tabId: 'tab-A', kind: 'turn-done' })
  })

  it('any→approval pends approval — even without a working prefix', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'waiting', 'approval', UNFOCUSED)
    expect(t.list()).toEqual([expect.objectContaining({ kind: 'approval' })])
  })

  it('waiting→idle is a visual downgrade, not a new event', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'waiting', 'idle', UNFOCUSED)
    expect(t.list()).toEqual([])
    expect(changes).toEqual([])
  })

  it('a hard exit pends exited', () => {
    const { t } = makeTracker()
    t.onExited('tab-A', UNFOCUSED)
    expect(t.list()).toEqual([expect.objectContaining({ kind: 'exited' })])
  })

  it('an undefined prev (first report) going to waiting does NOT pend — no turn ran', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', undefined, 'waiting', UNFOCUSED)
    expect(t.list()).toEqual([])
  })
})

describe('attention — approval→waiting is a finished turn (Stop can beat the jsonl poll)', () => {
  it('raises turn-done when the approval marker was already consumed', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'waiting', 'approval', UNFOCUSED)
    t.clear('tab-A')
    t.onStatusChange('tab-A', 'approval', 'waiting', UNFOCUSED)
    expect(t.list()).toEqual([expect.objectContaining({ tabId: 'tab-A', kind: 'turn-done' })])
    expect(changes.at(-1)?.event).toMatchObject({ kind: 'turn-done' })
  })

  it('keeps the approval marker when it is STILL pending (TUI nudge, prompt still up)', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'waiting', 'approval', UNFOCUSED)
    t.onStatusChange('tab-A', 'approval', 'waiting', UNFOCUSED)
    expect(t.list()).toEqual([expect.objectContaining({ kind: 'approval' })])
  })
})

describe('attention — precedence: approval outranks turn-done, exited replaces all', () => {
  it('approval is not masked by a later turn-done for the same tab', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'waiting', 'approval', UNFOCUSED)
    t.onStatusChange('tab-A', 'working', 'waiting', UNFOCUSED)
    expect(t.list()).toEqual([expect.objectContaining({ kind: 'approval' })])
  })

  it('turn-done upgrades to approval', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting', UNFOCUSED)
    t.onStatusChange('tab-A', 'waiting', 'approval', UNFOCUSED)
    expect(t.list()).toEqual([expect.objectContaining({ kind: 'approval' })])
  })

  it('exited REPLACES a live approval — a dead session must never advertise a prompt', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'waiting', 'approval', UNFOCUSED)
    t.onExited('tab-A', UNFOCUSED)
    expect(t.list()).toEqual([expect.objectContaining({ kind: 'exited' })])
  })

  it('back to working clears the pending marker and emits a clear', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting', UNFOCUSED)
    t.onStatusChange('tab-A', 'waiting', 'working', UNFOCUSED)
    expect(t.list()).toEqual([])
    expect(changes.at(-1)).toMatchObject({ event: null, pending: [] })
  })
})

describe('attention — title snapshot survives the session it names', () => {
  it('the raise-time title rides on the event (an exited session is untracked later)', () => {
    const { t } = makeTracker()
    t.onExited('tab-A', UNFOCUSED, 'Fix the WebGL garbling')
    expect(t.list()).toEqual([expect.objectContaining({ title: 'Fix the WebGL garbling' })])
  })
})

describe('attention — reconsider (stale-context suppression race)', () => {
  it('a just-suppressed event is re-raised when the user switches away in time', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting', WATCHING_A)
    expect(t.list()).toEqual([])
    t.reconsider('tab-A', { windowFocused: true, activeTabId: 'tab-B' })
    expect(t.list()).toEqual([expect.objectContaining({ tabId: 'tab-A', kind: 'turn-done' })])
  })

  it('an old suppressed event is NOT resurrected (the user really saw it)', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting', WATCHING_A)
    t.reconsider('tab-A', { windowFocused: true, activeTabId: 'tab-B' }, -1)
    expect(t.list()).toEqual([])
  })

  it('a new turn obsoletes the swallowed edge — no zombie re-raise after working', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting', WATCHING_A)
    t.onStatusChange('tab-A', 'waiting', 'working', WATCHING_A)
    t.reconsider('tab-A', { windowFocused: true, activeTabId: 'tab-B' })
    expect(t.list()).toEqual([])
  })
})

describe('attention — same-kind re-raise refreshes silently', () => {
  it('turn N+1 finishing behind an unconsumed turn-done updates the marker, no new event', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting', UNFOCUSED)
    const eventsBefore = changes.filter((c) => c.event).length
    t.onStatusChange('tab-A', 'working', 'waiting', UNFOCUSED)
    expect(t.list()).toHaveLength(1)
    expect(changes.filter((c) => c.event).length).toBe(eventsBefore)
  })
})

describe('attention — resurrected events carry the flag', () => {
  it('a reconsider re-raise is marked resurrected so outlets can stay silent', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting', WATCHING_A)
    t.reconsider('tab-A', { windowFocused: true, activeTabId: 'tab-B' })
    const raised = changes.filter((c) => c.event).at(-1)?.event
    expect(raised).toMatchObject({ tabId: 'tab-A', resurrected: true })
    const { t: t2, changes: ch2 } = makeTracker()
    t2.onStatusChange('tab-B', 'working', 'waiting', UNFOCUSED)
    expect(ch2.at(-1)?.event?.resurrected).toBeFalsy()
  })
})

describe('attention — the one suppression rule', () => {
  it('never pends for the tab the user is watching (focused + active)', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting', WATCHING_A)
    t.onStatusChange('tab-A', 'waiting', 'approval', WATCHING_A)
    t.onExited('tab-A', WATCHING_A)
    expect(t.list()).toEqual([])
    expect(changes).toEqual([])
  })

  it('a background tab pends even while the window is focused', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-B', 'working', 'waiting', WATCHING_A)
    expect(t.list()).toEqual([expect.objectContaining({ tabId: 'tab-B' })])
  })

  it('the active tab pends when the window is unfocused (user is elsewhere)', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting', UNFOCUSED)
    expect(t.list()).toEqual([expect.objectContaining({ tabId: 'tab-A' })])
  })
})

describe('attention — clearing', () => {
  it('clear removes exactly that tab and emits; clearing nothing stays silent', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting', UNFOCUSED)
    t.onStatusChange('tab-B', 'working', 'waiting', UNFOCUSED)
    t.clear('tab-A')
    expect(t.list()).toEqual([expect.objectContaining({ tabId: 'tab-B' })])
    const before = changes.length
    t.clear('tab-A')
    expect(changes.length).toBe(before)
  })
})
