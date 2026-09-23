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

// ⇧⌘R restarts the ACTIVE tab's claude session: kill the pty, respawn it in the same slot
// running `<configured claude command> --resume <sessionId>`. The renderer owns the whole
// decision (is this tab restartable? which session? which cwd?) and the in-place swap, so
// it is all drivable from the store with the IPC surface stubbed.
//
// The store keeps per-tab bookkeeping (last bound session, in-flight restarts) in module
// state no reset hook can reach, so every test below uses tab ids of its own — a shared
// id would let one test's leftovers decide another's outcome.

interface CreateOpts {
  kind: string
  cwd?: string
  resumeSessionId?: string
}

let created: CreateOpts[]
let killed: string[]
/** interleaved probe/kill/create log — the order is a correctness requirement, not an
 *  accident: the disk probe has to answer BEFORE the irreversible kill */
let order: string[]
let nextPty: { id: string; cwd: string }
let createFails: boolean
let createRefuses: boolean
/** what the MAIN-process tracker holds — the authority the store falls back to when its
 *  own (throttled) session snapshot has not caught up yet */
let trackerSessions: SessionInfo[]
/** what main answers about this session's conversation on disk. Sessions
 *  in this suite are conversed unless a test says otherwise, so the gate opens. */
let transcriptOnDisk: boolean
let probeFails: boolean
/** session ids the gate asked main about */
let probed: string[]

/** A promise a test resolves by hand, to act INSIDE an in-flight round trip. */
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
    sessionId: 'sid-' + tabId,
    title: 'Live title',
    cwd: '/w',
    // mirrors cwd unless a test pins them apart (the drifted-cwd case)
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
  trackerSessions = []
  transcriptOnDisk = true
  probeFails = false
  probed = []
  probeGate = null
  createGate = null
  ;(globalThis as { window?: unknown }).window = {
    api: {
      sessions: {
        list: () => Promise.resolve(trackerSessions),
        transcriptExists: (id: string) => {
          probed.push(id)
          order.push('probe')
          const answer = probeFails
            ? Promise.reject(new Error('main is not answering'))
            : Promise.resolve(transcriptOnDisk)
          return probeGate ? probeGate.promise.then(() => answer) : answer
        }
      },
      // the viewer-pane cases below open a file on a BOUND session, which since the
      // Workbench merge activates the `files` tab and expands the panel — both of which
      // submit the session's panel document (FR-57). Nothing here asserts on it; the
      // channel exists so the restart under test isn't derailed by the write — nor by
      // the read-first gate in front of it (an unfetched session asks main before it
      // writes anything).
      workbench: { get: async () => ({ open: false, tabs: [] }), setState: () => {} },
      terminal: {
        create: (opts: CreateOpts) => {
          created.push(opts)
          order.push('create')
          if (createRefuses) return Promise.resolve({ ok: false, code: 'invalid-args' })
          if (createFails) return Promise.reject(new Error('spawn failed'))
          const done = Promise.resolve({ ok: true, ...nextPty })
          return createGate ? createGate.promise.then(() => done) : done
        },
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
    // the panel is per-session and its entries outlive a cold session (FR-25), so a
    // leftover strip would follow one test's session id into the next
    workbench: {},
    workbenchOpen: {},
    workbenchFetched: {},
    toast: null
  })
  // the edit registry is module state the store reset above cannot reach; a buffer left
  // behind would follow one test's tab id into the next
  for (const t of allEditTabs()) endEdit(t.ownerTabId, t.tabId)
})

/** The refusal copy is user-confirmed contract (spec FR-02 / FR-07), so it is spelled
 *  out here rather than imported — importing the constant would agree with any rewrite. */
const NO_CONVERSATION_LIVE = 'Nothing to restart yet — this session has no conversation.'
const NO_CONVERSATION_DEAD = 'Nothing to resume — this session never had a conversation.'

