import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { SessionInfo, UpdateCheckResult, WorkspaceRows } from '@shared/types'
import {
  boundSessionId,
  tabForSession,
  useStore,
  openInterceptedFile
} from '../../src/renderer/src/store'
import {
  allEditTabs,
  beginEdit,
  endEdit,
  isTabDirty,
  setText
} from '../../src/renderer/src/editRegistry'
import {
  FILES_TAB_ID,
  activateTab,
  emptyTabSet,
  openTab
} from '../../src/renderer/src/components/workbenchTabs'

// The claude→shell revert (setSessions) is the trickiest bit of renderer state: a tab
// opened as claude must flip back to a plain shell once its session ends — but ONLY
// after a session actually bound (never during the launch window). Zustand runs in
// plain node; we drive the store directly (no window.api touched by these actions).
function session(tabId: string): SessionInfo {
  return {
    tabId,
    sessionId: 'sid-' + tabId,
    title: 'Live title',
    cwd: '/w',
    treeRoot: '/w',
    jsonlPath: '/j',
    files: [],
    alive: true,
    updatedAt: 0
  }
}

beforeEach(() => {
  // reset every field these tests touch explicitly — don't rely on the store's
  // active-tab-change subscriber happening to fire during addTab to clear the rest.
  useStore.setState({
    tabs: [],
    sessions: [],
    activeTabId: null,
    openFiles: {},
    // openUpdateCheck early-returns while a download is mid-flight, so a leaked phase from
    // an earlier test would silently skip the check and make these assert stale state
    update: { open: false, phase: 'checking' }
  })
})

