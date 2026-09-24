import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SessionInfo } from '@shared/types'
import { useStore, consumeRestartExit } from '../../src/renderer/src/store'
import {
  allEditTabs,
  allDirtyTabs,
  beginEdit,
  endEdit,
  getEntry,
  isTabDirty,
  setText
} from '../../src/renderer/src/editRegistry'

interface ResumeReq {
  sessionId: string
  cwd: string
}

let created: ResumeReq[]
let killed: string[]
let order: string[]
let nextPty: { id: string; cwd: string }
let createFails: boolean
let createRefuses: boolean
let mainTrackerSessions: SessionInfo[]
let transcriptOnDisk: boolean
let probeFails: boolean
let probed: string[]

interface Gate {
  promise: Promise<void>
  open: () => void
}
function gate(): Gate {
  let open = (): void => {}
  const promise = new Promise<void>((r) => {
    open = () => r()
  })
  return { promise, open }
}
let probeGate: Gate | null
let createGate: Gate | null

function session(tabId: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    tabId,
    backendId: 'claude',
    host: 'local',
    sessionId: 'sid-' + tabId,
    title: 'Live title',
    cwd: '/w',
    treeRoot: over.cwd ?? '/w',
    jsonlPath: '/j',
    files: [],
    alive: true,
    updatedAt: 0,
    ...over
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  created = []
  killed = []
  order = []
  nextPty = { id: 'pty-new', cwd: '/w' }
  createFails = false
  createRefuses = false
  mainTrackerSessions = []
  transcriptOnDisk = true
  probeFails = false
  probed = []
  probeGate = null
  createGate = null
  ;(globalThis as { window?: unknown }).window = {
    api: {
      sessions: {
        list: () => Promise.resolve(mainTrackerSessions),
        transcriptExists: (id: string) => {
          probed.push(id)
          order.push('probe')
          const answer = probeFails
            ? Promise.reject(new Error('main is not answering'))
            : Promise.resolve(transcriptOnDisk)
          return probeGate ? probeGate.promise.then(() => answer) : answer
        },
        resume: (req: ResumeReq) => {
          created.push(req)
          order.push('create')
          if (createRefuses) return Promise.resolve({ ok: false, code: 'invalid-args' })
          if (createFails) return Promise.reject(new Error('spawn failed'))
          const done = Promise.resolve({ ok: true, ...nextPty })
          return createGate ? createGate.promise.then(() => done) : done
        }
      },
      workbench: { get: async () => ({ open: false, tabs: [] }), setState: () => {} },
      terminal: {
        kill: (id: string) => {
          killed.push(id)
          order.push('kill')
        }
      }
    }
  }
  useStore.setState({
    tabs: [],
    sessions: [],
    activeTabId: null,
    openFiles: {},
    workbench: {},
    workbenchOpen: {},
    workbenchFetched: {},
    toast: null
  })
  for (const t of allEditTabs()) endEdit(t.ownerTabId, t.tabId)
})

const CONFIRMED_COPY_NO_CONVERSATION_LIVE =
  'Nothing to restart yet — this session has no conversation.'
const CONFIRMED_COPY_NO_CONVERSATION_DEAD =
  'Nothing to resume — this session never had a conversation.'

