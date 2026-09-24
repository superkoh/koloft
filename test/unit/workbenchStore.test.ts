import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { SessionInfo, SessionRow, SessionWorkbenchState, WorkspaceRows } from '@shared/types'
import {
  FILES_TAB_ID,
  activateTab,
  cdpVisibleTabs,
  closeTab,
  moveTab,
  openTab,
  type WorkbenchTabSet
} from '../../src/renderer/src/components/workbenchTabs'

const setState = vi.fn()
const osOpen = vi.fn()
const openExternal = vi.fn()
let disk: Record<string, SessionWorkbenchState> = {}
const get = vi.fn(async (sessionId: string) => disk[sessionId] ?? { open: true, tabs: [] })

vi.stubGlobal('window', {
  api: {
    workbench: { get, setState },
    preview: { osOpen },
    browser: { openExternal },
    settings: { set: vi.fn() },
    terminal: { kill: vi.fn() }
  }
})

const { useStore, previewLinkTarget, openWebPage, tabEvictedNotice } =
  await import('../../src/renderer/src/store')
const { beginEdit, endEdit, getEntry, setText, allDirtyTabs } =
  await import('../../src/renderer/src/editRegistry')

const TAB = 'pty-1'
const SID = 'sess-1'
const TAB2 = 'pty-2'
const SID2 = 'sess-2'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function boundSession(): SessionInfo {
  return { tabId: TAB, sessionId: SID, alive: true, title: 'S', cwd: '/ws' } as SessionInfo
}

function boundSession2(): SessionInfo {
  return { tabId: TAB2, sessionId: SID2, alive: true, title: 'T', cwd: '/ws' } as SessionInfo
}

function bindThirdTab(): void {
  useStore.setState((s) => ({
    tabs: [
      ...s.tabs,
      { id: 'pty-3', kind: 'claude', host: 'local', title: 'U', cwd: '/ws', alive: true }
    ],
    sessions: [
      ...s.sessions,
      { tabId: 'pty-3', sessionId: 'sess-3', alive: true, title: 'U', cwd: '/ws' } as SessionInfo
    ]
  }))
}

function strip(tabId = TAB): ReturnType<typeof useStore.getState>['workbench'][string] {
  return useStore.getState().workbench[tabId]
}

function openWeb(url: string, source: 'agent' | 'user', tabId = TAB): void {
  useStore.getState().openWorkbenchTarget(tabId, { url, source })
}

function gesture(update: (prev: WorkbenchTabSet) => WorkbenchTabSet, tabId = TAB): void {
  useStore.getState().updateWorkbenchTabs(tabId, update)
}

beforeEach(() => {
  setState.mockClear()
  get.mockClear()
  osOpen.mockClear()
  openExternal.mockClear()
  disk = {}
  useStore.setState({
    tabs: [
      { id: TAB, kind: 'claude', host: 'local', title: 'S', cwd: '/ws', alive: true },
      { id: TAB2, kind: 'claude', host: 'local', title: 'T', cwd: '/ws', alive: true }
    ],
    activeTabId: TAB,
    sessions: [boundSession(), boundSession2()],
    openFiles: {},
    workbench: {},
    workbenchFetched: { [TAB]: true, [TAB2]: true },
    workbenchOpen: { [TAB]: false },
    workbenchLoad: null,
    workbenchFull: false,
    toast: null,
    overlay: null,
    cdpAttached: {}
  })
})