describe('restartActiveSession: the restart itself', () => {
  it('kills the tab pty first, then respawns it resuming the SAME session', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'ord1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    // the everyday case: a plain shell tab the user ran `claude` in — the tab's kind stays
    // 'shell'; only the bound session says there is anything to restart
    s.setSessions([session('ord1', { sessionId: 'sid-A', cwd: '/w/repo' })])
    nextPty = { id: 'ord2', cwd: '/w/repo' }

    s.restartActiveSession()
    await settle()

    // create-before-kill would leave two claude processes on one session; and the kill is
    // irreversible, so the disk probe has to have answered before it
    expect(order).toEqual(['probe', 'kill', 'create'])
    expect(killed).toEqual(['ord1'])
    // kind 'claude' + resumeSessionId is what routes main through the configured claude
    // command (settings.claudeCommand / KOLOFT_CLAUDE_CMD) with `--resume <id>`
    expect(created).toEqual([{ kind: 'claude', cwd: '/w/repo', resumeSessionId: 'sid-A' }])
  })

  it('restarts Codex in place with the same native backend and session', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'codex-restart', kind: 'codex', title: 'Codex', cwd: '/w', alive: true })
    s.setSessions([
      session('codex-restart', { backendId: 'codex', sessionId: 'codex:local:thread-a' })
    ])
    nextPty = { id: 'codex-restarted', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    expect(order).toEqual(['probe', 'kill', 'create'])
    expect(created).toEqual([{ kind: 'codex', cwd: '/w', resumeSessionId: 'codex:local:thread-a' }])
    expect(useStore.getState().tabs).toMatchObject([
      { id: 'codex-restarted', kind: 'codex', sessionId: 'codex:local:thread-a' }
    ])
    expect(useStore.getState().workbench['codex-restarted']).toBeUndefined()
  })

  it('resumes from the session root, not the launch cwd (a --worktree session)', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'wt1', kind: 'shell', title: 'Terminal', cwd: '/w/main', alive: true })
    s.setSessions([session('wt1', { sessionId: 'sid-W', cwd: '/w/worktrees/feature' })])

    s.restartActiveSession()
    await settle()

    expect(created[0].cwd).toBe('/w/worktrees/feature')
  })

  it('resumes at the PINNED root, not a drifted cwd — `--resume` only finds the transcript from the dir it is bucketed under', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'dr1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    // the TUI cd'ed away mid-session; the pin still names where the session lives
    s.setSessions([
      session('dr1', { sessionId: 'sid-D', cwd: '/w/elsewhere', treeRoot: '/w/repo' })
    ])
    nextPty = { id: 'dr2', cwd: '/w/repo' }

    s.restartActiveSession()
    await settle()

    expect(created[0].cwd).toBe('/w/repo')
  })

  it('replaces the pty in place: same position, same tab count, title kept', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'pos-a', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.addTab({ id: 'pos-b', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.addTab({ id: 'pos-c', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('pos-b', { sessionId: 'sid-B', title: 'Fix the parser' })])
    s.setActive('pos-b')
    nextPty = { id: 'pos-b2', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    const after = useStore.getState()
    // the middle slot, not appended to the end
    expect(after.tabs.map((t) => t.id)).toEqual(['pos-a', 'pos-b2', 'pos-c'])
    expect(after.activeTabId).toBe('pos-b2')
    // the claude title is derived from the live session, which the kill untracks — the
    // restarted tab must not flash back to the default terminal title
    expect(after.tabs[1].title).toBe('Fix the parser')
    expect(after.tabs[1].alive).toBe(true)
  })

  it('carries the tab viewer pane onto the new pty id, dropping the dead pty state', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'pane1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('pane1', { sessionId: 'sid-A' })])
    s.setOpenFile({ src: '/w/report.md', label: 'report.md' })
    nextPty = { id: 'pane2', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    const after = useStore.getState()
    expect(after.openFiles['pane2']?.src).toBe('/w/report.md')
    expect(after.openFiles['pane1']).toBeUndefined()
  })

  /**
   * D8/R1 — ⇧⌘R is the ONE event that changes a conversation tab's id, so it is the one
   * event the tab-keyed panel has to be carried across. The move rides the same store step
   * that already moves `openFiles` (the case above); anything left behind under the old id
   * is a panel the user watched disappear, and a shell whose xterm unmounts with it.
   *
   * Driven through the real `restartActiveSession` rather than by replaying the move by
   * hand: the assertions only mean something if the code under test produced them, and the
   * pre-restart set is compared BY IDENTITY, which is what says the panel was carried
   * rather than rebuilt from disk.
   */
  it('carries the panel — strip, open flag and fetched marker — onto the new pty id', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'wb1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('wb1', { sessionId: 'sid-W' })])
    // a panel the user has been working in: read from main once, then expanded
    await s.ensureWorkbench('wb1')
    s.setWorkbenchOpen('wb1', true)
    const before = useStore.getState().workbench['wb1']
    expect(before).toBeDefined()
    nextPty = { id: 'wb2', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    const after = useStore.getState()
    // the SAME object, not an equal one: a rebuild would remount every guest and every
    // shell body in it, which is exactly what R1 says a restart must not do
    expect(after.workbench['wb2']).toBe(before)
    expect(after.workbench['wb1']).toBeUndefined()
    expect(after.workbenchOpen['wb2']).toBe(true)
    expect(after.workbenchOpen['wb1']).toBeUndefined()
    // …and the marker travels too, or the new id would re-read disk and drop the strip
    expect(after.workbenchFetched['wb2']).toBe(true)
    expect(after.workbenchFetched['wb1']).toBeUndefined()
  })

  /**
   * The same move, for the one table that is NOT store state: the edit buffers, keyed by
   * conversation tab in `editRegistry` since the panel became tab-keyed (P1).
   *
   * `isTabDirty(newId, …)` is the assertion carrying the case, because every consumer
   * reads through that one answer: the editor pane, the strip's unsaved dot, the ⌘W guard
   * and the quit guard. Left behind under the old id, the text is not lost so much as
   * unreachable — the pane silently reverts to the bytes on disk and ⌘W stops asking.
   */
  it('carries an unsaved edit buffer onto the new pty id', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'ed1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
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
    // …and nothing is left under an id no tab carries any more
    expect(getEntry('ed1', 'wt-file')).toBeUndefined()
    expect(allDirtyTabs().map((t: { ownerTabId: string }) => t.ownerTabId)).toEqual(['ed2'])
  })

  it('leaves every other tab alone', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'sib-A', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.addTab({ id: 'sib-B', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    // two tabs driving the SAME session (the second via `claude --resume`) — restarting
    // one must never reach into the other's pty
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
    s.addTab({ id: 'rev1', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('rev1', { sessionId: 'sid-A' })]) // bound
    s.setSessions([]) // claude exited in-TUI; the shell pty lives on, the tab reverts
    expect(useStore.getState().tabs[0].sessionId).toBeUndefined() // the revert cleared it

    s.restartActiveSession()
    await settle()

    // the whole point of the feature is restarting a claude that is no longer running
    expect(created).toEqual([{ kind: 'claude', cwd: '/w', resumeSessionId: 'sid-A' }])
  })
})

