import { describe, it, expect } from 'vitest'
import {
  firedHints,
  rowSelector,
  selectorOf,
  wbTabSelector,
  type HintSnapshot
} from '../../src/renderer/src/hints'
import { HINT_IDS, hintOn, tipNumber } from '../../src/core/hints'

describe('tip n of N', () => {
  const allOn = (): boolean => true
  const githubOff = (plugin: string): boolean => plugin !== 'github'

  it('counts every tip while every plugin is on', () => {
    expect(tipNumber(['workbench', 'github'], allOn)).toEqual({ n: 3, of: HINT_IDS.length })
  })

  it('a turned-off plugin tip is off, so one already queued is dropped, not waited for; a core tip is always on', () => {
    expect(hintOn('github', githubOff)).toBe(false)
    expect(hintOn('github', allOn)).toBe(true)
    expect(hintOn('workbench', githubOff)).toBe(true)
  })

  it('a seen tip that no longer exists does not push n past N', () => {
    expect(tipNumber([...HINT_IDS, 'a-tip-since-removed'].slice(1), allOn)).toEqual({
      n: HINT_IDS.length,
      of: HINT_IDS.length
    })
  })

  it('leaves a turned-off plugin tip out of both n and N, even one seen before', () => {
    expect(tipNumber(['workbench', 'github'], githubOff)).toEqual({
      n: 2,
      of: HINT_IDS.length - 1
    })
  })
})

const empty: HintSnapshot = {
  activeTabId: null,
  partsShown: {},
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

describe('selectorOf — a card whose target is hidden points at the button that shows it', () => {
  it('a sidebar row card points at the sidebar button while the sidebar is hidden, and at the row once shown', () => {
    for (const id of ['approval', 'worktree'] as const) {
      const fire = { id, selector: rowSelector('t2') }
      expect(selectorOf(fire, true, true)).toBe('.aux-ico.sb-toggle')
      expect(selectorOf(fire, true, false)).toBe(rowSelector('t2'))
    }
  })

  it('a Workbench card ignores the sidebar', () => {
    const fire = { id: 'agent-web' as const, selector: wbTabSelector('wb-9') }
    expect(selectorOf(fire, false, true)).toBe('.aux-ico.wb-toggle')
    expect(selectorOf(fire, true, true)).toBe(wbTabSelector('wb-9'))
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

  it('stays quiet when a lone launch row gives way to the session it started, as an Antigravity or remote tab’s does', () => {
    const starting = { id: 'pty-1', worktree: 'main', running: true, pending: true }
    const prev = snap({ rows: [ws('/a', [starting])] })
    const next = snap({ rows: [ws('/a', [running('agy:devbox:s1')])] })
    expect(firedHints(prev, next)).toEqual([])
  })

  it('stays quiet when a lone tab swaps its session, as /clear or a resume does', () => {
    const prev = snap({ rows: [ws('/a', [running('s1')])] })
    const next = snap({ rows: [ws('/a', [running('s2'), cold('s1')])] })
    expect(firedHints(prev, next)).toEqual([])
  })

  it('fires at the second launch when it lands in the same update in which the first launch row gives way to its session', () => {
    const starting = { id: 'pty-1', worktree: 'main', running: true, pending: true }
    const prev = snap({ rows: [ws('/a', [starting])] })
    const next = snap({
      rows: [ws('/a', [running('agy:devbox:s1'), { ...starting, id: 'pty-2' }])]
    })
    expect(firedHints(prev, next)).toEqual([{ id: 'worktree', selector: rowSelector('pty-2') }])
  })

  it('stays quiet when the other running session is in a worktree folder of its own', () => {
    const elsewhere = { id: 'w1', worktree: 'fix-login', running: true }
    const prev = snap({ rows: [ws('/a', [elsewhere])] })
    const next = snap({ rows: [ws('/a', [elsewhere, launch('pty-2')])] })
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

describe('firedHints — a part a plugin shows', () => {
  const parts = [{ id: 'github', part: 'github-button', selector: '.wb-gh' }]
  const on = snap({ partsShown: { 'github-button': true } })

  it('fires when the part appears', () => {
    expect(firedHints(empty, on, parts)).toEqual([{ id: 'github', selector: '.wb-gh' }])
  })

  it('stays quiet while it is simply still there', () => {
    expect(firedHints(on, on, parts)).toEqual([])
  })

  it('stays quiet when it goes away', () => {
    expect(firedHints(on, empty, parts)).toEqual([])
  })

  it('fires again after the panel was collapsed and re-opened', () => {
    expect(firedHints(on, empty, parts)).toEqual([])
    expect(firedHints(empty, on, parts)).toEqual([{ id: 'github', selector: '.wb-gh' }])
  })
})