describe('openWorkbenchTarget (FR-13/15/57 — one dedup, one cap, one source fork)', () => {
  it('FR-57: a user open activates the tab, expands the panel and asks for a load', () => {
    openWeb('http://localhost:1/a', 'user')

    const set = strip()
    expect(set.tabs.map((t) => t.kind)).toEqual(['files', 'web'])
    expect(set.activeId).toBe(set.tabs[1].id)
    expect(set.tabs[1].unread).toBe(false)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)
    expect(useStore.getState().workbenchLoad).toMatchObject({
      ownerTabId: TAB,
      tabId: set.tabs[1].id
    })
  })

  it('FR-13: an agent open builds an unread tab and touches nothing else (WB-T02/K07)', () => {
    openWeb('http://localhost:1/a', 'agent')

    const set = strip()
    expect(set.tabs[1].unread).toBe(true)
    expect(set.tabs[1].url).toBe('http://localhost:1/a')
    expect(set.tabs[1].title).toBe('')
    expect(set.activeId).toBe(FILES_TAB_ID)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(false)
    expect(useStore.getState().workbenchLoad).toBeNull()
  })

  it('the agent owns a tab only when its open command or a CDP page made it — a user open, and a ⌘-click that opens in the background, stay the user’s', async () => {
    useStore.getState().openWorkbenchTarget(TAB, {
      url: 'http://localhost:1/shim',
      source: 'agent',
      fromShim: true
    })
    openWeb('http://localhost:1/popup', 'agent')
    openWeb('http://localhost:1/mine', 'user')
    await useStore.getState().openCdpTab(TAB, 'http://localhost:1/cdp')

    expect(cdpVisibleTabs(strip()).map((t) => t.url)).toEqual([
      'http://localhost:1/shim',
      'http://localhost:1/cdp'
    ])
  })

  it('FR-15: a user re-open focuses the existing tab, never a second one, and re-asks for a load (WB-T06)', () => {
    openWeb('http://localhost:1/a?x=1#frag', 'user')
    const first = strip().tabs[1].id
    gesture((prev) => activateTab(prev, FILES_TAB_ID))

    openWeb('http://localhost:1/a?x=1', 'user')

    expect(strip().tabs).toHaveLength(2)
    expect(strip().activeId).toBe(first)
    expect(useStore.getState().workbenchLoad?.nonce).toBe(2)
  })

  it('FR-15: an agent re-open only re-lights unread and never switches away (WB-T03)', () => {
    openWeb('http://localhost:1/a', 'agent')
    const tabId = strip().tabs[1].id
    gesture((prev) => activateTab(prev, tabId))
    gesture((prev) => activateTab(prev, FILES_TAB_ID))
    expect(strip().tabs[1].unread).toBe(false)

    openWeb('http://localhost:1/a', 'agent')

    expect(strip().tabs).toHaveLength(2)
    expect(strip().tabs[1].unread).toBe(true)
    expect(strip().activeId).toBe(FILES_TAB_ID)
    expect(useStore.getState().workbenchLoad).toBeNull()
  })

  it('FR-22/23: the 9th web tab evicts the least-recently-viewed, named in a toast (WB-T10)', () => {
    for (let i = 1; i <= 8; i++) {
      openWeb(`http://localhost:1/t${i}`, 'user')
    }
    expect(strip().tabs.filter((t) => t.kind === 'web')).toHaveLength(8)

    openWeb('http://localhost:1/t9', 'user')

    const set = strip()
    expect(set.tabs.filter((t) => t.kind === 'web')).toHaveLength(8)
    expect(set.tabs.some((t) => t.url?.endsWith('/t1'))).toBe(false)
    expect(set.tabs[0].kind).toBe('files')
    expect(useStore.getState().toast).toBe(tabEvictedNotice('localhost:1/t1'))
  })

  it('FR-22: the cap counts per kind — eight web tabs never evict a `file` tab (WB-T11)', () => {
    for (let i = 1; i <= 8; i++) {
      openWeb(`http://localhost:1/t${i}`, 'user')
    }
    gesture((prev) => openTab(prev, { kind: 'file', path: '/ws/a.ts', source: 'user' }).set)

    openWeb('http://localhost:1/t9', 'user')

    const set = strip()
    expect(set.tabs.filter((t) => t.kind === 'web')).toHaveLength(8)
    expect(set.tabs.filter((t) => t.kind === 'file').map((t) => t.path)).toEqual(['/ws/a.ts'])
  })

  it('each session keeps its own strip', () => {
    openWeb('http://localhost:1/a', 'user')
    openWeb('http://localhost:1/b', 'user', TAB2)

    expect(strip().tabs.map((t) => t.url)).toEqual([undefined, 'http://localhost:1/a'])
    expect(strip(TAB2).tabs.map((t) => t.url)).toEqual([undefined, 'http://localhost:1/b'])
  })

  it('FR-10/14: the open route carries web targets only — a file has no tab to make', () => {
    openWeb('http://localhost:1/a', 'user')
    expect(strip().tabs.every((t) => t.kind !== 'file')).toBe(true)
    expect([...new Set(strip().tabs.map((t) => t.kind))].sort()).toEqual(['files', 'web'])
  })
})