// Killing the pty untracks its session main-side, so a sessions update WITHOUT this tab
// lands in the middle of the restart. That is not this tab's session ending — its
// replacement claude is already being spawned — so none of the end-of-session teardown
// (revert to shell, drop the title and sessionId, wipe the active tab's viewer pane) may
// run, and the swap must not inherit any of it.
describe('restartActiveSession vs. the claude→shell revert', () => {
  it('an untracked-session update mid-restart neither reverts the tab nor strips its state', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'int1', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('int1', { sessionId: 'sid-I', title: 'Long conversation' })])
    s.setOpenFile({ src: '/w/notes.md', label: 'notes.md' })
    nextPty = { id: 'int2', cwd: '/w' }
    createGate = gate() // hold the respawn open, which is where the untrack lands

    s.restartActiveSession()
    await settle() // the disk probe answered and the pty was killed — the untrack's cause
    s.setSessions([]) // the kill's untrack, delivered before the respawn resolves

    const mid = useStore.getState()
    expect(mid.tabs[0].kind).toBe('claude')
    expect(mid.tabs[0].title).toBe('Long conversation')
    expect(mid.openFiles['int1']?.src).toBe('/w/notes.md')

    createGate.open()
    await settle()

    const after = useStore.getState()
    expect(after.tabs[0].id).toBe('int2')
    expect(after.tabs[0].title).toBe('Long conversation') // not the reverted "Terminal"
    expect(after.tabs[0].sessionId).toBe('sid-I')
    expect(after.openFiles['int2']?.src).toBe('/w/notes.md')
  })

  // The disk probe opened a second window the same update can land in —
  // before the kill, when the restart has committed to nothing yet. A claude that exits
  // in-TUI right then must still not tear the tab down under a restart that is on its
  // way. Only a held probe can put the app in that state, so it is pinned here.
  it('an untracked-session update DURING the probe leaves the restarting tab standing', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'pw1', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('pw1', { sessionId: 'sid-PW', title: 'Long conversation' })])
    s.setOpenFile({ src: '/w/notes.md', label: 'notes.md' })
    nextPty = { id: 'pw2', cwd: '/w' }
    probeGate = gate()

    s.restartActiveSession()
    s.setSessions([]) // the session ended on its own, mid-probe

    const mid = useStore.getState()
    expect(mid.tabs[0].id).toBe('pw1')
    expect(mid.tabs[0].kind).toBe('claude')
    expect(mid.openFiles['pw1']?.src).toBe('/w/notes.md')

    probeGate.open()
    await settle()

    const after = useStore.getState()
    expect(after.tabs[0].id).toBe('pw2')
    expect(created).toEqual([{ kind: 'claude', cwd: '/w', resumeSessionId: 'sid-PW' }])
    expect(after.openFiles['pw2']?.src).toBe('/w/notes.md')
  })
})