describe('restartActiveSession: the restart itself', () => {
  it('probes disk, then kills the tab pty, then respawns it resuming the SAME session, even from a plain shell tab', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'ord1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('ord1', { sessionId: 'sid-A', cwd: '/w/repo' })])
    nextPty = { id: 'ord2', cwd: '/w/repo' }

    s.restartActiveSession()
    await settle()

    expect(order).toEqual(['probe', 'kill', 'create'])
    expect(killed).toEqual(['ord1'])
    expect(created).toEqual([{ sessionId: 'sid-A', cwd: '/w/repo' }])
  })

  it('restarts Codex in place with the same native backend and session', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'codex-restart',
      kind: 'codex',
      host: 'local',
      title: 'Codex',
      cwd: '/w',
      alive: true
    })
    s.setSessions([
      session('codex-restart', { backendId: 'codex', sessionId: 'codex:local:thread-a' })
    ])
    nextPty = { id: 'codex-restarted', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    expect(order).toEqual(['probe', 'kill', 'create'])
    expect(created).toEqual([{ sessionId: 'codex:local:thread-a', cwd: '/w' }])
    expect(useStore.getState().tabs).toMatchObject([
      { id: 'codex-restarted', kind: 'codex', sessionId: 'codex:local:thread-a' }
    ])
    expect(useStore.getState().workbench['codex-restarted']).toBeUndefined()
  })

  it('resumes from the session root, not the launch cwd (a --worktree session)', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'wt1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w/main',
      alive: true
    })
    s.setSessions([session('wt1', { sessionId: 'sid-W', cwd: '/w/worktrees/feature' })])

    s.restartActiveSession()
    await settle()

    expect(created[0].cwd).toBe('/w/worktrees/feature')
  })

  it('resumes at the PINNED root, not a drifted cwd — `--resume` only finds the transcript from the dir it is bucketed under', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'dr1', kind: 'shell', host: 'local', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([
      session('dr1', { sessionId: 'sid-D', cwd: '/w/elsewhere', treeRoot: '/w/repo' })
    ])
    nextPty = { id: 'dr2', cwd: '/w/repo' }

    s.restartActiveSession()
    await settle()

    expect(created[0].cwd).toBe('/w/repo')
  })

  it('replaces the pty in place: same position, same tab count, title kept rather than flashing back to the default', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'pos-a',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.addTab({
      id: 'pos-b',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.addTab({
      id: 'pos-c',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('pos-b', { sessionId: 'sid-B', title: 'Fix the parser' })])
    s.setActive('pos-b')
    nextPty = { id: 'pos-b2', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    const after = useStore.getState()
    expect(after.tabs.map((t) => t.id)).toEqual(['pos-a', 'pos-b2', 'pos-c'])
    expect(after.activeTabId).toBe('pos-b2')
    expect(after.tabs[1].title).toBe('Fix the parser')
    expect(after.tabs[1].alive).toBe(true)
  })

  it('carries the tab viewer pane onto the new pty id, dropping the dead pty state', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'pane1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('pane1', { sessionId: 'sid-A' })])
    s.setOpenFile({ src: '/w/report.md', label: 'report.md' })
    nextPty = { id: 'pane2', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    const after = useStore.getState()
    expect(after.openFiles['pane2']?.src).toBe('/w/report.md')
    expect(after.openFiles['pane1']).toBeUndefined()
  })

  it('carries the panel — strip, open flag and fetched marker — onto the new pty id as the SAME object, so nothing remounts', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'wb1', kind: 'claude', host: 'local', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('wb1', { sessionId: 'sid-W' })])
    await s.ensureWorkbench('wb1')
    s.setWorkbenchOpen('wb1', true)
    const before = useStore.getState().workbench['wb1']
    expect(before).toBeDefined()
    nextPty = { id: 'wb2', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    const after = useStore.getState()
    expect(after.workbench['wb2']).toBe(before)
    expect(after.workbench['wb1']).toBeUndefined()
    expect(after.workbenchOpen['wb2']).toBe(true)
    expect(after.workbenchOpen['wb1']).toBeUndefined()
    expect(after.workbenchFetched['wb2']).toBe(true)
    expect(after.workbenchFetched['wb1']).toBeUndefined()
  })

  it('carries an unsaved edit buffer onto the new pty id, so the pane, the unsaved dot, ⌘W and the quit guard still see it', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'ed1', kind: 'shell', host: 'local', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('ed1', { sessionId: 'sid-E' })])
    beginEdit('ed1', 'wt-file', {
      path: '/w/notes.md',
      text: 'on disk',
      eol: 'lf',
      stamp: { size: 7, mtimeMs: 1 },
      readOnly: null
    })
    setText('ed1', 'wt-file', 'typed but never saved')
    expect(isTabDirty('ed1', 'wt-file')).toBe(true)
    nextPty = { id: 'ed2', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    expect(isTabDirty('ed2', 'wt-file')).toBe(true)
    expect(getEntry('ed2', 'wt-file')?.text).toBe('typed but never saved')
    expect(getEntry('ed1', 'wt-file')).toBeUndefined()
    expect(allDirtyTabs().map((t: { ownerTabId: string }) => t.ownerTabId)).toEqual(['ed2'])
  })

  it('leaves every other tab alone, even one driving the same session', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'sib-A',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.addTab({
      id: 'sib-B',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.setSessions([
      session('sib-A', { sessionId: 'sid-S' }),
      session('sib-B', { sessionId: 'sid-S' })
    ])
    s.setActive('sib-A')
    nextPty = { id: 'sib-A2', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    expect(killed).toEqual(['sib-A'])
    expect(useStore.getState().tabs.map((t) => t.id)).toEqual(['sib-A2', 'sib-B'])
  })

  it('still resumes after claude exited and the tab reverted to a plain shell', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'rev1', kind: 'claude', host: 'local', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('rev1', { sessionId: 'sid-A' })])
    s.setSessions([])
    expect(useStore.getState().tabs[0].sessionId).toBeUndefined()

    s.restartActiveSession()
    await settle()

    expect(created).toEqual([{ sessionId: 'sid-A', cwd: '/w' }])
  })
})