describe('setOpenFile (the source fork, FR-14/51/57): an agent open lights no signal, even while the panel is collapsed', () => {
  function seedWebActive(): string {
    useStore.getState().setWorkbenchState(TAB, {
      open: false,
      tabs: [{ kind: 'web', title: 'A', url: 'http://localhost:1/a' }]
    })
    const web = strip().tabs[1].id
    gesture((prev) => activateTab(prev, web))
    setState.mockClear()
    return web
  }

  it('FR-57: a user open activates `files` and expands the collapsed panel (WB-T21)', () => {
    seedWebActive()

    useStore.getState().setOpenFile({ src: '/ws/a.md', label: 'a.md' })

    expect(strip().activeId).toBe(FILES_TAB_ID)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)
    expect(useStore.getState().openFiles[TAB]?.src).toBe('/ws/a.md')
  })

  it('FR-14/51: an intercepted open changes NOTHING visible, and lights no signal (WB-T22/K07)', () => {
    const web = seedWebActive()
    const before = strip()

    useStore.getState().setOpenFile({ src: '/ws/a.md', label: 'a.md', source: 'intercept' })

    expect(strip()).toBe(before)
    expect(strip().activeId).toBe(web)
    expect(strip().tabs.some((t) => t.unread)).toBe(false)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(false)
    expect(setState).not.toHaveBeenCalled()
    expect(useStore.getState().openFiles[TAB]?.src).toBe('/ws/a.md')
  })

  it('FR-14: the silent agent open never blocks the user’s own (WB-T22 barrier)', () => {
    seedWebActive()
    useStore.getState().setOpenFile({ src: '/ws/a.md', label: 'a.md', source: 'intercept' })

    useStore.getState().setOpenFile({ src: '/ws/a.md', label: 'a.md' })

    expect(strip().activeId).toBe(FILES_TAB_ID)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)
  })
})

describe('setWorkbenchState (§Data Model — the restore report)', () => {
  it('turns the persisted list into a live set exactly once, loading and selecting nothing (WB-P02)', () => {
    useStore.setState({ workbenchOpen: {} })
    useStore
      .getState()
      .setWorkbenchState(TAB, { open: true, tabs: [{ kind: 'web', title: 'A', url: 'u1' }] })
    const first = strip()
    expect(first.tabs.map((t) => t.title)).toEqual(['Files', 'A'])
    expect(first.activeId).toBe(FILES_TAB_ID)
    expect(first.tabs.some((t) => t.unread)).toBe(false)
    expect(useStore.getState().workbenchLoad).toBeNull()
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)

    gesture((prev) => closeTab(prev, first.tabs[1].id))
    useStore
      .getState()
      .setWorkbenchState(TAB, { open: true, tabs: [{ kind: 'web', title: 'A', url: 'u1' }] })
    expect(strip().tabs.map((t) => t.kind)).toEqual(['files'])
  })

  it('a restore is a read, never an echo back to disk', () => {
    useStore
      .getState()
      .setWorkbenchState(TAB, { open: true, tabs: [{ kind: 'web', title: 'A', url: 'u1' }] })
    expect(setState).not.toHaveBeenCalled()
  })

  it('keeps a user-set `open` — a toggle inside the read’s round trip is not reverted by main’s older answer (T-AUX-02b)', () => {
    useStore.setState({ workbenchOpen: { [TAB]: true } })
    useStore.getState().setWorkbenchState(TAB, { open: false, tabs: [] })
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)

    useStore.setState({ workbenchOpen: {} })
    useStore.getState().setWorkbenchState(TAB2, { open: false, tabs: [] })
    expect(useStore.getState().workbenchOpen[TAB2]).toBe(false)
  })

  it('§Data Model: a write carries `open` + the projection, runtime state dropped (WB-P01)', () => {
    useStore
      .getState()
      .setWorkbenchState(TAB, { open: true, tabs: [{ kind: 'web', title: 'A', url: 'u1' }] })

    openWeb('http://localhost:1/b', 'user')

    expect(setState).toHaveBeenLastCalledWith(SID, {
      open: true,
      tabs: [
        { kind: 'web', title: 'A', url: 'u1' },
        { kind: 'web', title: '', url: 'http://localhost:1/b' }
      ]
    })
  })
})

describe('updateWorkbenchTabs writes only when the projection moved (§Data Model, WB-P01)', () => {
  function seed(): string[] {
    useStore.setState({ workbenchOpen: {} })
    useStore.getState().setWorkbenchState(TAB, {
      open: true,
      tabs: [
        { kind: 'web', title: 'A', url: 'u1' },
        { kind: 'web', title: 'B', url: 'u2' }
      ]
    })
    setState.mockClear()
    return strip().tabs.map((t) => t.id)
  }

  it('a pure activation does NOT reach disk', () => {
    const [, a] = seed()

    gesture((prev) => activateTab(prev, a))

    expect(setState).not.toHaveBeenCalled()
    expect(strip().activeId).toBe(a)
  })

  it('an updater that changed nothing leaves the map itself alone', () => {
    const [, a] = seed()
    gesture((prev) => activateTab(prev, a))
    const before = useStore.getState().workbench

    gesture((prev) => activateTab(prev, 'tab-that-closed'))

    expect(useStore.getState().workbench).toBe(before)
    expect(strip().activeId).toBe(a)
  })

  it('a close DOES reach disk', () => {
    const [, a] = seed()

    gesture((prev) => closeTab(prev, a))

    expect(setState).toHaveBeenCalledWith(SID, {
      open: true,
      tabs: [{ kind: 'web', title: 'B', url: 'u2' }]
    })
  })

  it('a reorder DOES reach disk (FR-21, WB-T09)', () => {
    const [, , b] = seed()

    gesture((prev) => moveTab(prev, b, 1))

    expect(setState).toHaveBeenCalledWith(SID, {
      open: true,
      tabs: [
        { kind: 'web', title: 'B', url: 'u2' },
        { kind: 'web', title: 'A', url: 'u1' }
      ]
    })
  })

  it('opening a tab DOES reach disk', () => {
    seed()

    openWeb('http://localhost:1/c', 'user')

    expect(setState).toHaveBeenLastCalledWith(SID, {
      open: true,
      tabs: [
        { kind: 'web', title: 'A', url: 'u1' },
        { kind: 'web', title: 'B', url: 'u2' },
        { kind: 'web', title: '', url: 'http://localhost:1/c' }
      ]
    })
  })

  it('the T1↔T2 toggle submits `open` AND the tabs as one document, so the two never drift apart on disk (FR-06)', () => {
    seed()

    useStore.getState().setWorkbenchOpen(TAB, false)

    expect(setState).toHaveBeenLastCalledWith(SID, {
      open: false,
      tabs: [
        { kind: 'web', title: 'A', url: 'u1' },
        { kind: 'web', title: 'B', url: 'u2' }
      ]
    })
  })
})

