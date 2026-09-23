import { describe, it, expect } from 'vitest'
import {
  firedHints,
  rowSelector,
  wbTabSelector,
  type HintSnapshot
} from '../../src/renderer/src/hints'

// Layer B. Each trigger is a TRANSITION, and the costly mistakes are all "fires when
// it should not": on a tab switch onto a session that wrote long ago, on the row the user
// is already looking at, on a resume replaying its own last write, on a page opened in a
// session nobody is looking at, and on a second session started somewhere quiet.
const empty: HintSnapshot = {
  activeTabId: null,
  githubBtn: false,
  agentOpen: null,
  sessions: [],
  rows: []
}
const snap = (s: Partial<HintSnapshot>): HintSnapshot => ({ ...empty, ...s })
const ws = (path: string, rows: HintSnapshot['rows'][number]['rows']) => ({
  workspace: { path },
  rows
})
const running = (id: string) => ({ id, worktree: 'main', running: true })
const cold = (id: string) => ({ id, worktree: 'main', running: false })
const launch = (id: string) => ({ id, worktree: 'main', running: false, pending: true })

describe('firedHints — workbench', () => {
  it('fires when the tab on screen writes a file', () => {
    const prev = snap({
      activeTabId: 't1',
      sessions: [{ tabId: 't1', status: 'working' }]
    })
    const next = snap({
      activeTabId: 't1',
      sessions: [{ tabId: 't1', status: 'working', liveWrites: 1 }]
    })
    expect(firedHints(prev, next)).toEqual([{ id: 'workbench', selector: '.aux-ico.wb-toggle' }])
  })

  // a short turn: the write and the turn's end land in the same push, so the session
  // is already waiting by the time the write is seen — it still happened
  it('fires when the write and the turn end arrive together', () => {
    const prev = snap({ activeTabId: 't1', sessions: [{ tabId: 't1', status: 'working' }] })
    const next = snap({
      activeTabId: 't1',
      sessions: [{ tabId: 't1', status: 'waiting', liveWrites: 1 }]
    })
    expect(firedHints(prev, next).map((f) => f.id)).toEqual(['workbench'])
  })

  it('stays quiet when a switch merely lands on a session that wrote earlier', () => {
    const sessions = [{ tabId: 't1' }, { tabId: 't2', status: 'working' as const, liveWrites: 3 }]
    const prev = snap({ activeTabId: 't1', sessions })
    const next = snap({ activeTabId: 't2', sessions })
    expect(firedHints(prev, next)).toEqual([])
  })

  // a resume: the catch-up parse replays the transcript's writes, which the tracker
  // does not count as live — nothing Claude did just now
  it('stays quiet when a resumed session replays its history', () => {
    const prev = snap({ activeTabId: 't1', sessions: [{ tabId: 't1' }] })
    const next = snap({
      activeTabId: 't1',
      sessions: [{ tabId: 't1', status: 'working', liveWrites: 0 }]
    })
    expect(firedHints(prev, next)).toEqual([])
  })

  it('fires again for a later write', () => {
    const prev = snap({
      activeTabId: 't1',
      sessions: [{ tabId: 't1', status: 'working', liveWrites: 1 }]
    })
    const next = snap({
      activeTabId: 't1',
      sessions: [{ tabId: 't1', status: 'working', liveWrites: 2 }]
    })
    expect(firedHints(prev, next).map((f) => f.id)).toEqual(['workbench'])
  })
})

describe('firedHints — agent-web', () => {
  const opened = (nonce: number, ownerTabId = 't1') => ({ ownerTabId, tabId: 'wb-9', nonce })

  it('fires for a page the shim opened in the session on screen', () => {
    const prev = snap({ activeTabId: 't1' })
    const next = snap({ activeTabId: 't1', agentOpen: opened(1) })
    expect(firedHints(prev, next)).toEqual([{ id: 'agent-web', selector: wbTabSelector('wb-9') }])
  })

  it('stays quiet when the page landed in a session that is not on screen', () => {
    const prev = snap({ activeTabId: 't1' })
    const next = snap({ activeTabId: 't1', agentOpen: opened(1, 't2') })
    expect(firedHints(prev, next)).toEqual([])
  })

  // the card is spent on the open itself, not on later switching onto the session
  it('does not fire again while the same open sits in the store', () => {
    const prev = snap({ activeTabId: 't2', agentOpen: opened(1) })
    const next = snap({ activeTabId: 't1', agentOpen: opened(1) })
    expect(firedHints(prev, next)).toEqual([])
  })
})