describe("restartActiveSession vs. the claude→shell revert: the kill's own untrack is not the session ending, so no teardown runs", () => {
  it('an untracked-session update mid-restart neither reverts the tab nor strips its state', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'int1', kind: 'claude', host: 'local', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('int1', { sessionId: 'sid-I', title: 'Long conversation' })])
    s.setOpenFile({ src: '/w/notes.md', label: 'notes.md' })
    nextPty = { id: 'int2', cwd: '/w' }
    createGate = gate()

    s.restartActiveSession()
    await settle()
    s.setSessions([])

    const mid = useStore.getState()
    expect(mid.tabs[0].kind).toBe('claude')
    expect(mid.tabs[0].title).toBe('Long conversation')
    expect(mid.openFiles['int1']?.src).toBe('/w/notes.md')

    createGate.open()
    await settle()

    const after = useStore.getState()
    expect(after.tabs[0].id).toBe('int2')
    expect(after.tabs[0].title).toBe('Long conversation')
    expect(after.tabs[0].sessionId).toBe('sid-I')
    expect(after.openFiles['int2']?.src).toBe('/w/notes.md')
  })

  it('an untracked-session update DURING the probe leaves the restarting tab standing', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'pw1', kind: 'claude', host: 'local', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('pw1', { sessionId: 'sid-PW', title: 'Long conversation' })])
    s.setOpenFile({ src: '/w/notes.md', label: 'notes.md' })
    nextPty = { id: 'pw2', cwd: '/w' }
    probeGate = gate()

    s.restartActiveSession()
    s.setSessions([])

    const mid = useStore.getState()
    expect(mid.tabs[0].id).toBe('pw1')
    expect(mid.tabs[0].kind).toBe('claude')
    expect(mid.openFiles['pw1']?.src).toBe('/w/notes.md')

    probeGate.open()
    await settle()

    const after = useStore.getState()
    expect(after.tabs[0].id).toBe('pw2')
    expect(created).toEqual([{ sessionId: 'sid-PW', cwd: '/w' }])
    expect(after.openFiles['pw2']?.src).toBe('/w/notes.md')
  })
})