describe('an unfetched session is read before anything is written (the data-loss family)', () => {
  const SAVED: SessionWorkbenchState = {
    open: false,
    tabs: [
      { kind: 'web', title: 'A', url: 'http://localhost:1/a' },
      { kind: 'file', title: 'b.md', path: '/ws/b.md' }
    ]
  }

  beforeEach(() => {
    useStore.setState({ workbenchFetched: {}, workbenchOpen: {} })
    disk = { [SID]: SAVED, [SID2]: SAVED }
  })

  it('FR-57 pre-bind: a user file open never writes `tabs: []` — the flag lands on main’s tabs', async () => {
    useStore.setState({
      tabs: [
        {
          id: TAB,
          kind: 'claude',
          host: 'local',
          title: 'S',
          cwd: '/ws',
          alive: true,
          sessionId: SID
        }
      ],
      sessions: []
    })

    useStore.getState().setOpenFile({ src: '/ws/a.md', label: 'a.md' })
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)
    expect(setState).not.toHaveBeenCalled()
    await flush()

    expect(get).toHaveBeenCalledTimes(1)
    expect(setState.mock.calls).toEqual([[SID, { open: true, tabs: SAVED.tabs }]])
    expect(strip().tabs.map((t) => t.kind)).toEqual(['files', 'web', 'file'])
    expect(strip().activeId).toBe(FILES_TAB_ID)
  })

  it('an agent open reads first: the new tab joins the saved ones and `open` stays as saved', async () => {
    openWeb('http://localhost:1/c', 'agent', TAB2)
    expect(strip(TAB2)).toBeUndefined()
    expect(setState).not.toHaveBeenCalled()
    await flush()

    expect(get).toHaveBeenCalledTimes(1)
    expect(setState.mock.calls).toEqual([
      [
        SID2,
        {
          open: false,
          tabs: [...SAVED.tabs, { kind: 'web', title: '', url: 'http://localhost:1/c' }]
        }
      ]
    ])
    expect(useStore.getState().workbenchOpen[TAB2]).toBe(false)
    expect(useStore.getState().workbenchLoad).toBeNull()
    expect(strip(TAB2).tabs.at(-1)?.unread).toBe(true)
  })

  it('a read that fails once is asked again, and the parked gesture still lands on main’s tabs', async () => {
    get.mockRejectedValueOnce(new Error('ipc closed'))
    openWeb('http://localhost:1/c', 'agent', TAB2)
    await flush()

    expect(get).toHaveBeenCalledTimes(2)
    expect(setState.mock.calls).toEqual([
      [
        SID2,
        {
          open: false,
          tabs: [...SAVED.tabs, { kind: 'web', title: '', url: 'http://localhost:1/c' }]
        }
      ]
    ])
    expect(useStore.getState().toast).toBeNull()
  })

  it('a read that fails twice writes nothing and says so — a silent drop and a blind write are both wrong', async () => {
    get
      .mockRejectedValueOnce(new Error('ipc closed'))
      .mockRejectedValueOnce(new Error('ipc closed'))
    openWeb('http://localhost:1/c', 'agent', TAB2)
    await flush()

    expect(get).toHaveBeenCalledTimes(2)
    expect(setState).not.toHaveBeenCalled()
    expect(strip(TAB2)).toBeUndefined()
    expect(useStore.getState().workbenchFetched[TAB2]).toBeUndefined()
    expect(useStore.getState().toast).toMatch(/panel state/)
  })

  it('a user open reads first, then expands: the last write is `open: true` over the saved tabs', async () => {
    openWeb('http://localhost:1/c', 'user', TAB2)
    await flush()

    expect(get).toHaveBeenCalledTimes(1)
    expect(setState).toHaveBeenLastCalledWith(SID2, {
      open: true,
      tabs: [...SAVED.tabs, { kind: 'web', title: '', url: 'http://localhost:1/c' }]
    })
    for (const [, state] of setState.mock.calls) {
      expect(state.tabs.slice(0, SAVED.tabs.length)).toEqual(SAVED.tabs)
    }
    expect(useStore.getState().workbenchLoad?.ownerTabId).toBe(TAB2)
  })

  it('a gesture before the read does not record the session as known-empty', async () => {
    gesture((prev) => activateTab(prev, FILES_TAB_ID), TAB2)
    expect(strip(TAB2)).toBeUndefined()
    expect(useStore.getState().workbenchFetched[TAB2]).toBeUndefined()

    await useStore.getState().ensureWorkbench(TAB2)

    expect(strip(TAB2).tabs.map((t) => t.title)).toEqual(['Files', 'A', 'b.md'])
    expect(get).toHaveBeenCalledTimes(1)
    expect(setState).not.toHaveBeenCalled()
  })

  it('a gesture’s follow-up runs after the parked updater lands, never before', async () => {
    const after = vi.fn(() => strip(TAB2)?.tabs.length)
    useStore.getState().updateWorkbenchTabs(TAB2, (prev) => activateTab(prev, FILES_TAB_ID), after)
    expect(after).not.toHaveBeenCalled()

    void useStore.getState().ensureWorkbench(TAB2)
    await flush()

    expect(after).toHaveBeenCalledTimes(1)
    expect(after.mock.results[0].value).toBe(3)
  })

  it('ensureWorkbench reads once per session — concurrent callers share it, a fetched one is never re-read', async () => {
    const st = useStore.getState()
    await Promise.all([st.ensureWorkbench(TAB), st.ensureWorkbench(TAB)])
    await st.ensureWorkbench(TAB)

    expect(get).toHaveBeenCalledTimes(1)
    expect(useStore.getState().workbenchFetched[TAB]).toBe(true)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(false)
  })

  it('a session main holds nothing for counts as fetched — a new session is not re-read forever', async () => {
    bindThirdTab()
    get.mockResolvedValueOnce(undefined as unknown as SessionWorkbenchState)
    await useStore.getState().ensureWorkbench('pty-3')
    expect(useStore.getState().workbenchFetched['pty-3']).toBe(true)
    expect(strip('pty-3')).toBeUndefined()

    openWeb('http://localhost:1/c', 'agent', 'pty-3')
    expect(get).toHaveBeenCalledTimes(1)
    expect(setState).toHaveBeenCalledTimes(1)
    expect(strip('pty-3').tabs.map((t) => t.kind)).toEqual(['files', 'web'])
  })

  it('an unbound tab is not marked fetched, and its first bind reads once — the read hangs off the bind, not the tab existing (D8/R1)', async () => {
    disk = { 'sess-fresh': { open: true, tabs: [{ kind: 'web', title: 'A', url: 'u1' }] } }
    useStore.setState({
      tabs: [
        { id: 'pty-new', kind: 'claude', host: 'local', title: 'Claude', cwd: '/ws', alive: true }
      ],
      sessions: [],
      activeTabId: 'pty-new',
      workbench: {},
      workbenchFetched: {},
      workbenchOpen: {}
    })

    await useStore.getState().ensureWorkbench('pty-new')
    expect(get).not.toHaveBeenCalled()
    expect(useStore.getState().workbenchFetched['pty-new']).toBeUndefined()

    useStore.getState().setSessions([
      {
        tabId: 'pty-new',
        sessionId: 'sess-fresh',
        alive: true,
        title: 'S',
        cwd: '/ws'
      } as SessionInfo
    ])
    await useStore.getState().ensureWorkbench('pty-new')
    await flush()

    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('sess-fresh')
    expect(useStore.getState().workbenchFetched['pty-new']).toBe(true)
    expect(strip('pty-new').tabs.map((t) => t.kind)).toEqual(['files', 'web'])
    expect(useStore.getState().workbenchOpen['pty-new']).toBe(true)

    await useStore.getState().ensureWorkbench('pty-new')
    expect(get).toHaveBeenCalledTimes(1)
  })

  // CC§1
  it('a link clicked in the TUI before a fresh ⌘N session binds waits, then lands on main’s saved tabs with the gesture’s `open`', async () => {
    disk = { 'sess-fresh': { open: false, tabs: [{ kind: 'web', title: 'A', url: 'u1' }] } }
    useStore.setState({
      tabs: [
        { id: 'pty-new', kind: 'claude', host: 'local', title: 'Claude', cwd: '/ws', alive: true }
      ],
      sessions: [],
      activeTabId: 'pty-new',
      workbench: {},
      workbenchFetched: {},
      workbenchOpen: {}
    })

    openWeb('http://localhost:1/c', 'user', 'pty-new')

    expect(strip('pty-new')).toBeUndefined()
    expect(setState).not.toHaveBeenCalled()

    useStore.getState().setSessions([
      {
        tabId: 'pty-new',
        sessionId: 'sess-fresh',
        alive: true,
        title: 'S',
        cwd: '/ws'
      } as SessionInfo
    ])
    await flush()

    expect(strip('pty-new').tabs.map((t) => t.url)).toEqual([
      undefined,
      'u1',
      'http://localhost:1/c'
    ])
    expect(setState).toHaveBeenLastCalledWith('sess-fresh', {
      open: true,
      tabs: [
        { kind: 'web', title: 'A', url: 'u1' },
        { kind: 'web', title: '', url: 'http://localhost:1/c' }
      ]
    })
  })

  it('a parked gesture is dropped with the tab when the bind never comes', () => {
    useStore.setState({
      tabs: [
        { id: 'pty-new', kind: 'claude', host: 'local', title: 'Claude', cwd: '/ws', alive: true }
      ],
      sessions: [],
      activeTabId: 'pty-new',
      workbench: {},
      workbenchFetched: {}
    })
    openWeb('http://localhost:1/c', 'user', 'pty-new')

    useStore.getState().removeTab('pty-new')
    useStore.getState().setSessions([])

    expect(get).not.toHaveBeenCalled()
    expect(setState).not.toHaveBeenCalled()
    expect(strip('pty-new')).toBeUndefined()
  })
})