describe('store: claude → shell revert', () => {
  it('reverts a claude tab to a shell once its (previously bound) session ends', () => {
    const s = useStore.getState()
    s.addTab({ id: 'rev1', kind: 'claude', title: 'My session', cwd: '/w', alive: true })
    s.setSessions([session('rev1')]) // binds → records everBound
    s.setSessions([]) // session gone
    const t = useStore.getState().tabs.find((x) => x.id === 'rev1')!
    expect(t.kind).toBe('shell')
    expect(t.title).toBe('Terminal')
    expect(t.sessionId).toBeUndefined()
  })

  it('does NOT revert a claude tab that never bound a session (launch window)', () => {
    const s = useStore.getState()
    s.addTab({ id: 'nev1', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([]) // no session ever seen for nev1
    expect(useStore.getState().tabs.find((x) => x.id === 'nev1')!.kind).toBe('claude')
  })

  // A cold-row resume overlays "Resuming Claude session…" until the session binds
  // (logic.md §4 / T-LIFE-06). The flag must clear on bind, or the overlay would
  // reappear later when the session ends (bound-set goes empty again).
  it('clears the resuming placeholder flag once the session binds', () => {
    const s = useStore.getState()
    s.addTab({ id: 'rs1', kind: 'claude', title: 'T', cwd: '/w', alive: true, resuming: true })
    s.setSessions([session('rs1')])
    expect(useStore.getState().tabs.find((x) => x.id === 'rs1')!.resuming).toBeFalsy()
  })

  it('leaves a plain shell tab untouched', () => {
    const s = useStore.getState()
    s.addTab({ id: 'sh1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([])
    expect(useStore.getState().tabs.find((x) => x.id === 'sh1')!.kind).toBe('shell')
  })

  // A tab switch clears the per-tab view state so nothing bleeds onto the next tab. An
  // in-place revert turns the ACTIVE tab into a session-less shell WITHOUT an activeTabId
  // change, so it has to do that clearing itself. The tree filter this used to assert
  // retired with the sidebar tree (FR-44…FR-50); the open file is the half that
  // survives, and it is the half that mattered — a reverted shell has no session, so the
  // Workbench reading area must not go on showing that session's file.
  it('reverting the active claude tab to a shell clears its open file, like a switch', () => {
    const s = useStore.getState()
    s.addTab({ id: 'P', kind: 'claude', title: 'S', cwd: '/w', alive: true }) // becomes active
    s.setSessions([session('P')]) // binds → everBound
    // seeded directly: `setOpenFile`'s user branch reaches into `window.api` to expand the
    // panel, and this test is about the revert, not about the open path
    useStore.setState({ openFiles: { P: { src: '/w/NOTES.md', label: 'NOTES.md' } } })
    s.setSessions([]) // session ends → revert P to shell in place (activeTabId unchanged)
    expect(useStore.getState().openFiles['P']).toBeUndefined()
  })
})

// An `open <file>` intercepted by the PATH shim must always surface: on the active
// tab it opens the viewer pane directly; from a background tab it first activates
// that tab — and the preview must SURVIVE the per-tab view-state reset the tab
// switch triggers (setting the file before activating would clear it right away).
// The source tag keeps agent-triggered opens out of the user's Recent MRU.
describe('store: intercepted file open routing', () => {
  it('opens the file in the viewer pane (tagged as an intercept) when the owning tab is active', () => {
    const s = useStore.getState()
    s.addTab({ id: 'op1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    openInterceptedFile('op1', '/w/README.md')
    expect(useStore.getState().openFiles['op1']).toMatchObject({
      src: '/w/README.md',
      label: 'README.md',
      source: 'intercept'
    })
  })

  it('activates a background tab first; the preview lands on that tab', () => {
    const s = useStore.getState()
    s.addTab({ id: 'op1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.addTab({ id: 'op2', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true }) // active
    openInterceptedFile('op1', '/w/doc.md')
    expect(useStore.getState().activeTabId).toBe('op1')
    expect(useStore.getState().openFiles['op1']?.src).toBe('/w/doc.md')
  })

  it('still surfaces the preview when the tab closed since the shim fired (no activation)', () => {
    const s = useStore.getState()
    s.addTab({ id: 'op1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    openInterceptedFile('gone', '/w/doc.md')
    // main already consumed the request — dropping it here would lose the open
    // entirely (`open x.md; exit`), so it shows beside whatever tab is active.
    expect(useStore.getState().activeTabId).toBe('op1')
    expect(useStore.getState().openFiles['op1']?.src).toBe('/w/doc.md')
  })

  it('falls back to OS open when there is no tab to attach the preview to (never swallowed)', () => {
    // the last tab exited racing the open → zero tabs, activeTabId null. The per-tab pane
    // has nowhere to attach, so it must fall back to the OS rather than silently drop.
    const calls: string[] = []
    ;(globalThis as { window?: unknown }).window = {
      api: { preview: { osOpen: (p: string) => calls.push(p) } }
    }
    openInterceptedFile('gone', '/w/orphan.md')
    expect(calls).toEqual(['/w/orphan.md'])
    expect(useStore.getState().openFiles).toEqual({})
  })
})

// R1: the viewer preview is per-tab and must SURVIVE switching to another tab and back —
// the previous single global slot was wiped on every tab switch. openFiles is keyed by tabId
// so each tab keeps its own file (and its pane stays mounted in App, preserving scroll).
describe('store: per-tab preview persistence', () => {
  const f = (src: string) => ({ src, label: src.split('/').pop()! })

  it('a file opened on one tab is retained when the active tab switches away and back', () => {
    const s = useStore.getState()
    s.addTab({ id: 'A', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true }) // active
    s.setOpenFile(f('/w/a.ts'))
    expect(useStore.getState().openFiles['A']?.src).toBe('/w/a.ts')
    s.addTab({ id: 'B', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true }) // switch to B
    // the tab switch must NOT clear A's preview (the exact regression this fixes)
    expect(useStore.getState().openFiles['A']?.src).toBe('/w/a.ts')
    s.setActive('A') // back to A
    expect(useStore.getState().openFiles['A']?.src).toBe('/w/a.ts')
  })

  it('each tab keeps its own file; setOpenFile targets the active tab only', () => {
    const s = useStore.getState()
    s.addTab({ id: 'A', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setOpenFile(f('/w/a.ts')) // A is active
    s.addTab({ id: 'B', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setOpenFile(f('/w/b.ts')) // B is active now
    expect(useStore.getState().openFiles['A']?.src).toBe('/w/a.ts')
    expect(useStore.getState().openFiles['B']?.src).toBe('/w/b.ts')
  })

  it('closing a tab drops only its preview entry', () => {
    const s = useStore.getState()
    s.addTab({ id: 'A', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setOpenFile(f('/w/a.ts'))
    s.addTab({ id: 'B', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setOpenFile(f('/w/b.ts'))
    s.removeTab('B')
    expect(useStore.getState().openFiles['B']).toBeUndefined()
    expect(useStore.getState().openFiles['A']?.src).toBe('/w/a.ts')
  })
})

// R: the modal must show the state the check actually reported. Anything that isn't an
// offer to download must never render as one — an "update available" screen the user can't
// act on (the release is already installed) is exactly the false alarm this guards.
describe('store: update check → modal phase', () => {
  function stubCheck(result: UpdateCheckResult): void {
    ;(globalThis as { window?: unknown }).window = {
      api: { update: { check: async () => result } }
    }
  }
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('renders the newest release already being installed as restart-required, not available', async () => {
    stubCheck({ status: 'restart-required', current: '0.4.4', installed: '0.5.0' })
    useStore.getState().openUpdateCheck()
    await settle()
    const u = useStore.getState().update
    expect(u.phase).toBe('restart-required')
    expect(u.installed).toBe('0.5.0')
    expect(u.current).toBe('0.4.4')
  })

  // `installed` is what the modal's upgrade arrow starts from, so losing it in the mapping
  // silently reverts the arrow to the stale running version — the regression this whole
  // change exists to prevent. Every fixture therefore differs from `current`.
  it('renders a real update as available, keeping the on-disk version for the arrow', async () => {
    stubCheck({
      status: 'available',
      current: '0.4.4',
      installed: '0.5.0',
      latest: '0.6.0',
      releases: [{ version: '0.6.0', notes: '- feat: x' }],
      omittedReleases: 0
    })
    useStore.getState().openUpdateCheck()
    await settle()
    const u = useStore.getState().update
    expect(u.phase).toBe('available')
    expect(u.latest).toBe('0.6.0')
    expect(u.installed).toBe('0.5.0')
    // the changelog has to survive the mapping too — dropping it is what left the modal
    // rendering nothing but install instructions
    expect(u.releases).toEqual([{ version: '0.6.0', notes: '- feat: x' }])
  })

  it('renders an up-to-date app as current, keeping the on-disk version', async () => {
    stubCheck({ status: 'current', current: '0.5.0', installed: '0.4.4' })
    useStore.getState().openUpdateCheck()
    await settle()
    const u = useStore.getState().update
    expect(u.phase).toBe('current')
    expect(u.installed).toBe('0.4.4')
  })

  // The download resolves (rather than rejecting) when the staged version turns out to be on
  // disk already: an error screen's only button re-runs the same download, so the restart has
  // to be offered instead.
  it('turns an already-installed download result into the restart offer', async () => {
    useStore.setState({ update: { open: true, phase: 'downloading', percent: 100 } })
    ;(globalThis as { window?: unknown }).window = {
      api: {
        update: {
          download: async () => ({
            status: 'restart-required' as const,
            current: '0.4.4',
            installed: '0.5.0'
          })
        },
        layout: { set: () => {} }
      }
    }
    useStore.getState().startUpdateDownload()
    await settle()
    const u = useStore.getState().update
    expect(u.phase).toBe('restart-required')
    expect(u.installed).toBe('0.5.0')
    expect(u.restarting).toBe(false)
    expect(u.open).toBe(true) // the offer is worthless if it lands in a closed modal
  })
})

// ---- a shell is a Workbench tab now -------------------------------------
//
// The island's four groups (title, collapse, spawn failure, cwd, boot restore) retired
// with it — three of those behaviours no longer exist at all (there is nothing to
// collapse, nothing is persisted, nothing is restored), and the two that survive moved
// into the panel's tab set. What is pinned here is the part the tab model cannot see:
// which conversation tab a pty belongs to, and what the store does about it.

/** A store whose `window.api` records kills and answers `terminal.create`. `cwd` is what
 *  MAIN answers with, which a test sets apart from what was asked for to model R4's
 *  vanished root. */
function stubTerminalApi(opts: { fail?: boolean; cwd?: string } = {}): {
  killed: string[]
  created: number
} {
  const rec = { killed: [] as string[], created: 0 }
  ;(globalThis as { window?: unknown }).window = {
    api: {
      home: '/home/u',
      terminal: {
        kill: (id: string) => rec.killed.push(id),
        create: () =>
          opts.fail
            ? Promise.reject(new Error('spawn EACCES'))
            : Promise.resolve({ ok: true, id: 'pty' + ++rec.created, cwd: opts.cwd ?? '/w' })
      },
      workbench: { get: () => Promise.resolve({ open: true, tabs: [] }), setState: () => {} }
    }
  }
  return rec
}

/** A conversation tab with a bound, live session and a panel strip holding `shells`. */
function tabWithShells(tabId: string, shells: string[]): void {
  let set = emptyTabSet()
  for (const id of shells) {
    set = openTab(set, { kind: 'terminal', id, cwd: '/w', title: 'zsh', source: 'user' }).set
  }
  set = openTab(set, { kind: 'web', url: 'http://h/p', source: 'user' }).set
  useStore.setState({
    tabs: [{ id: tabId, kind: 'claude', title: 'Claude', cwd: '/w', alive: true }],
    sessions: [session(tabId)],
    activeTabId: tabId,
    workbench: { [tabId]: set },
    workbenchOpen: { [tabId]: true },
    workbenchFetched: { [tabId]: true }
  })
}

// R19 — the label follows the shell's foreground process, and main names the PTY, not the
// conversation. Resolving one to the other is the whole of what the store adds here: get
// it wrong and the wrong session's tab is relabelled, which no e2e selector would notice.
describe('store: a terminal tab’s label follows its shell', () => {
  beforeEach(() => {
    stubTerminalApi()
    tabWithShells('t1', ['p1', 'p2'])
  })

  const titleOf = (id: string): string | undefined =>
    useStore.getState().workbench.t1?.tabs.find((t) => t.id === id)?.title

  it('relabels the shell main named, and only that one', () => {
    useStore.getState().setTermTabProcess('p2', 'node')
    expect(titleOf('p2')).toBe('node')
    expect(titleOf('p1')).toBe('zsh')
  })

  it('the kind bar’s directory follows the shell’s own `cd`', () => {
    useStore.getState().setTermTabCwd('p1', '/w/deeper')
    expect(useStore.getState().workbench.t1?.tabs.find((t) => t.id === 'p1')?.cwd).toBe('/w/deeper')
  })

  it('ignores a pty no conversation tab owns', () => {
    const before = useStore.getState().workbench.t1
    useStore.getState().setTermTabProcess('pty-nobody', 'node')
    useStore.getState().setTermTabCwd('pty-nobody', '/elsewhere')
    expect(useStore.getState().workbench.t1).toBe(before)
  })
})

// R7 — a pty exit has two shapes, and telling them apart is what keeps a ⌘W from being
// processed twice and an `exit` from reaching the session path. Both answers are `true`,
// which is what stops App's exit chain: a shell is never a conversation tab.
describe('store: a shell exiting', () => {
  beforeEach(() => {
    stubTerminalApi()
    tabWithShells('t1', ['p1', 'p2'])
  })

  it('swallows the exit of a shell we killed ourselves, leaving the strip alone', () => {
    useStore.getState().closeTerminalTab('p1')
    const afterKill = useStore.getState().workbench.t1
    expect(useStore.getState().terminalExited('p1')).toBe(true)
    // the tab is the PANEL's to remove on a deliberate close (it promotes the neighbour
    // too); a second removal here would be the double-handling this latch exists to stop
    expect(useStore.getState().workbench.t1).toBe(afterKill)
  })

  it('drops the tab of a shell that ended on its own (`exit`)', () => {
    expect(useStore.getState().terminalExited('p2')).toBe(true)
    expect(useStore.getState().workbench.t1?.tabs.map((t) => t.id)).not.toContain('p2')
    expect(useStore.getState().workbench.t1?.tabs.map((t) => t.id)).toContain('p1')
  })

  it('says no for a pty that is not a shell of ours, so the session path still runs', () => {
    expect(useStore.getState().terminalExited('t1')).toBe(false)
  })
})

// R9 — the one recycling signal, in its two shapes. `processAlive` is what the e2e can
// see; what it cannot see is that the kill goes out at all rather than the tab merely
// disappearing, which would leak a zsh for the rest of the run.
describe('store: a conversation tab going away takes its shells', () => {
  let rec: { killed: string[]; created: number }
  beforeEach(() => {
    rec = stubTerminalApi()
    tabWithShells('t1', ['p1', 'p2'])
  })

  it('removeTab kills every shell it owned and forgets its panel', () => {
    useStore.getState().removeTab('t1')
    expect(rec.killed).toEqual(['p1', 'p2'])
    expect(useStore.getState().workbench.t1).toBeUndefined()
  })

  // …and makes that the ONLY death path there is: a claude that exits closes its
  // tab (App's exit handler → `closeTab` → here), so there is no second hook to write and
  // no frozen tab left behind holding a readable strip. What the disk keeps under the
  // claude session id is what a resume comes back to.
  it('their exits are then swallowed rather than read as a session dying', () => {
    useStore.getState().removeTab('t1')
    expect(useStore.getState().terminalExited('p1')).toBe(true)
    expect(useStore.getState().terminalExited('p2')).toBe(true)
  })
})

// R2/R4 — the store half of opening one. The cap and the ordering are the tab model's
// (workbenchTabs.test); what belongs here is the spawn: the shell that never started has
// to say so, or ⌃` reads as a dead key with an unchanged strip as its only evidence.
describe('store: opening a terminal tab', () => {
  it('adds the shell main answered with, in the tab’s own root, and expands the panel', async () => {
    stubTerminalApi()
    useStore.setState({
      tabs: [{ id: 't1', kind: 'claude', title: 'Claude', cwd: '/launch', alive: true }],
      sessions: [{ ...session('t1'), treeRoot: '/w/worktree' }],
      activeTabId: 't1',
      workbench: { t1: emptyTabSet() },
      workbenchOpen: { t1: false },
      workbenchFetched: { t1: true },
      termFocus: { ptyId: '', n: 0 }
    })
    useStore.getState().openTerminalTab('t1')
    await vi.waitFor(() => expect(useStore.getState().workbench.t1?.tabs).toHaveLength(2))
    const tab = useStore.getState().workbench.t1!.tabs[1]
    expect(tab.kind).toBe('terminal')
    expect(tab.id).toBe('pty1')
    expect(tab.title).toBe('zsh')
    expect(useStore.getState().workbench.t1!.activeId).toBe('pty1')
    expect(useStore.getState().workbenchOpen.t1).toBe(true)
    // R5: the caret goes into the shell — and the request NAMES it, so no other
    // mounted shell can answer it (the caret-stealing bug this shape exists to stop)
    expect(useStore.getState().termFocus).toEqual({ ptyId: 'pty1', n: 1 })
  })

  it('says so out loud when the shell never started', async () => {
    stubTerminalApi({ fail: true })
    useStore.setState({
      tabs: [{ id: 't1', kind: 'claude', title: 'Claude', cwd: '/w', alive: true }],
      sessions: [session('t1')],
      activeTabId: 't1',
      workbench: { t1: emptyTabSet() },
      workbenchFetched: { t1: true },
      toast: null
    })
    useStore.getState().openTerminalTab('t1')
    await vi.waitFor(() => expect(useStore.getState().toast).toBeTruthy())
    expect(useStore.getState().toast).toContain('Could not open a terminal')
    expect(useStore.getState().workbench.t1?.tabs).toHaveLength(1)
  })

  // R4 — the conversation tab's root is gone (a worktree cleaned up under a live
  // session). Main's fallback chain puts the shell somewhere real and ANSWERS with that
  // directory; the difference between what was asked for and what came back is the only
  // signal the renderer gets, and it has to become a sentence. The shell still opens: the
  // notice is the point, not a refusal.
  it('says where the shell landed when the tab’s root has vanished', async () => {
    stubTerminalApi({ cwd: '/elsewhere' })
    useStore.setState({
      tabs: [{ id: 't1', kind: 'claude', title: 'Claude', cwd: '/gone', alive: true }],
      sessions: [{ ...session('t1'), treeRoot: '/gone' }],
      activeTabId: 't1',
      workbench: { t1: emptyTabSet() },
      workbenchFetched: { t1: true },
      toast: null
    })
    useStore.getState().openTerminalTab('t1')

    await vi.waitFor(() => expect(useStore.getState().toast).toBeTruthy())
    expect(useStore.getState().toast).toBe('Folder is gone — terminal opened in /elsewhere')
    // …and the tab is there, standing in the directory main gave it
    expect(useStore.getState().workbench.t1?.tabs[1].cwd).toBe('/elsewhere')
  })

  it('refuses the ninth with the cap notice, and opens nothing', async () => {
    const rec = stubTerminalApi()
    tabWithShells('t1', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'])
    useStore.setState({ toast: null })
    useStore.getState().openTerminalTab('t1')
    await vi.waitFor(() => expect(useStore.getState().toast).toBeTruthy())
    expect(useStore.getState().toast).toBe('Terminal limit reached: at most 8 per session')
    // checked BEFORE the spawn: no process was started only to be killed again
    expect(rec.created).toBe(0)
  })
})

// An explicit file open IS panel intent (the pre-aux drawer behavior, now FR-57): with
// the session's Workbench collapsed (T1), opening a file must expand it to T2 and put the
// pinned `files` tab in front; closing the pane must leave both alone.
describe('store: opening a file expands the session Workbench onto `files` (FR-57)', () => {
  /** D8: the panel is keyed by the CONVERSATION TAB, so this is the tab id,
   *  not the `sid-tab-A` the session is bound to */
  const SID = 'tab-A'

  /** a session whose panel is collapsed and whose strip has a `web` tab in front, so the
   *  flip to `files` is a visible transition rather than the empty set's default */
  function seed(open: boolean): void {
    ;(globalThis as { window?: unknown }).window = {
      api: { workbench: { setState: () => {} } }
    }
    const s = useStore.getState()
    s.addTab({ id: 'tab-A', kind: 'claude', title: 'S', cwd: '/w', alive: true })
    useStore.setState({
      sessions: [session('tab-A')],
      workbench: {},
      workbenchOpen: {},
      workbenchFetched: {}
    })
    s.setWorkbenchState(SID, { open, tabs: [{ kind: 'web', title: 'A', url: 'http://x/a' }] })
    const web = useStore.getState().workbench[SID].tabs[1].id
    s.updateWorkbenchTabs(SID, (prev) => activateTab(prev, web))
  }

  it('a user click while the panel is collapsed expands it and activates `files`', () => {
    seed(false)
    useStore.getState().setOpenFile({ src: '/w/a.md', label: 'a.md' })
    expect(useStore.getState().workbenchOpen[SID]).toBe(true)
    expect(useStore.getState().workbench[SID].activeId).toBe(FILES_TAB_ID)
  })

  it('closing the pane (null) never expands the panel nor moves the active tab', () => {
    seed(false)
    const before = useStore.getState().workbench[SID].activeId
    useStore.getState().setOpenFile(null)
    expect(useStore.getState().workbenchOpen[SID]).toBe(false)
    expect(useStore.getState().workbench[SID].activeId).toBe(before)
  })
})

// B9 — this REPLACES F3. A reveal toast used to wait for the user because
// it was the only door to a finished download; the download list is that door now, so
// the toast is a notice again and every toast auto-dismisses. Missing it costs nothing.
describe('store: every toast auto-dismisses now that the list holds the file', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useStore.setState({ toast: null, toastReveal: null })
  })
  afterEach(() => {
    useStore.getState().dismissToast()
    vi.useRealTimers()
  })

  it('takes a reveal toast down after the same 4s as any other', () => {
    useStore.getState().showToast('Downloaded a.zip', '/d/a.zip')
    vi.advanceTimersByTime(4000)
    expect(useStore.getState().toast).toBeNull()
    expect(useStore.getState().toastReveal).toBeNull()
  })

  it('is still up before that window closes — the user gets a chance to click it', () => {
    useStore.getState().showToast('Downloaded a.zip', '/d/a.zip')
    vi.advanceTimersByTime(2000)
    expect(useStore.getState().toast).toContain('a.zip')
    expect(useStore.getState().toastReveal).toBe('/d/a.zip')
  })

  it('still auto-dismisses a plain notice after 4s', () => {
    useStore.getState().showToast('Folder is gone')
    vi.advanceTimersByTime(4000)
    expect(useStore.getState().toast).toBeNull()
  })

  it('dismissToast takes down the message and its file together', () => {
    useStore.getState().showToast('Downloaded a.zip', '/d/a.zip')
    useStore.getState().dismissToast()
    expect(useStore.getState().toast).toBeNull()
    expect(useStore.getState().toastReveal).toBeNull()
  })

  it('a new toast restarts the window rather than inheriting what is left of the old one', () => {
    useStore.getState().showToast('Folder is gone')
    vi.advanceTimersByTime(3000)
    useStore.getState().showToast('Downloaded a.zip', '/d/a.zip')
    vi.advanceTimersByTime(2000)
    // 5s since the first toast, 2s since this one: still up
    expect(useStore.getState().toastReveal).toBe('/d/a.zip')
    vi.advanceTimersByTime(2500)
    expect(useStore.getState().toast).toBeNull()
  })
})

// ---- review batch 1: the fixes that only a unit case can pin ------------------------

// R1/§04 — ⇧⌘R swaps a fresh pty into the same conversation-tab slot, and the tracker
// REGISTERS it before Claude Code's SessionStart hook fires: for those seconds the sessions
// push carries `sessionId: ''`. Everything that asks "does this tab still have a claude"
// has to answer yes through that window. It is the one question with two destructive
// answers — App's `liveTabs` unmounts the tab's shells on a no (and an unmounted xterm's
// scrollback is gone, since main keeps none), and the Files view resets what is on screen.
describe('store: a tab’s bound session id across the restart window', () => {
  const restarted = {
    id: 'pty-new',
    kind: 'claude' as const,
    title: 'Claude',
    cwd: '/w',
    alive: true,
    sessionId: 'sess-A'
  }

  it('answers with the tab’s own anchor while the fresh pty is registered but unbound', () => {
    // this exact shape is what a restart leaves behind for a second or two
    const state = { tabs: [restarted], sessions: [{ ...session('pty-new'), sessionId: '' }] }
    expect(boundSessionId(state, 'pty-new')).toBe('sess-A')
  })

  it('prefers the LIVE binding once the hook has fired', () => {
    const state = { tabs: [restarted], sessions: [{ ...session('pty-new'), sessionId: 'sess-B' }] }
    expect(boundSessionId(state, 'pty-new')).toBe('sess-B')
  })

  it('still has nothing to say about a fresh tab that never bound anything', () => {
    const fresh = { id: 'pty-1', kind: 'claude' as const, title: 'Claude', cwd: '/w', alive: true }
    expect(boundSessionId({ tabs: [fresh], sessions: [] }, 'pty-1')).toBeUndefined()
  })
})

// R2 — the cap is checked before the spawn, so two ⌃`s fired at seven shells BOTH
// pass it and only the second is over the line by the time its shell exists. The tab is
// refused; the process is not, unless something kills it.
describe('store: a terminal refused after its shell already started', () => {
  it('kills the shell it cannot give a tab to, instead of leaking it', async () => {
    const rec = stubTerminalApi()
    tabWithShells('t1', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'])
    useStore.setState({ toast: null })

    // both calls read seven shells and pass the pre-spawn check
    useStore.getState().openTerminalTab('t1')
    useStore.getState().openTerminalTab('t1')

    await vi.waitFor(() =>
      expect(
        useStore.getState().workbench.t1?.tabs.filter((t) => t.kind === 'terminal')
      ).toHaveLength(8)
    )
    await vi.waitFor(() => expect(useStore.getState().toast).toBeTruthy())
    expect(useStore.getState().toast).toBe('Terminal limit reached: at most 8 per session')
    // the assertion carrying the case: both shells were spawned, and the one with no tab
    // was killed. Counting tabs alone passes on a build that simply drops the ninth.
    expect(rec.created).toBe(2)
    expect(rec.killed).toEqual(['pty2'])
  })
})

// a tab that was restarted and THEN resumed carries two different ids in two places. The
// baked one is what the panel is written under and what the next ⇧⌘R resumes.
// ---- review batch 5 -------------------------------------------------------------------

/** Put unsaved text in one conversation tab's editor. Module state, so every case that
 *  uses it clears up after itself. */
function dirtyBuffer(ownerTab: string, tabId: string): void {
  beginEdit(ownerTab, tabId, {
    path: '/w/notes.md',
    text: 'on disk',
    eol: 'lf',
    stamp: { size: 7, mtimeMs: 1 },
    readOnly: null
  })
  setText(ownerTab, tabId, 'typed but never saved')
}

// R2/D2 — the spawn is a round trip, and the conversation tab can go inside it. Since
// a claude that dies closes its tab, so both ways of losing it land in the same
// state: a shell whose strip nobody holds any more, whose zsh would run for the rest of
// the run with nothing able to reach it.
describe('store: a terminal spawn that lands on a tab already gone', () => {
  it('kills the shell instead of adding it to a strip nobody holds', async () => {
    const rec = stubTerminalApi()
    useStore.setState({
      tabs: [{ id: 't1', kind: 'claude', title: 'Claude', cwd: '/w', alive: true }],
      sessions: [session('t1')],
      activeTabId: 't1',
      workbench: { t1: emptyTabSet() },
      workbenchFetched: { t1: true }
    })

    useStore.getState().openTerminalTab('t1')
    // the claude dies inside the create round trip, which closes its tab
    useStore.getState().removeTab('t1')

    await vi.waitFor(() => expect(rec.killed).toContain('pty1'))
    expect(useStore.getState().workbench.t1).toBeUndefined()
  })
})

// ⇄ D8 — the CDP relay addresses SESSIONS, the panel is keyed by CONVERSATION
// TAB, and this is the one conversion between them. It matches through `boundSessionId`,
// which is what makes the registered-but-unbound case work: the tracker reports `''`
// there, so the direct `sessions[].sessionId === sid` comparison this replaced answered
// nothing for exactly the tab a client is driving — and a null answer reaches the client
// as "the page did not open".
describe('tabForSession', () => {
  const tab = (
    id: string,
    sessionId?: string
  ): {
    id: string
    kind: 'claude'
    title: string
    cwd: string
    alive: boolean
    sessionId?: string
  } => ({
    id,
    kind: 'claude',
    title: 'S',
    cwd: '/w',
    alive: true,
    ...(sessionId ? { sessionId } : {})
  })

  it('resolves a tab whose session is live', () => {
    const state = { tabs: [tab('pty-1')], sessions: [{ ...session('pty-1'), sessionId: 'sid-A' }] }
    expect(tabForSession(state, 'sid-A')).toBe('pty-1')
  })

  it('resolves a tab that is registered but not yet hook-bound, through its anchor', () => {
    // the restart window: the push carries '' while the tab still carries the id it is
    // resuming. This is the case the direct comparison got wrong.
    const state = {
      tabs: [tab('pty-2', 'sid-B')],
      sessions: [{ ...session('pty-2'), sessionId: '' }]
    }
    expect(tabForSession(state, 'sid-B')).toBe('pty-2')
  })

  it('answers undefined for a session no tab is bound to, and for an empty id', () => {
    const state = { tabs: [tab('pty-1')], sessions: [{ ...session('pty-1'), sessionId: 'sid-A' }] }
    expect(tabForSession(state, 'sid-ZZZ')).toBeUndefined()
    // '' is what an unbound entry carries — it must never match the first unbound tab
    expect(tabForSession({ tabs: [tab('pty-3')], sessions: [] }, '')).toBeUndefined()
  })
})

// D7 — the workspace itself is selectable, so its Notes island can be reached with
// nothing running in it. The rule the whole feature rests on: a session tab and a
// workspace head are ONE selection, so exactly one of them is ever set.
describe('selectWorkspace', () => {
  const wsRows = (...paths: string[]): WorkspaceRows[] =>
    paths.map((path) => ({
      workspace: { path, missing: false, isGit: true, hasHistory: false },
      rows: []
    }))

  it('picks the workspace, drops the active tab and leaves the running tabs alone', () => {
    const s = useStore.getState()
    s.addTab({ id: 'sel1', kind: 'claude', title: 'A', cwd: '/w/a', alive: true })
    expect(useStore.getState().activeTabId).toBe('sel1')

    useStore.getState().selectWorkspace('/w/b')
    const st = useStore.getState()
    expect(st.selectedWs).toBe('/w/b')
    expect(st.activeTabId).toBeNull()
    // the sessions keep running in the background — only the selection moved
    expect(st.tabs.map((t) => t.id)).toEqual(['sel1'])
    // …and the welcome panel follows the pick (O2 reads lastWsPath)
    expect(st.lastWsPath).toBe('/w/b')
  })

  it('gives the pick back to a tab the moment one goes active', () => {
    const s = useStore.getState()
    s.addTab({ id: 'sel2', kind: 'claude', title: 'A', cwd: '/w/a', alive: true })
    useStore.getState().selectWorkspace('/w/b')
    expect(useStore.getState().selectedWs).toBe('/w/b')

    useStore.getState().activateTab('sel2')
    expect(useStore.getState().activeTabId).toBe('sel2')
    expect(useStore.getState().selectedWs).toBeNull()
  })

  it('drops the pick when that workspace stops being listed', () => {
    useStore.getState().setWorkspaceRows(wsRows('/w/a', '/w/b'))
    useStore.getState().selectWorkspace('/w/b')
    expect(useStore.getState().selectedWs).toBe('/w/b')

    useStore.getState().setWorkspaceRows(wsRows('/w/a'))
    expect(useStore.getState().selectedWs).toBeNull()
  })

  it('drops the pick the moment a cold row starts resuming, before any tab exists', () => {
    // clicking a COLD row lights that row while its session starts, and there is no tab
    // yet — so without this the head and the row both read as picked, and the sidebar
    // shows two selections at once.
    useStore.getState().selectWorkspace('/w/b')
    expect(useStore.getState().selectedWs).toBe('/w/b')

    useStore.getState().setResumeLaunch({ id: 'sess-cold', title: 'old session' })
    expect(useStore.getState().selectedWs).toBeNull()
    expect(useStore.getState().resumeLaunch?.id).toBe('sess-cold')
  })
})