describe('restartActiveSession: no-op guards', () => {
  it('does nothing on a terminal that never ran claude', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'plain1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })

    s.restartActiveSession()
    await settle()

    expect(killed).toEqual([])
    expect(created).toEqual([])
    expect(useStore.getState().tabs).toHaveLength(1)
  })

  it('does nothing on a claude tab whose session has not bound yet (an empty id included), and works once it does', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'late1',
      kind: 'claude',
      host: 'local',
      title: 'Claude',
      cwd: '/w',
      alive: true
    })

    s.restartActiveSession()
    await settle()
    expect(created).toEqual([])
    expect(killed).toEqual([])

    s.setSessions([session('late1', { sessionId: '' })])
    s.restartActiveSession()
    await settle()
    expect(created).toEqual([])

    s.setSessions([session('late1', { sessionId: 'sid-late' })])
    s.restartActiveSession()
    await settle()
    expect(created).toEqual([{ sessionId: 'sid-late', cwd: '/w' }])
  })

  it('falls back to the tab anchor while the registered session has no id yet', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'anch1',
      kind: 'claude',
      host: 'local',
      title: 'Claude',
      cwd: '/w',
      sessionId: 'sid-ANCH',
      alive: true
    })
    s.setSessions([session('anch1', { sessionId: '' })])

    s.restartActiveSession()
    await settle()

    expect(created).toEqual([{ sessionId: 'sid-ANCH', cwd: '/w' }])
  })

  it('resumes from the tracker while the throttled renderer snapshot is still stale, since ⇧⌘R never retries', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'stale1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('stale1', { sessionId: '' })])
    mainTrackerSessions = [session('stale1', { sessionId: 'sid-MAIN', cwd: '/w/repo' })]
    nextPty = { id: 'stale2', cwd: '/w/repo' }

    s.restartActiveSession()
    await settle()

    expect(order).toEqual(['probe', 'kill', 'create'])
    expect(created).toEqual([{ sessionId: 'sid-MAIN', cwd: '/w/repo' }])
  })

  it('stays a silent no-op when the tracker has no session for the tab either', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'none1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    mainTrackerSessions = [session('other', { sessionId: 'sid-X' })]

    s.restartActiveSession()
    await settle()

    expect(created).toEqual([])
    expect(killed).toEqual([])
  })

  it('does nothing when there is no active tab', () => {
    expect(() => useStore.getState().restartActiveSession()).not.toThrow()
    expect(created).toEqual([])
    expect(killed).toEqual([])
  })
})

describe('restartActiveSession: double trigger', () => {
  it('restarts once when ⇧⌘R is hit twice before the respawn lands', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'dup1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('dup1', { sessionId: 'sid-A' })])
    nextPty = { id: 'dup2', cwd: '/w' }

    s.restartActiveSession()
    s.restartActiveSession()
    await settle()

    expect(created).toHaveLength(1)
    expect(killed).toEqual(['dup1'])
    expect(useStore.getState().tabs).toHaveLength(1)
  })

  it('restarts once when ⇧⌘R is hit twice while the tracker lookup is in flight', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'race1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    mainTrackerSessions = [session('race1', { sessionId: 'sid-R' })]
    nextPty = { id: 'race2', cwd: '/w' }

    s.restartActiveSession()
    s.restartActiveSession()
    await settle()

    expect(created).toHaveLength(1)
    expect(killed).toEqual(['race1'])
  })

  it('swallows a human double-tap landing after the respawn, then allows a fresh restart', async () => {
    vi.useFakeTimers()
    try {
      const s = useStore.getState()
      s.addTab({
        id: 'cd1',
        kind: 'shell',
        host: 'local',
        title: 'Terminal',
        cwd: '/w',
        alive: true
      })
      s.setSessions([session('cd1', { sessionId: 'sid-CD' })])
      nextPty = { id: 'cd2', cwd: '/w' }

      s.restartActiveSession()
      await vi.advanceTimersByTimeAsync(0)
      expect(useStore.getState().tabs[0].id).toBe('cd2')
      expect(created).toHaveLength(1)

      nextPty = { id: 'cd3', cwd: '/w' }
      await vi.advanceTimersByTimeAsync(200)
      useStore.getState().restartActiveSession()
      await vi.advanceTimersByTimeAsync(0)
      expect(created).toHaveLength(1)
      expect(useStore.getState().tabs[0].id).toBe('cd2')

      await vi.advanceTimersByTimeAsync(1000)
      useStore.getState().restartActiveSession()
      await vi.advanceTimersByTimeAsync(0)
      expect(created).toHaveLength(2)
      expect(useStore.getState().tabs[0].id).toBe('cd3')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("restart-killed pty exits: App closes a tab whose pty exits, so the restart's own kill is marked expected", () => {
  it('marks the killed pty exit as expected exactly once, and never a foreign one', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'ex1', kind: 'shell', host: 'local', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('ex1', { sessionId: 'sid-A' })])
    nextPty = { id: 'ex2', cwd: '/w' }

    s.restartActiveSession()
    await settle()
    expect(consumeRestartExit('ex1')).toBe(true)
    expect(consumeRestartExit('ex1')).toBe(false)
    expect(consumeRestartExit('other')).toBe(false)
  })
})