describe('openWebPage (FR-11 — an .html file renders in a `web` tab)', () => {
  it('opens remote Claude links in the session’s own Workbench, since a web page needs nothing from the machine', () => {
    useStore.setState({
      tabs: [
        { id: TAB, kind: 'claude', host: 'ssh', title: 'Remote', cwd: 'ssh://host/ws', alive: true }
      ]
    })
    openWebPage('https://example.com')
    expect(openExternal).not.toHaveBeenCalled()
    expect(strip()?.tabs.some((t) => t.url === 'https://example.com')).toBe(true)
  })

  it('opens Codex web links externally without creating a Workbench', () => {
    useStore.setState({
      tabs: [{ id: TAB, kind: 'codex', host: 'local', title: 'Codex', cwd: '/ws', alive: true }]
    })
    openWebPage('https://example.com')
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
    expect(strip()?.tabs.some((t) => t.url === 'https://example.com')).not.toBe(true)
  })

  it('routes a local web page into the session’s strip as a file:// tab (WB-R09)', () => {
    openWebPage('/ws/docs/page.html')

    const set = strip()
    expect(set.tabs.map((t) => t.kind)).toEqual(['files', 'web'])
    expect(set.tabs[1].url).toBe('file:///ws/docs/page.html')
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)
    expect(osOpen).not.toHaveBeenCalled()
  })

  it('carries the FR-56 backlink when the open came from an artifact', () => {
    openWebPage('/ws/docs/page.html', FILES_TAB_ID)

    expect(strip().tabs[1].sourceTabId).toBe(FILES_TAB_ID)
  })

  it('with no session selected the global overlay takes it — never the OS', () => {
    useStore.setState({ tabs: [], sessions: [], activeTabId: null })
    openWebPage('/ws/docs/page.html')

    expect(strip()).toBeUndefined()
    expect(useStore.getState().overlay).toEqual({
      url: 'file:///ws/docs/page.html',
      unread: false,
      open: true
    })
    expect(osOpen).not.toHaveBeenCalled()
  })
})