// "Conditions not met: silent no-op" — nothing created, nothing killed, nothing thrown.
describe('restartActiveSession: no-op guards', () => {
  it('does nothing on a terminal that never ran claude', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'plain1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })

    s.restartActiveSession()
    await settle() // the tab has no local session, so the verdict comes from the tracker

    expect(killed).toEqual([])
    expect(created).toEqual([])
    expect(useStore.getState().tabs).toHaveLength(1)
  })

  it('does nothing on a claude tab whose session has not bound yet, and works once it does', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'late1', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })

    s.restartActiveSession()
    await settle()
    expect(created).toEqual([]) // no `--resume undefined`
    expect(killed).toEqual([])

    // the tracker registers a session before the hook reports its id: an empty sessionId
    // still means "not bound", and must never be resumed as one
    s.setSessions([session('late1', { sessionId: '' })])
    s.restartActiveSession()
    await settle()
    expect(created).toEqual([])

    s.setSessions([session('late1', { sessionId: 'sid-late' })]) // the hook reports
    s.restartActiveSession()
    await settle()
    expect(created).toEqual([{ kind: 'claude', cwd: '/w', resumeSessionId: 'sid-late' }])
  })

  it('falls back to the tab anchor while the registered session has no id yet', async () => {
    // A session is tracked with sessionId '' from registration until the hook reports it —
    // the state every restarted tab (and every in-TUI /resume) passes through. The tab's
    // own anchor is what ⇧⌘R must resume in that window, instead of going silently dead.
    const s = useStore.getState()
    s.addTab({
      id: 'anch1',
      kind: 'claude',
      title: 'Claude',
      cwd: '/w',
      sessionId: 'sid-ANCH',
      alive: true
    })
    s.setSessions([session('anch1', { sessionId: '' })])

    s.restartActiveSession()
    await settle()

    expect(created).toEqual([{ kind: 'claude', cwd: '/w', resumeSessionId: 'sid-ANCH' }])
  })

  // The store's session snapshot is throttled (sessionTracker EMIT_THROTTLE_MS): for up to
  // half a second after a session binds, main holds its id while this copy still carries
  // the registration's empty one. ⇧⌘R is one-shot and never retries, so a no-op there is
  // indistinguishable from a dead shortcut — the tracker decides instead.
  it('resumes from the tracker while the renderer snapshot is still stale', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'stale1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('stale1', { sessionId: '' })])
    trackerSessions = [session('stale1', { sessionId: 'sid-MAIN', cwd: '/w/repo' })]
    nextPty = { id: 'stale2', cwd: '/w/repo' }

    s.restartActiveSession()
    await settle()

    expect(order).toEqual(['probe', 'kill', 'create'])
    // the tracker's cwd too — it is the session's real dir (a worktree checkout), which is
    // the only place `claude --resume` finds the conversation
    expect(created).toEqual([{ kind: 'claude', cwd: '/w/repo', resumeSessionId: 'sid-MAIN' }])
  })

  it('stays a silent no-op when the tracker has no session for the tab either', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'none1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    trackerSessions = [session('other', { sessionId: 'sid-X' })] // someone else's session

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
    s.addTab({ id: 'dup1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('dup1', { sessionId: 'sid-A' })])
    nextPty = { id: 'dup2', cwd: '/w' }

    s.restartActiveSession()
    s.restartActiveSession() // same tick — the first respawn is still in flight
    await settle()

    expect(created).toHaveLength(1)
    expect(killed).toEqual(['dup1'])
    expect(useStore.getState().tabs).toHaveLength(1)
  })

  it('restarts once when ⇧⌘R is hit twice while the tracker lookup is in flight', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'race1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    trackerSessions = [session('race1', { sessionId: 'sid-R' })]
    nextPty = { id: 'race2', cwd: '/w' }

    s.restartActiveSession()
    s.restartActiveSession() // same tick — the first lookup has not answered yet
    await settle()

    expect(created).toHaveLength(1)
    expect(killed).toEqual(['race1'])
  })

  it('swallows a human double-tap landing after the respawn, then allows a fresh restart', async () => {
    vi.useFakeTimers()
    try {
      const s = useStore.getState()
      s.addTab({ id: 'cd1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
      s.setSessions([session('cd1', { sessionId: 'sid-CD' })])
      nextPty = { id: 'cd2', cwd: '/w' }

      s.restartActiveSession()
      await vi.advanceTimersByTimeAsync(0) // the respawn lands; the in-flight window ends
      expect(useStore.getState().tabs[0].id).toBe('cd2')
      expect(created).toHaveLength(1)

      // the second press of a real double-tap: the tab already carries the new pty id, so
      // only a cooldown can tell this apart from a deliberate second restart
      nextPty = { id: 'cd3', cwd: '/w' }
      await vi.advanceTimersByTimeAsync(200)
      useStore.getState().restartActiveSession()
      await vi.advanceTimersByTimeAsync(0)
      expect(created).toHaveLength(1)
      expect(useStore.getState().tabs[0].id).toBe('cd2')

      await vi.advanceTimersByTimeAsync(1000) // cooldown elapsed
      useStore.getState().restartActiveSession()
      await vi.advanceTimersByTimeAsync(0)
      expect(created).toHaveLength(2)
      expect(useStore.getState().tabs[0].id).toBe('cd3')
    } finally {
      vi.useRealTimers()
    }
  })
})