describe('restartActiveSession: the tab closes mid-restart', () => {
  it('reaps the orphan pty and leaves no resume anchor behind for its id', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gone1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('gone1', { sessionId: 'sid-G' })])
    nextPty = { id: 'gone2', cwd: '/w' }
    createGate = gate()

    s.restartActiveSession()
    await settle()
    useStore.getState().removeTab('gone1')
    createGate.open()
    await settle()

    expect(killed).toContain('gone2')
    expect(useStore.getState().tabs).toHaveLength(0)

    const createdBefore = created.length
    useStore.getState().addTab({
      id: 'gone2',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    useStore.getState().restartActiveSession()
    await settle()
    expect(created).toHaveLength(createdBefore)
  })
})

describe('restartActiveSession: respawn failure', () => {
  it('keeps the tab (marked not alive) and lets a later trigger retry', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'fail1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('fail1', { sessionId: 'sid-A' })])
    createFails = true

    s.restartActiveSession()
    await settle()

    const failed = useStore.getState()
    expect(failed.tabs).toHaveLength(1)
    expect(failed.tabs[0].id).toBe('fail1')
    expect(failed.tabs[0].alive).toBe(false)

    createFails = false
    nextPty = { id: 'fail2', cwd: '/w' }
    useStore.getState().restartActiveSession()
    await settle()

    expect(created).toHaveLength(2)
    expect(created[1]).toEqual({ sessionId: 'sid-A', cwd: '/w' })
    expect(useStore.getState().tabs[0].id).toBe('fail2')
  })

  it('an invalid-args refusal from main lands in the same dead-tab state as a spawn failure', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'ref1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('ref1', { sessionId: 'sid-A' })])
    createRefuses = true

    s.restartActiveSession()
    await settle()

    const refused = useStore.getState()
    expect(refused.tabs).toHaveLength(1)
    expect(refused.tabs[0].id).toBe('ref1')
    expect(refused.tabs[0].alive).toBe(false)
  })
})