describe('openCdpTab (§4.1c): the same fetch gate as every other write', () => {
  it('reads main’s saved tabs first on an unfetched session, then adds its own', async () => {
    useStore.setState({ workbenchFetched: {}, workbenchOpen: {} })
    disk = {
      [SID]: { open: false, tabs: [{ kind: 'web', title: 'A', url: 'http://localhost:1/a' }] }
    }

    const tabId = await useStore.getState().openCdpTab(TAB, 'http://localhost:1/b')

    expect(get).toHaveBeenCalledTimes(1)
    expect(strip().tabs.map((t) => t.kind)).toEqual(['files', 'web', 'web'])
    expect(tabId).toBe(strip().tabs[2].id)
  })
})

describe('previewLinkTarget (X-9 — md link resolution)', () => {
  it('leaves an absolute url alone', () => {
    expect(previewLinkTarget('http://example.com/x', '/ws/a.md')).toBe('http://example.com/x')
    expect(previewLinkTarget('mailto:a@b.c', '/ws/a.md')).toBe('mailto:a@b.c')
  })

  it('resolves a relative link against the file it was written in', () => {
    expect(previewLinkTarget('./other.md', '/ws/docs/a.md')).toBe('/ws/docs/other.md')
    expect(previewLinkTarget('other.md', '/ws/docs/a.md')).toBe('/ws/docs/other.md')
    expect(previewLinkTarget('../top.md', '/ws/docs/a.md')).toBe('/ws/top.md')
  })

  it('drops the query and fragment — the result is a path, not a url', () => {
    expect(previewLinkTarget('./other.md#section', '/ws/a.md')).toBe('/ws/other.md')
    expect(previewLinkTarget('./other.md?v=2', '/ws/a.md')).toBe('/ws/other.md')
  })
})