describe('firedHints — approval', () => {
  it('fires for a row that is not the one on screen', () => {
    const prev = snap({ activeTabId: 't1', sessions: [{ tabId: 't1' }, { tabId: 't2' }] })
    const next = snap({
      activeTabId: 't1',
      sessions: [{ tabId: 't1' }, { tabId: 't2', status: 'approval' }]
    })
    expect(firedHints(prev, next)).toEqual([{ id: 'approval', selector: rowSelector('t2') }])
  })

  it('stays quiet when the amber row IS the one on screen', () => {
    const prev = snap({ activeTabId: 't2', sessions: [{ tabId: 't2' }] })
    const next = snap({ activeTabId: 't2', sessions: [{ tabId: 't2', status: 'approval' }] })
    expect(firedHints(prev, next)).toEqual([])
  })

  it('does not re-fire while the row stays amber', () => {
    const prev = snap({ activeTabId: 't1', sessions: [{ tabId: 't2', status: 'approval' }] })
    const next = snap({
      activeTabId: 't1',
      sessions: [{ tabId: 't2', status: 'approval', liveWrites: 1 }]
    })
    expect(firedHints(prev, next)).toEqual([])
  })
})

describe('firedHints — worktree', () => {
  it('fires for a launch into a workspace that already runs one', () => {
    const prev = snap({ rows: [ws('/a', [running('s1')])] })
    const next = snap({
      rows: [ws('/a', [running('s1'), launch('pty-2')])]
    })
    expect(firedHints(prev, next)).toEqual([{ id: 'worktree', selector: rowSelector('pty-2') }])
  })

  // no pending row ever exists on either of these paths: a resume keeps the session id it
  // has always had, and a launch whose hook binds before the first emit comes up as a
  // running placeholder under the real id. Such a row is named by its SESSION, so the
  // anchor is resolved to the tab that runs it — the sidebar's own `tabIdFor` rule.
  it('fires when a cold row of that workspace starts running again, named by its tab', () => {
    const sessions = [{ tabId: 't2', sessionId: 's2', alive: true }]
    const prev = snap({ sessions, rows: [ws('/a', [running('s1'), cold('s2')])] })
    const next = snap({ sessions, rows: [ws('/a', [running('s1'), running('s2')])] })
    expect(firedHints(prev, next)).toEqual([{ id: 'worktree', selector: rowSelector('t2') }])
  })

  it('stays quiet when the new session is a worktree one — that is the cure', () => {
    const prev = snap({ rows: [ws('/a', [running('s1')])] })
    const next = snap({
      rows: [
        ws('/a', [
          running('s1'),
          { id: 'pty-2', worktree: 'fix-login', pending: true, running: false }
        ])
      ]
    })
    expect(firedHints(prev, next)).toEqual([])
  })

  it('stays quiet when nothing else in that workspace is running', () => {
    const prev = snap({ rows: [ws('/a', [cold('s1')])] })
    const next = snap({
      rows: [ws('/a', [cold('s1'), launch('pty-2')])]
    })
    expect(firedHints(prev, next)).toEqual([])
  })

  it('stays quiet when the busy workspace is a different one', () => {
    const prev = snap({ rows: [ws('/a', [running('s1')]), ws('/b', [])] })
    const next = snap({
      rows: [ws('/a', [running('s1')]), ws('/b', [launch('pty-2')])]
    })
    expect(firedHints(prev, next)).toEqual([])
  })

  it('does not fire for a workspace that only just appeared', () => {
    const prev = snap({ rows: [] })
    const next = snap({
      rows: [ws('/a', [running('s1'), launch('pty-2')])]
    })
    expect(firedHints(prev, next)).toEqual([])
  })
})

// the GitHub button appearing in the panel the user is looking at. The store field
// is set only while the panel is SHOWING, so "it appeared" and "you can see it" are the
// same fact and this rule needs no second condition.
describe('firedHints — github', () => {
  it('fires when the button appears', () => {
    expect(firedHints(empty, snap({ githubBtn: true }))).toEqual([
      { id: 'github', selector: '.wb-gh' }
    ])
  })

  it('stays quiet while it is simply still there', () => {
    const on = snap({ githubBtn: true })
    expect(firedHints(on, on)).toEqual([])
  })

  it('stays quiet when it goes away', () => {
    expect(firedHints(snap({ githubBtn: true }), empty)).toEqual([])
  })

  // Collapsing the panel and opening it again is the common way this flips back on. The
  // card is one-shot, so a second fire costs nothing — but it must be a real transition,
  // not "it was already there".
  it('fires again after the panel was collapsed and re-opened', () => {
    const on = snap({ githubBtn: true })
    expect(firedHints(on, empty)).toEqual([])
    expect(firedHints(empty, on)).toEqual([{ id: 'github', selector: '.wb-gh' }])
  })
})