// CC§2
describe('restartActiveSession: the transcript gate — a session never typed into has nothing to resume, so ⇧⌘R asks main before the kill', () => {
  it('refuses a session with no conversation on disk: nothing killed, nothing spawned, a toast', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gate1',
      kind: 'claude',
      host: 'local',
      title: 'Claude',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('gate1', { sessionId: 'sid-EMPTY' })])
    transcriptOnDisk = false

    s.restartActiveSession()
    await settle()

    expect(probed).toEqual(['sid-EMPTY'])
    expect(killed).toEqual([])
    expect(created).toEqual([])
    const after = useStore.getState()
    expect(after.tabs.map((t) => t.id)).toEqual(['gate1'])
    expect(after.tabs[0].alive).toBe(true)
    expect(after.toast).toBe(CONFIRMED_COPY_NO_CONVERSATION_LIVE)
  })

  it('has not killed anything while the probe is still in flight', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gate2',
      kind: 'claude',
      host: 'local',
      title: 'Claude',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('gate2', { sessionId: 'sid-SLOW' })])
    probeGate = gate()

    s.restartActiveSession()
    await settle()

    expect(order).toEqual(['probe'])
    expect(killed).toEqual([])

    probeGate.open()
    await settle()
    expect(order).toEqual(['probe', 'kill', 'create'])
  })

  it('releases the restart lock on a refusal, so the next press works once there is a conversation', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gate3',
      kind: 'claude',
      host: 'local',
      title: 'Claude',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('gate3', { sessionId: 'sid-LATER' })])
    transcriptOnDisk = false
    nextPty = { id: 'gate3b', cwd: '/w' }

    s.restartActiveSession()
    await settle()
    expect(created).toEqual([])

    transcriptOnDisk = true
    useStore.getState().restartActiveSession()
    await settle()

    expect(created).toEqual([{ sessionId: 'sid-LATER', cwd: '/w' }])
    expect(useStore.getState().tabs[0].id).toBe('gate3b')
  })

  it('swallows a second ⇧⌘R while the probe is still out, and probes only once', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gate4',
      kind: 'claude',
      host: 'local',
      title: 'Claude',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('gate4', { sessionId: 'sid-TWICE' })])
    probeGate = gate()
    nextPty = { id: 'gate4b', cwd: '/w' }

    s.restartActiveSession()
    s.restartActiveSession()
    probeGate.open()
    await settle()

    expect(probed).toEqual(['sid-TWICE'])
    expect(created).toHaveLength(1)
    expect(killed).toEqual(['gate4'])
  })

  it('tells the exited-claude case apart on a tab that is still alive, though the liveness sweep keeps its entry', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gate9',
      kind: 'claude',
      host: 'local',
      title: 'Claude',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('gate9', { sessionId: 'sid-EXITED' })])
    s.setSessions([session('gate9', { sessionId: 'sid-EXITED', alive: false })])
    transcriptOnDisk = false

    s.restartActiveSession()
    await settle()

    expect(probed).toEqual(['sid-EXITED'])
    expect(killed).toEqual([])
    expect(useStore.getState().toast).toBe(CONFIRMED_COPY_NO_CONVERSATION_DEAD)
  })

  it('never kills when the probe itself fails — and stays retryable', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gate6',
      kind: 'claude',
      host: 'local',
      title: 'Claude',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('gate6', { sessionId: 'sid-IPCDOWN' })])
    probeFails = true
    nextPty = { id: 'gate6b', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    expect(killed).toEqual([])
    expect(created).toEqual([])
    expect(useStore.getState().tabs[0].alive).toBe(true)
    expect(useStore.getState().toast).toBe(null)

    probeFails = false
    useStore.getState().restartActiveSession()
    await settle()
    expect(created).toHaveLength(1)
  })

  it('drops the restart when the tab is closed while the probe is out', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gate7',
      kind: 'claude',
      host: 'local',
      title: 'Claude',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('gate7', { sessionId: 'sid-CLOSED' })])
    probeGate = gate()

    s.restartActiveSession()
    useStore.getState().removeTab('gate7')
    probeGate.open()
    await settle()

    expect(created).toEqual([])
    expect(killed).toEqual([])
    expect(useStore.getState().toast).toBe(null)
  })

  it('gates the tracker-fallback entry too', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gate8',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('gate8', { sessionId: '' })])
    mainTrackerSessions = [session('gate8', { sessionId: 'sid-FRESH' })]
    transcriptOnDisk = false

    s.restartActiveSession()
    await settle()

    expect(probed).toEqual(['sid-FRESH'])
    expect(killed).toEqual([])
    expect(created).toEqual([])
    expect(useStore.getState().toast).toBe(CONFIRMED_COPY_NO_CONVERSATION_LIVE)
  })

  it('words the refusal dead when the live claude is a mid-bind session, not the anchored one', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gate10',
      kind: 'claude',
      host: 'local',
      title: 'Claude',
      cwd: '/w',
      alive: true,
      sessionId: 'sid-OLD'
    })
    s.setSessions([session('gate10', { sessionId: '' })])
    transcriptOnDisk = false

    s.restartActiveSession()
    await settle()

    expect(probed).toEqual(['sid-OLD'])
    expect(killed).toEqual([])
    expect(useStore.getState().toast).toBe(CONFIRMED_COPY_NO_CONVERSATION_DEAD)
  })

  it('words the tracker-fallback refusal dead when the tracker entry is no longer alive', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gate11',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    mainTrackerSessions = [session('gate11', { sessionId: 'sid-GONE', alive: false })]
    transcriptOnDisk = false

    s.restartActiveSession()
    await settle()

    expect(probed).toEqual(['sid-GONE'])
    expect(killed).toEqual([])
    expect(useStore.getState().toast).toBe(CONFIRMED_COPY_NO_CONVERSATION_DEAD)
  })
})

describe('restartActiveSession: resume anchor', () => {
  it('keeps sessionId + cwd on the restarted tab so a later ⇧⌘R can resume it again', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'snap1',
      kind: 'shell',
      host: 'local',
      title: 'Terminal',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('snap1', { sessionId: 'sid-A', cwd: '/w/repo' })])
    nextPty = { id: 'snap2', cwd: '/w/repo' }

    s.restartActiveSession()
    await settle()
    useStore.setState({ sessions: [] })

    const after = useStore.getState()
    expect(after.tabs[0]).toMatchObject({
      kind: 'claude',
      cwd: '/w/repo',
      sessionId: 'sid-A'
    })
    expect(after.activeTabId).toBe('snap2')
  })
})
