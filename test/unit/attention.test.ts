import { describe, it, expect } from 'vitest'
import { AttentionTracker, type SavedMark } from '../../src/main/attention'
import type { AttentionEvent } from '../../src/shared/types'

function makeTracker(lastRun?: SavedMark[]): {
  t: AttentionTracker
  changes: { pending: AttentionEvent[]; event: AttentionEvent | null }[]
} {
  const changes: { pending: AttentionEvent[]; event: AttentionEvent | null }[] = []
  const t = new AttentionTracker((pending, event) => changes.push({ pending, event }), lastRun)
  return { t, changes }
}

describe('attention — raising events from status transitions', () => {
  it('working→waiting pends a turn-done with a raised event', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting')
    expect(t.list()).toEqual([expect.objectContaining({ tabId: 'tab-A', kind: 'turn-done' })])
    expect(changes[0].event).toMatchObject({ tabId: 'tab-A', kind: 'turn-done' })
  })

  it('any→approval pends approval — even without a working prefix', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'waiting', 'approval')
    expect(t.list()).toEqual([expect.objectContaining({ kind: 'approval' })])
  })

  it('waiting→idle is a visual downgrade, not a new event', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'waiting', 'idle')
    expect(t.list()).toEqual([])
    expect(changes).toEqual([])
  })

  it('a hard exit pends exited', () => {
    const { t } = makeTracker()
    t.onExited('tab-A')
    expect(t.list()).toEqual([expect.objectContaining({ kind: 'exited' })])
  })

  it('an undefined prev (first report) going to waiting does NOT pend — no turn ran', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', undefined, 'waiting')
    expect(t.list()).toEqual([])
  })
})

describe('attention — a mark stays until the session moves again', () => {
  it('only the session going back to work clears it, with a clear event', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting')
    t.onStatusChange('tab-A', 'waiting', 'idle')
    expect(t.list()).toEqual([expect.objectContaining({ kind: 'turn-done' })])
    t.onStatusChange('tab-A', 'idle', 'working')
    expect(t.list()).toEqual([])
    expect(changes.at(-1)).toMatchObject({ event: null, pending: [] })
  })

  it('an approval the turn finished past becomes "your move", and is raised as such', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'waiting', 'approval')
    t.onStatusChange('tab-A', 'approval', 'waiting')
    expect(t.list()).toEqual([expect.objectContaining({ tabId: 'tab-A', kind: 'turn-done' })])
    expect(changes.at(-1)?.event).toMatchObject({ kind: 'turn-done' })
  })

  it('turn-done upgrades to approval', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting')
    t.onStatusChange('tab-A', 'waiting', 'approval')
    expect(t.list()).toEqual([expect.objectContaining({ kind: 'approval' })])
  })

  it('exited REPLACES a live approval — a dead session must never advertise a prompt', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'waiting', 'approval')
    t.onExited('tab-A')
    expect(t.list()).toEqual([expect.objectContaining({ kind: 'exited' })])
  })

  it('only an approval holds its tab awake', () => {
    const { t } = makeTracker()
    t.onStatusChange('tab-A', 'waiting', 'approval')
    t.onStatusChange('tab-B', 'working', 'waiting')
    expect(t.waitsOnApproval('tab-A')).toBe(true)
    expect(t.waitsOnApproval('tab-B')).toBe(false)
  })
})

describe('attention — title and session snapshot survive the session they name', () => {
  it('the raise-time title and session id ride on the event (an exited session is untracked later)', () => {
    const { t } = makeTracker()
    t.onExited('tab-A', { title: 'Fix the WebGL garbling', sessionId: 'sid-A' })
    expect(t.list()).toEqual([
      expect.objectContaining({ title: 'Fix the WebGL garbling', sessionId: 'sid-A' })
    ])
  })

  it('clearing a session drops its mark, whatever tab raised it', () => {
    const { t, changes } = makeTracker()
    t.onExited('tab-A', { sessionId: 'sid-A' })
    t.onExited('tab-B', { sessionId: 'sid-B' })
    t.clearSession('sid-A')
    expect(t.list()).toEqual([expect.objectContaining({ tabId: 'tab-B' })])
    expect(changes.at(-1)).toMatchObject({ event: null })
  })
})

describe('attention — unread marks outlive a Koloft restart', () => {
  const lastRun: SavedMark[] = [
    { tabId: 'old-1', kind: 'turn-done', at: 1, title: 'Done one', sessionId: 'sid-1' },
    { tabId: 'old-2', kind: 'approval', at: 2, sessionId: 'sid-2' }
  ]

  it('loads the last run’s marks silently — no notification or sound on launch', () => {
    const { t, changes } = makeTracker(lastRun)
    expect(changes).toEqual([])
    expect(t.list()).toEqual([
      expect.objectContaining({ sessionId: 'sid-1', kind: 'turn-done' }),
      expect.objectContaining({ sessionId: 'sid-2' })
    ])
  })

  it('an approval from the last run comes back as turn-done — the prompt died with the process', () => {
    const { t } = makeTracker(lastRun)
    expect(t.list().find((e) => e.sessionId === 'sid-2')?.kind).toBe('turn-done')
  })
})

describe('attention — a session starting again keeps its mark', () => {
  it('moves the mark onto the new tab as turn-done, silently', () => {
    const { t, changes } = makeTracker()
    t.onExited('tab-old', { title: 'Done one', sessionId: 'sid-1' })
    t.bound('tab-new', 'sid-1')
    expect(t.list()).toEqual([
      expect.objectContaining({ tabId: 'tab-new', kind: 'turn-done', title: 'Done one' })
    ])
    expect(changes.at(-1)?.event).toMatchObject({ resurrected: true })
  })
})

describe('attention — same-kind re-raise refreshes silently', () => {
  it('turn N+1 finishing behind an unconsumed turn-done updates the marker, no new event', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting')
    const eventsBefore = changes.filter((c) => c.event).length
    t.onStatusChange('tab-A', 'working', 'waiting')
    expect(t.list()).toHaveLength(1)
    expect(changes.filter((c) => c.event).length).toBe(eventsBefore)
  })
})

describe('attention — clearing', () => {
  it('clear removes exactly that tab and emits; clearing nothing stays silent', () => {
    const { t, changes } = makeTracker()
    t.onStatusChange('tab-A', 'working', 'waiting')
    t.onStatusChange('tab-B', 'working', 'waiting')
    t.clear('tab-A')
    expect(t.list()).toEqual([expect.objectContaining({ tabId: 'tab-B' })])
    const before = changes.length
    t.clear('tab-A')
    expect(changes.length).toBe(before)
  })
})