describe('workbenchFull (FR-07 — T3 is global and transient)', () => {
  it('a session switch dissolves it, landing on the target’s own open state (WB-L06)', () => {
    useStore.setState({
      workbenchFull: true,
      tabs: [
        { id: TAB, kind: 'claude', host: 'local', title: 'S', cwd: '/ws', alive: true },
        { id: TAB2, kind: 'claude', host: 'local', title: 'T', cwd: '/ws2', alive: true }
      ]
    })

    useStore.getState().activateTab(TAB2)

    expect(useStore.getState().workbenchFull).toBe(false)
  })
})

describe('a session that goes cold keeps its panel STATE (FR-25/FR-04)', () => {
  it('keeps the cold (still listed, alive: false) session’s strip and open state, and leaves a running one alone (WB-T14)', () => {
    openWeb('http://localhost:1/a', 'user')
    openWeb('http://localhost:1/b', 'user', TAB2)

    useStore
      .getState()
      .setSessions([
        { tabId: TAB, sessionId: SID, alive: false, title: 'S', cwd: '/ws' } as SessionInfo,
        { tabId: TAB2, sessionId: SID2, alive: true, title: 'T', cwd: '/ws' } as SessionInfo
      ])

    expect(strip().tabs.filter((t) => t.kind === 'web')).toHaveLength(1)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)
    expect(useStore.getState().workbenchFetched[TAB]).toBe(true)
    expect(strip(TAB2).tabs.filter((t) => t.kind === 'web')).toHaveLength(1)
  })

  it('a cold session’s markdown link still opens in its own panel, not the OS browser', () => {
    useStore.setState({ sessions: [{ ...boundSession(), alive: false }] })

    openWebPage('/ws/docs/page.html')

    expect(osOpen).not.toHaveBeenCalled()
    expect(strip().tabs.map((t) => t.kind)).toEqual(['files', 'web'])
    expect(strip().tabs[1].url).toBe('file:///ws/docs/page.html')
  })
})

describe('what reaches disk is keyed by the claude session id (D8/R1, R11)', () => {
  it('a write converts the conversation tab to the session it is bound to', () => {
    openWeb('http://localhost:1/a', 'user')

    expect(setState).toHaveBeenLastCalledWith(SID, {
      open: true,
      tabs: [{ kind: 'web', title: '', url: 'http://localhost:1/a' }]
    })
  })

  it('an unbound tab writes nothing at all — there is no key to file it under', () => {
    useStore.setState({
      tabs: [
        { id: 'pty-new', kind: 'claude', host: 'local', title: 'Claude', cwd: '/ws', alive: true }
      ],
      sessions: [],
      activeTabId: 'pty-new',
      workbenchFetched: { 'pty-new': true }
    })

    openWeb('http://localhost:1/a', 'user', 'pty-new')

    expect(strip('pty-new').tabs).toHaveLength(2)
    expect(setState).not.toHaveBeenCalled()
  })

  it('after a /resume the next write lands under the TARGET session id, overwriting what it held, panel untouched (R11)', () => {
    openWeb('http://localhost:1/a', 'user')
    const before = strip()
    setState.mockClear()
    get.mockClear()

    useStore
      .getState()
      .setSessions([
        { tabId: TAB, sessionId: 'sess-target', alive: true, title: 'S', cwd: '/ws' } as SessionInfo
      ])

    expect(strip()).toBe(before)
    expect(get).not.toHaveBeenCalled()

    openWeb('http://localhost:1/b', 'user')

    expect(setState).toHaveBeenLastCalledWith('sess-target', {
      open: true,
      tabs: [
        { kind: 'web', title: '', url: 'http://localhost:1/a' },
        { kind: 'web', title: '', url: 'http://localhost:1/b' }
      ]
    })
    expect(setState.mock.calls.every(([id]) => id !== SID)).toBe(true)
  })

  it('a /clear leaves the panel identical and re-reads nothing', () => {
    openWeb('http://localhost:1/a', 'user')
    const before = strip()
    const openBefore = useStore.getState().workbenchOpen[TAB]
    get.mockClear()

    useStore.getState().setSessions([
      {
        tabId: TAB,
        sessionId: 'sess-cleared',
        alive: true,
        title: 'S',
        cwd: '/ws'
      } as SessionInfo
    ])

    expect(strip()).toBe(before)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(openBefore)
    expect(get).not.toHaveBeenCalled()
  })
})