// The old pty's exit is the single most dangerous side effect: App closes a tab whose pty
// exits, which would delete the very tab being restarted.
describe('restart-killed pty exits', () => {
  it('marks the killed pty exit as expected exactly once, and never a foreign one', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'ex1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('ex1', { sessionId: 'sid-A' })])
    nextPty = { id: 'ex2', cwd: '/w' }

    s.restartActiveSession()
    // the pty is killed only after the disk probe answers, so the expectation is armed
    // in that same step — nothing can exit before it
    await settle()
    expect(consumeRestartExit('ex1')).toBe(true) // → App skips closeTab, the tab survives
    expect(consumeRestartExit('ex1')).toBe(false) // a later exit for that id is genuine
    expect(consumeRestartExit('other')).toBe(false) // an unrelated pty still closes its tab
  })
})

describe('restartActiveSession: the tab closes mid-restart', () => {
  it('reaps the orphan pty and leaves no resume anchor behind for its id', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'gone1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('gone1', { sessionId: 'sid-G' })])
    nextPty = { id: 'gone2', cwd: '/w' }
    createGate = gate() // hold the respawn open so the close lands squarely inside it

    s.restartActiveSession()
    await settle() // the probe answered and the old pty is already dead
    useStore.getState().removeTab('gone1') // the user closed the tab while the respawn ran
    createGate.open()
    await settle()

    expect(killed).toContain('gone2') // the pty nothing will ever show must not leak
    expect(useStore.getState().tabs).toHaveLength(0)

    // …and neither may its bookkeeping: a plain terminal later carrying that id has no
    // session to resume, so ⇧⌘R on it stays a no-op
    const createdBefore = created.length
    useStore
      .getState()
      .addTab({ id: 'gone2', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    useStore.getState().restartActiveSession()
    await settle()
    expect(created).toHaveLength(createdBefore)
  })
})

describe('restartActiveSession: respawn failure', () => {
  it('keeps the tab (marked not alive) and lets a later trigger retry', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'fail1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('fail1', { sessionId: 'sid-A' })])
    createFails = true

    s.restartActiveSession()
    await settle()

    const failed = useStore.getState()
    expect(failed.tabs).toHaveLength(1) // not swallowed by the failed respawn
    expect(failed.tabs[0].id).toBe('fail1')
    expect(failed.tabs[0].alive).toBe(false)

    createFails = false // the user fixed the claude command
    nextPty = { id: 'fail2', cwd: '/w' }
    useStore.getState().restartActiveSession()
    await settle()

    expect(created).toHaveLength(2)
    expect(created[1]).toEqual({ kind: 'claude', cwd: '/w', resumeSessionId: 'sid-A' })
    expect(useStore.getState().tabs[0].id).toBe('fail2')
  })

  // D11: main can now REFUSE the launch line ({ok:false}) instead of rejecting — the
  // renderer must treat the refusal exactly like a spawn failure: dead tab, no leak
  it('a D11 invalid-args refusal lands in the same dead-tab state as a spawn failure', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'ref1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
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

// Claude Code writes a session's transcript at the FIRST user message, so a
// session that bound and was never typed into has no conversation on disk. ⇧⌘R used to
// kill that perfectly healthy claude and then hand `--resume` an id with nothing behind
// it: the session was destroyed and the user got an error tab. The restart now asks main
// for the disk truth before the kill, and a "no" is a full no-op with a toast.
describe('restartActiveSession: the transcript gate', () => {
  it('refuses a session with no conversation on disk: nothing killed, nothing spawned, a toast', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'gate1', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('gate1', { sessionId: 'sid-EMPTY' })])
    transcriptOnDisk = false

    s.restartActiveSession()
    await settle()

    expect(probed).toEqual(['sid-EMPTY']) // asked about the id it was about to resume
    expect(killed).toEqual([])
    expect(created).toEqual([])
    const after = useStore.getState()
    expect(after.tabs.map((t) => t.id)).toEqual(['gate1']) // same tab, untouched
    expect(after.tabs[0].alive).toBe(true)
    expect(after.toast).toBe(NO_CONVERSATION_LIVE)
  })

  // The gate must sit before the kill, not after it: a refusal that arrives once the pty
  // is already dead is the bug, not the fix.
  it('has not killed anything while the probe is still in flight', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'gate2', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('gate2', { sessionId: 'sid-SLOW' })])
    probeGate = gate()

    s.restartActiveSession()
    await settle()

    expect(order).toEqual(['probe']) // asked, and waiting for the answer
    expect(killed).toEqual([])

    probeGate.open()
    await settle()
    expect(order).toEqual(['probe', 'kill', 'create'])
  })

  // A refusal is not a dead shortcut: the session becomes restartable the moment the user
  // says something, and the very next ⇧⌘R has to go through.
  it('releases the restart lock on a refusal, so the next press works once there is a conversation', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'gate3', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('gate3', { sessionId: 'sid-LATER' })])
    transcriptOnDisk = false
    nextPty = { id: 'gate3b', cwd: '/w' }

    s.restartActiveSession()
    await settle()
    expect(created).toEqual([])

    transcriptOnDisk = true // the user typed their first prompt
    useStore.getState().restartActiveSession()
    await settle()

    expect(created).toEqual([{ kind: 'claude', cwd: '/w', resumeSessionId: 'sid-LATER' }])
    expect(useStore.getState().tabs[0].id).toBe('gate3b')
  })

  it('swallows a second ⇧⌘R while the probe is still out, and probes only once', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'gate4', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('gate4', { sessionId: 'sid-TWICE' })])
    probeGate = gate()
    nextPty = { id: 'gate4b', cwd: '/w' }

    s.restartActiveSession()
    s.restartActiveSession() // the answer has not come back yet
    probeGate.open()
    await settle()

    expect(probed).toEqual(['sid-TWICE'])
    expect(created).toHaveLength(1)
    expect(killed).toEqual(['gate4'])
  })

  // The other shape of "the claude is gone": it died while the tab's shell pty lived on,
  // so nothing froze. Main's liveness sweep only clears `alive` — the entry, with its
  // session id, stays in the list — so a check that stops at "is there a session for this
  // tab" would promise a "yet" for a claude that no longer exists.
  it('tells the exited-claude case apart on a tab that is still alive', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'gate9', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('gate9', { sessionId: 'sid-EXITED' })])
    s.setSessions([session('gate9', { sessionId: 'sid-EXITED', alive: false })])
    transcriptOnDisk = false

    s.restartActiveSession()
    await settle()

    expect(probed).toEqual(['sid-EXITED'])
    expect(killed).toEqual([])
    expect(useStore.getState().toast).toBe(NO_CONVERSATION_DEAD)
  })

  // NFR-01: no answer is not a yes. Killing on a failed probe would reintroduce the exact
  // damage the gate exists to prevent, this time with no toast to explain it.
  it('never kills when the probe itself fails — and stays retryable', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'gate6', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('gate6', { sessionId: 'sid-IPCDOWN' })])
    probeFails = true
    nextPty = { id: 'gate6b', cwd: '/w' }

    s.restartActiveSession()
    await settle()

    expect(killed).toEqual([])
    expect(created).toEqual([])
    expect(useStore.getState().tabs[0].alive).toBe(true)
    expect(useStore.getState().toast).toBe(null) // a silent no-op, like the other IPC failures

    probeFails = false
    useStore.getState().restartActiveSession()
    await settle()
    expect(created).toHaveLength(1)
  })

  // ⌘W during the round trip: restarting a tab that no longer exists would spawn a claude
  // nothing will ever show, bind it, and have it reaped — the same double-bind noise the
  // issue reported.
  it('drops the restart when the tab is closed while the probe is out', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'gate7', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([session('gate7', { sessionId: 'sid-CLOSED' })])
    probeGate = gate()

    s.restartActiveSession()
    useStore.getState().removeTab('gate7')
    probeGate.open()
    await settle()

    expect(created).toEqual([])
    expect(killed).toEqual([]) // removeTab kills its own pty; the restart adds nothing
    expect(useStore.getState().toast).toBe(null)
  })

  // The second entry into the restart — the tracker fallback taken while the renderer's
  // throttled snapshot is still stale — must pass the same gate. A door left open here
  // is the whole fix bypassed in the exact window a fresh session lives in.
  it('gates the tracker-fallback entry too', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'gate8', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('gate8', { sessionId: '' })])
    trackerSessions = [session('gate8', { sessionId: 'sid-FRESH' })]
    transcriptOnDisk = false

    s.restartActiveSession()
    await settle()

    expect(probed).toEqual(['sid-FRESH'])
    expect(killed).toEqual([])
    expect(created).toEqual([])
    expect(useStore.getState().toast).toBe(NO_CONVERSATION_LIVE)
  })

  // The third leg of the live/dead call (spec Resolved: the snapshot must hold THIS
  // session): right after a restart the tab's claude is registered but not hook-bound
  // yet — the snapshot entry is alive with sessionId '' — while the probe resumes the
  // tab's anchor. Typing feeds the mid-bind session, never the anchored one, so "yet"
  // would promise a restart this id can never have.
  it('words the refusal dead when the live claude is not the anchored session', async () => {
    const s = useStore.getState()
    s.addTab({
      id: 'gate10',
      kind: 'claude',
      title: 'Claude',
      cwd: '/w',
      alive: true,
      sessionId: 'sid-OLD'
    })
    s.setSessions([session('gate10', { sessionId: '' })]) // mid-bind: registered, unbound
    transcriptOnDisk = false

    s.restartActiveSession()
    await settle()

    expect(probed).toEqual(['sid-OLD']) // the anchor, not the mid-bind registration
    expect(killed).toEqual([])
    expect(useStore.getState().toast).toBe(NO_CONVERSATION_DEAD)
  })

  // The fallback's own dead shape: the local chain is empty and the tracker still holds
  // the entry of a claude its liveness sweep already marked dead. `alive` is false, so
  // no first message can ever reach it — dead wording, not "yet".
  it('words the tracker-fallback refusal dead when the tracker entry is no longer alive', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'gate11', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    trackerSessions = [session('gate11', { sessionId: 'sid-GONE', alive: false })]
    transcriptOnDisk = false

    s.restartActiveSession()
    await settle()

    expect(probed).toEqual(['sid-GONE'])
    expect(killed).toEqual([])
    expect(useStore.getState().toast).toBe(NO_CONVERSATION_DEAD)
  })
})

describe('restartActiveSession: resume anchor', () => {
  it('keeps sessionId + cwd on the restarted tab so a later ⇧⌘R can resume it again', async () => {
    const s = useStore.getState()
    s.addTab({ id: 'snap1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([session('snap1', { sessionId: 'sid-A', cwd: '/w/repo' })])
    nextPty = { id: 'snap2', cwd: '/w/repo' }

    s.restartActiveSession()
    await settle()
    useStore.setState({ sessions: [] }) // the new session has not re-bound yet

    const after = useStore.getState()
    expect(after.tabs[0]).toMatchObject({
      kind: 'claude',
      cwd: '/w/repo',
      sessionId: 'sid-A'
    })
    expect(after.activeTabId).toBe('snap2')
  })
})
