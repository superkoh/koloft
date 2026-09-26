import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { SessionInfo, UpdateCheckResult, WorkspaceRows } from '@shared/types'
import {
  boundSessionId,
  tabForSession,
  useStore,
  openInterceptedFile,
  markRestoreLaunch,
  consumeRestoreExit
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

function session(tabId: string): SessionInfo {
  return {
    tabId,
    backendId: 'claude',
    host: 'local',
    sessionId: 'sid-' + tabId,
    title: 'Live title',
    cwd: '/w',
    treeRoot: '/w',
    files: [],
    alive: true,
    updatedAt: 0
  }
}

const NO_UPDATE_DOWNLOAD_IN_FLIGHT = { open: false, phase: 'checking' as const }

beforeEach(() => {
  useStore.setState({
    tabs: [],
    sessions: [],
    activeTabId: null,
    openFiles: {},
    update: NO_UPDATE_DOWNLOAD_IN_FLIGHT
  })
})

describe('store: claude → shell revert, only after a session actually bound', () => {
  it('reverts a claude tab to a shell once its (previously bound) session ends', () => {
    const s = useStore.getState()
    s.addTab({
      id: 'rev1',
      kind: 'claude',
      title: 'My session',
      cwd: '/w',
      alive: true
    })
    s.setSessions([session('rev1')])
    s.setSessions([])
    const t = useStore.getState().tabs.find((x) => x.id === 'rev1')!
    expect(t.kind).toBe('shell')
    expect(t.title).toBe('Terminal')
    expect(t.sessionId).toBeUndefined()
  })

  it('does NOT revert a claude tab that never bound a session (launch window)', () => {
    const s = useStore.getState()
    s.addTab({ id: 'nev1', kind: 'claude', title: 'Claude', cwd: '/w', alive: true })
    s.setSessions([])
    expect(useStore.getState().tabs.find((x) => x.id === 'nev1')!.kind).toBe('claude')
  })

  it('T-LIFE-06: clears the resuming placeholder flag once the session binds, so the overlay never returns when it ends', () => {
    const s = useStore.getState()
    s.addTab({
      id: 'rs1',
      kind: 'claude',
      title: 'T',
      cwd: '/w',
      alive: true,
      resuming: true
    })
    s.setSessions([session('rs1')])
    expect(useStore.getState().tabs.find((x) => x.id === 'rs1')!.resuming).toBeFalsy()
  })

  it('leaves a plain shell tab untouched', () => {
    const s = useStore.getState()
    s.addTab({ id: 'sh1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setSessions([])
    expect(useStore.getState().tabs.find((x) => x.id === 'sh1')!.kind).toBe('shell')
  })

  it('reverting the active claude tab to a shell clears its open file, like a switch', () => {
    const s = useStore.getState()
    s.addTab({ id: 'P', kind: 'claude', title: 'S', cwd: '/w', alive: true })
    s.setSessions([session('P')])
    useStore.setState({ openFiles: { P: { src: '/w/NOTES.md', label: 'NOTES.md' } } })
    s.setSessions([])
    expect(useStore.getState().openFiles['P']).toBeUndefined()
  })
})

describe('store: intercepted file open routing — the open always surfaces, tagged so it stays out of Recent', () => {
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

  it("activates a background tab first; the preview lands on that tab and survives the switch's view reset", () => {
    const s = useStore.getState()
    s.addTab({ id: 'op1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.addTab({ id: 'op2', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    openInterceptedFile('op1', '/w/doc.md')
    expect(useStore.getState().activeTabId).toBe('op1')
    expect(useStore.getState().openFiles['op1']?.src).toBe('/w/doc.md')
  })

  it('still surfaces the preview when the tab closed since the shim fired (no activation)', () => {
    const s = useStore.getState()
    s.addTab({ id: 'op1', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    openInterceptedFile('gone', '/w/doc.md')
    expect(useStore.getState().activeTabId).toBe('op1')
    expect(useStore.getState().openFiles['op1']?.src).toBe('/w/doc.md')
  })

  it('falls back to OS open when there is no tab to attach the preview to (never swallowed)', () => {
    const calls: string[] = []
    ;(globalThis as { window?: unknown }).window = {
      api: { preview: { osOpen: (p: string) => calls.push(p) } }
    }
    openInterceptedFile('gone', '/w/orphan.md')
    expect(calls).toEqual(['/w/orphan.md'])
    expect(useStore.getState().openFiles).toEqual({})
  })
})

describe('store: per-tab preview persistence', () => {
  const f = (src: string) => ({ src, label: src.split('/').pop()! })

  it('a file opened on one tab is retained when the active tab switches away and back', () => {
    const s = useStore.getState()
    s.addTab({ id: 'A', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setOpenFile(f('/w/a.ts'))
    expect(useStore.getState().openFiles['A']?.src).toBe('/w/a.ts')
    s.addTab({ id: 'B', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    expect(useStore.getState().openFiles['A']?.src).toBe('/w/a.ts')
    s.setActive('A')
    expect(useStore.getState().openFiles['A']?.src).toBe('/w/a.ts')
  })

  it('each tab keeps its own file; setOpenFile targets the active tab only', () => {
    const s = useStore.getState()
    s.addTab({ id: 'A', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setOpenFile(f('/w/a.ts'))
    s.addTab({ id: 'B', kind: 'shell', title: 'Terminal', cwd: '/w', alive: true })
    s.setOpenFile(f('/w/b.ts'))
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

describe('store: update check → modal phase — never an offer the user cannot act on', () => {
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

  it('renders a real update as available, keeping the on-disk version for the arrow and the changelog', async () => {
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
    expect(u.open).toBe(true)
  })
})

function stubTerminalApi(opts: { fail?: boolean; mainAnswersCwd?: string } = {}): {
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
            : Promise.resolve({
                ok: true,
                id: 'pty' + ++rec.created,
                cwd: opts.mainAnswersCwd ?? '/w'
              })
      },
      workbench: { get: () => Promise.resolve({ open: true, tabs: [] }), setState: () => {} }
    }
  }
  return rec
}

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

describe('store: a terminal tab’s label follows its shell — main names the pty, the store finds its conversation tab', () => {
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

describe("store: a shell exiting — handled here, never on App's session exit path", () => {
  beforeEach(() => {
    stubTerminalApi()
    tabWithShells('t1', ['p1', 'p2'])
  })

  it('swallows the exit of a shell we killed ourselves, leaving the strip for the panel to update', () => {
    useStore.getState().closeTerminalTab('p1')
    const afterKill = useStore.getState().workbench.t1
    expect(useStore.getState().terminalExited('p1')).toBe(true)
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

describe('store: a conversation tab going away kills its shells, not just their tabs', () => {
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

  it('their exits are then swallowed rather than read as a session dying', () => {
    useStore.getState().removeTab('t1')
    expect(useStore.getState().terminalExited('p1')).toBe(true)
    expect(useStore.getState().terminalExited('p2')).toBe(true)
  })
})

describe('store: closing a tab whose restore is still launching', () => {
  it('is a cancel, so the exit that follows is not read as a failed restore', () => {
    stubTerminalApi()
    useStore.getState().addTab({ id: 'rst1', kind: 'claude', title: 'T', cwd: '/w', alive: true })
    markRestoreLaunch('rst1')
    useStore.getState().closeTab('rst1')
    expect(consumeRestoreExit('rst1')).toBe(false)
  })
})

describe('store: opening a terminal tab', () => {
  it('adds the shell main answered with, in the tab’s own root, expands the panel and asks focus for that shell by name', async () => {
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

  it('says where the shell landed when the tab’s root has vanished, and still opens it', async () => {
    stubTerminalApi({ mainAnswersCwd: '/elsewhere' })
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
    expect(useStore.getState().workbench.t1?.tabs[1].cwd).toBe('/elsewhere')
  })

  it('refuses the ninth with the cap notice before spawning anything', async () => {
    const rec = stubTerminalApi()
    tabWithShells('t1', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'])
    useStore.setState({ toast: null })
    useStore.getState().openTerminalTab('t1')
    await vi.waitFor(() => expect(useStore.getState().toast).toBeTruthy())
    expect(useStore.getState().toast).toBe('Terminal limit reached: at most 8 per session')
    expect(rec.created).toBe(0)
  })
})

describe('store: opening a file expands the session Workbench onto `files` (FR-57)', () => {
  const SID = 'tab-A'

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

describe('store: every toast auto-dismisses now that the download list holds the file', () => {
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
    expect(useStore.getState().toastReveal).toBe('/d/a.zip')
    vi.advanceTimersByTime(2500)
    expect(useStore.getState().toast).toBeNull()
  })
})

describe('store: a tab’s bound session id across the ⇧⌘R restart window, before SessionStart binds the fresh pty', () => {
  const restarted = {
    id: 'pty-new',
    kind: 'claude' as const,
    host: 'local' as const,
    title: 'Claude',
    cwd: '/w',
    alive: true,
    sessionId: 'sess-A'
  }

  it('answers with the tab’s own anchor while the fresh pty is registered but unbound', () => {
    const state = { tabs: [restarted], sessions: [{ ...session('pty-new'), sessionId: '' }] }
    expect(boundSessionId(state, 'pty-new')).toBe('sess-A')
  })

  it('prefers the LIVE binding once the hook has fired', () => {
    const state = { tabs: [restarted], sessions: [{ ...session('pty-new'), sessionId: 'sess-B' }] }
    expect(boundSessionId(state, 'pty-new')).toBe('sess-B')
  })

  it('still has nothing to say about a fresh tab that never bound anything', () => {
    const fresh = {
      id: 'pty-1',
      kind: 'claude' as const,
      host: 'local' as const,
      title: 'Claude',
      cwd: '/w',
      alive: true
    }
    expect(boundSessionId({ tabs: [fresh], sessions: [] }, 'pty-1')).toBeUndefined()
  })
})

describe('store: a terminal refused after its shell already started', () => {
  it('kills the shell it cannot give a tab to, instead of leaking it', async () => {
    const rec = stubTerminalApi()
    tabWithShells('t1', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'])
    useStore.setState({ toast: null })

    useStore.getState().openTerminalTab('t1')
    useStore.getState().openTerminalTab('t1')

    await vi.waitFor(() =>
      expect(
        useStore.getState().workbench.t1?.tabs.filter((t) => t.kind === 'terminal')
      ).toHaveLength(8)
    )
    await vi.waitFor(() => expect(useStore.getState().toast).toBeTruthy())
    expect(useStore.getState().toast).toBe('Terminal limit reached: at most 8 per session')
    expect(rec.created).toBe(2)
    expect(rec.killed).toEqual(['pty2'])
  })
})

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
    useStore.getState().removeTab('t1')

    await vi.waitFor(() => expect(rec.killed).toContain('pty1'))
    expect(useStore.getState().workbench.t1).toBeUndefined()
  })
})

describe("tabForSession: the CDP relay's session id to the conversation tab the panel is keyed by", () => {
  const tab = (
    id: string,
    sessionId?: string
  ): {
    id: string
    kind: 'claude'
    host: 'local'
    title: string
    cwd: string
    alive: boolean
    sessionId?: string
  } => ({
    id,
    kind: 'claude',
    host: 'local',
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
    const state = {
      tabs: [tab('pty-2', 'sid-B')],
      sessions: [{ ...session('pty-2'), sessionId: '' }]
    }
    expect(tabForSession(state, 'sid-B')).toBe('pty-2')
  })

  it('answers undefined for a session no tab is bound to, and for an empty id', () => {
    const state = { tabs: [tab('pty-1')], sessions: [{ ...session('pty-1'), sessionId: 'sid-A' }] }
    expect(tabForSession(state, 'sid-ZZZ')).toBeUndefined()
    expect(tabForSession({ tabs: [tab('pty-3')], sessions: [] }, '')).toBeUndefined()
  })
})

describe('selectWorkspace: a session tab and a workspace head are one selection', () => {
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
    expect(st.tabs.map((t) => t.id)).toEqual(['sel1'])
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

  it('drops the pick the moment a cold row starts resuming, before any tab exists, so the sidebar never shows two picks', () => {
    useStore.getState().selectWorkspace('/w/b')
    expect(useStore.getState().selectedWs).toBe('/w/b')

    useStore.getState().setResumeLaunch({ id: 'sess-cold', title: 'old session' })
    expect(useStore.getState().selectedWs).toBeNull()
    expect(useStore.getState().resumeLaunch?.id).toBe('sess-cold')
  })
})