describe('removeTab clears the tab’s panel state — the tab going away is the only thing that ends its panel (D8/R9)', () => {
  it('drops the strip, the open flag and the fetched marker — and leaves disk alone', () => {
    openWeb('http://localhost:1/a', 'user')
    openWeb('http://localhost:1/b', 'user', TAB2)
    setState.mockClear()

    useStore.getState().removeTab(TAB)

    expect(strip()).toBeUndefined()
    expect(useStore.getState().workbenchOpen[TAB]).toBeUndefined()
    expect(useStore.getState().workbenchFetched[TAB]).toBeUndefined()
    expect(setState).not.toHaveBeenCalled()
    expect(strip(TAB2).tabs.filter((t) => t.kind === 'web')).toHaveLength(1)
  })

  it('frees the tab’s edit buffers, which nothing else ever would', () => {
    const stamp = { mtimeMs: 1, size: 3 }
    beginEdit(TAB, 'wt1', { path: '/ws/a.txt', text: 'abc', eol: 'lf', stamp, readOnly: null })
    beginEdit(TAB2, 'wt1', { path: '/ws/b.txt', text: 'abc', eol: 'lf', stamp, readOnly: null })

    useStore.getState().removeTab(TAB)

    expect(getEntry(TAB, 'wt1')).toBeUndefined()
    expect(getEntry(TAB2, 'wt1')).toBeDefined()
    endEdit(TAB2, 'wt1')
  })

  it('keeps a buffer with unsaved typing, which nothing else holds, for the quit guard’s Save all (claude exiting on its own never asks)', () => {
    const stamp = { mtimeMs: 1, size: 3 }
    beginEdit(TAB, 'wt1', { path: '/ws/a.txt', text: 'abc', eol: 'lf', stamp, readOnly: null })
    setText(TAB, 'wt1', 'abcd')

    useStore.getState().removeTab(TAB)

    expect(allDirtyTabs()).toEqual([{ ownerTabId: TAB, tabId: 'wt1', path: '/ws/a.txt' }])
    endEdit(TAB, 'wt1')
  })

  it('a resume in the same run gets a NEW tab, so it reads main instead of the old strip', async () => {
    openWeb('http://localhost:1/a', 'user')
    useStore.getState().removeTab(TAB)
    disk = { [SID]: { open: false, tabs: [] } }
    get.mockClear()

    useStore.setState((s) => ({
      tabs: [
        ...s.tabs,
        { id: 'pty-resumed', kind: 'claude', host: 'local', title: 'S', cwd: '/ws', alive: true }
      ],
      sessions: [
        ...s.sessions,
        { tabId: 'pty-resumed', sessionId: SID, alive: true, title: 'S', cwd: '/ws' } as SessionInfo
      ]
    }))
    await useStore.getState().ensureWorkbench('pty-resumed')

    expect(get).toHaveBeenCalledWith(SID)
    expect(strip('pty-resumed').tabs.map((t) => t.kind)).toEqual(['files'])
  })
})

describe('sessions without a Workbench (Codex)', () => {
  it.each([{ kind: 'codex' as const, host: 'local' as const, cwd: '/ws' }])(
    '$kind on $host does not create panel state or services through any Workbench entry',
    async ({ kind, host, cwd }) => {
      useStore.setState({
        tabs: [{ id: TAB, kind, host, title: 'S', cwd, alive: true }],
        sessions: [{ ...boundSession(), backendId: kind, host }],
        workbenchOpen: {},
        workbenchFetched: {},
        workbenchFull: false
      })
      const s = useStore.getState()
      await s.ensureWorkbench(TAB)
      s.setWorkbenchOpen(TAB, true)
      s.setWorkbenchFull(true)
      openWeb('https://example.test/', 'agent')
      gesture(
        (prev) => openTab(prev, { url: 'https://example.test/', source: 'user', kind: 'web' }).set
      )
      await flush()
      expect(strip()).toBeUndefined()
      expect(useStore.getState().workbenchOpen[TAB]).toBeUndefined()
      expect(useStore.getState().workbenchFull).toBe(false)
      expect(get).not.toHaveBeenCalled()
      expect(setState).not.toHaveBeenCalled()
    }
  )
})
