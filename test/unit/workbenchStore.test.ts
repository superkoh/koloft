import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { SessionInfo, SessionRow, SessionWorkbenchState, WorkspaceRows } from '@shared/types'
import {
  FILES_TAB_ID,
  activateTab,
  closeTab,
  moveTab,
  openTab,
  type WorkbenchTabSet
} from '../../src/renderer/src/components/workbenchTabs'

/**
 * The renderer's Workbench slice — the store half of the panel, where the
 * three routes into a session's strip meet: the panel's own gestures
 * (`updateWorkbenchTabs`), main's open-request channels (`openWorkbenchTarget`), and the
 * restore/rebuild report (`setWorkbenchState`).
 *
 * `workbenchTabs.test.ts` owns the pure tab algebra. What is pinned here is what the STORE
 * adds on top of it: the source fork's side effects (panel expansion, the FR-57 load
 * intent, the FR-23 toast), the once-only restore, and which changes are allowed to reach
 * disk.
 *
 * The store talks to main through `window.api`; only the handful of channels these
 * transitions touch are stubbed.
 */
const setState = vi.fn()
const osOpen = vi.fn()
const openExternal = vi.fn()
/** what main holds on disk per session — `workbench:get` answers out of this, the way
 *  main resolves a persisted entry (or the global default for a session with none) */
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

/**
 * Issue D8's two layers, and every case below depends on telling them apart:
 * `TAB` / `TAB2` are CONVERSATION TAB ids (pty ids) and key everything the store holds in
 * memory; `SID` / `SID2` are the claude session ids those tabs are bound to, and key
 * everything on disk. The store converts one to the other only at the disk boundary.
 */
const TAB = 'pty-1'
const SID = 'sess-1'
const TAB2 = 'pty-2'
const SID2 = 'sess-2'

/** let every `workbench:get` round trip and the writes queued behind it land */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** a bound, running session on the active tab — what every panel route keys off */
function boundSession(): SessionInfo {
  return { tabId: TAB, sessionId: SID, alive: true, title: 'S', cwd: '/ws' } as SessionInfo
}

/** the second tab's session, so a write for it has a disk key to convert to */
function boundSession2(): SessionInfo {
  return { tabId: TAB2, sessionId: SID2, alive: true, title: 'T', cwd: '/ws' } as SessionInfo
}

/** a third conversation tab, bound, for cases that need one main holds nothing for */
function bindThirdTab(): void {
  useStore.setState((s) => ({
    tabs: [...s.tabs, { id: 'pty-3', kind: 'claude', title: 'U', cwd: '/ws', alive: true }],
    sessions: [
      ...s.sessions,
      { tabId: 'pty-3', sessionId: 'sess-3', alive: true, title: 'U', cwd: '/ws' } as SessionInfo
    ]
  }))
}

/** the tab's live set, after whatever the test just did to it */
function strip(tabId = TAB): ReturnType<typeof useStore.getState>['workbench'][string] {
  return useStore.getState().workbench[tabId]
}

/** the one route both open-request channels take into a tab's strip — the `source`
 *  is the whole fork under test, so it is never defaulted */
function openWeb(url: string, source: 'agent' | 'user', tabId = TAB): void {
  useStore.getState().openWorkbenchTarget(tabId, { url, source })
}

/** …and the panel's own gestures, which mutate the set through the pure model */
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
      { id: TAB, kind: 'claude', title: 'S', cwd: '/ws', alive: true },
      { id: TAB2, kind: 'claude', title: 'T', cwd: '/ws', alive: true }
    ],
    activeTabId: TAB,
    sessions: [boundSession(), boundSession2()],
    openFiles: {},
    workbench: {},
    // Both fixture tabs start FETCHED with nothing held: main has answered and holds
    // no tabs, which is the one state in which an absent strip may be built up from the
    // empty set. The unfetched state — main never asked — is a different thing entirely
    // and gets its own describe below.
    workbenchFetched: { [TAB]: true, [TAB2]: true },
    // T1: every expansion assertion below is a real transition, not a value that was
    // already there
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
    // [files, the new web tab] — `files` is pinned to slot 0 (FR-02)
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
    // url + title stored only, page never loaded: no title of its own yet, and no load intent
    expect(set.tabs[1].url).toBe('http://localhost:1/a')
    expect(set.tabs[1].title).toBe('')
    expect(set.activeId).toBe(FILES_TAB_ID) // no focus steal
    expect(useStore.getState().workbenchOpen[TAB]).toBe(false) // no panel expansion
    expect(useStore.getState().workbenchLoad).toBeNull()
  })

  it('FR-15: a user re-open focuses the existing tab, never a second one (WB-T06)', () => {
    openWeb('http://localhost:1/a?x=1#frag', 'user')
    const first = strip().tabs[1].id
    gesture((prev) => activateTab(prev, FILES_TAB_ID))

    openWeb('http://localhost:1/a?x=1', 'user')

    expect(strip().tabs).toHaveLength(2)
    expect(strip().activeId).toBe(first)
    // the second open is still an intent to look at it, so it re-asks for a load
    expect(useStore.getState().workbenchLoad?.nonce).toBe(2)
  })

  it('FR-15: an agent re-open only re-lights unread and never switches away (WB-T03)', () => {
    openWeb('http://localhost:1/a', 'agent')
    const tabId = strip().tabs[1].id
    // the user looked at it once, which cleared the mark (FR-16), and went back to Files
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
    expect(set.tabs[0].kind).toBe('files') // the pinned tab is exempt by construction
    // named the way the strip names it: an evicted tab was never loaded, so it has no
    // page title of its own
    expect(useStore.getState().toast).toBe(tabEvictedNotice('localhost:1/t1'))
  })

  it('FR-22: the cap counts per kind — eight web tabs never evict a `file` tab (WB-T11)', () => {
    for (let i = 1; i <= 8; i++) {
      openWeb(`http://localhost:1/t${i}`, 'user')
    }
    // a `file` tab is made deliberately (⌘T's picker / ↗ New tab), never by an open request
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

  // FR-10/14 — this route is WEB-ONLY, and that narrowing is itself the requirement: a
  // file target has no tab to make, so it never travels here. It lands in the `files`
  // reading area via `setOpenFile` (covered below), and a `file` TAB is only ever made
  // deliberately inside the panel (⌘T's picker, ↗ New tab). Pinning the shape here is
  // what stops a second, drifting file route from being reintroduced alongside it.
  it('FR-10/14: the open route carries web targets only — a file has no tab to make', () => {
    openWeb('http://localhost:1/a', 'user')
    // every tab this route can produce is a `web` one beside the pinned `files`
    expect(strip().tabs.every((t) => t.kind !== 'file')).toBe(true)
    expect([...new Set(strip().tabs.map((t) => t.kind))].sort()).toEqual(['files', 'web'])
  })
})

// FR-14/57 — the one place the merge CHANGED behavior. Before, an agent-intercepted open
// lit the Eye's unread dot; FR-51 mandates zero signal instead, so `previewUnread` is gone
// and there is nothing left to light. Files an agent opens while the panel is collapsed
// are undiscoverable, and that trade-off is explicitly accepted (FR-14).
describe('setOpenFile (the source fork, FR-14/51/57)', () => {
  /** put a web tab in front, so "activates `files`" is a visible flip and not a no-op */
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

    // the strip is untouched down to the object identity: no activation, and — the
    // behavior change — no unread mark anywhere for the panel to render
    expect(strip()).toBe(before)
    expect(strip().activeId).toBe(web)
    expect(strip().tabs.some((t) => t.unread)).toBe(false)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(false)
    expect(setState).not.toHaveBeenCalled()
    // …but the file itself still reached the tab's reading area
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
  it('turns the persisted list into a live set exactly once', () => {
    // a session the user has not toggled: main's `open` is the only word there is
    useStore.setState({ workbenchOpen: {} })
    useStore
      .getState()
      .setWorkbenchState(TAB, { open: true, tabs: [{ kind: 'web', title: 'A', url: 'u1' }] })
    const first = strip()
    expect(first.tabs.map((t) => t.title)).toEqual(['Files', 'A'])
    // a restore loads nothing and selects nothing (§Data Model / WB-P02): the set lands on
    // `files`, every tab comes back read, and no load is asked for
    expect(first.activeId).toBe(FILES_TAB_ID)
    expect(first.tabs.some((t) => t.unread)).toBe(false)
    expect(useStore.getState().workbenchLoad).toBeNull()
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)

    // a later report must not throw away the strip the user has been working in
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

  // The report is main's answer to a read that was in flight, and the read's round trip is
  // exactly where a user toggle can land first. Main's `open` is then the value from
  // BEFORE the toggle, and taking it would revert the user's newest gesture (T-AUX-02b).
  it('keeps a user-set `open` — a toggle inside the read’s round trip is not reverted', () => {
    useStore.setState({ workbenchOpen: { [TAB]: true } }) // the user expanded meanwhile
    useStore.getState().setWorkbenchState(TAB, { open: false, tabs: [] })
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)

    // …whereas a session nobody has toggled takes main's word for it
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
        // no title yet: the page behind a freshly opened tab has not run (FR-13)
        { kind: 'web', title: '', url: 'http://localhost:1/b' }
      ]
    })
  })
})

// REGRESSION GUARD (fixed): every panel gesture funnels through
// `updateWorkbenchTabs`, and activation/unread/recency are runtime state — a pure
// activation used to submit the whole document, turning every tab switch into a
// layout.json write. That is exactly what §Data Model's "activeId is deliberately absent"
// call forbids, and WB-P01 asserts from the other end (activeId does not survive a
// restart). The choke point compares the PERSISTED PROJECTION, so the guard belongs here
// rather than in each caller.
describe('updateWorkbenchTabs writes only when the projection moved (§Data Model, WB-P01)', () => {
  function seed(): string[] {
    // never toggled, so the restore's `open: true` is what every write below carries
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
    expect(strip().activeId).toBe(a) // barrier: the activation really did happen
  })

  it('an updater that changed nothing leaves the map itself alone', () => {
    const [, a] = seed()
    gesture((prev) => activateTab(prev, a))
    const before = useStore.getState().workbench

    // a tab the strip no longer holds: the pure model hands `prev` straight back
    gesture((prev) => activateTab(prev, 'tab-that-closed'))

    // identity, not equality: a fresh `workbench` map re-renders every consumer selecting
    // on it for a set that did not move
    expect(useStore.getState().workbench).toBe(before)
    expect(strip().activeId).toBe(a) // barrier: the strip really is the one we started with
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

  // `open` and the tab set are ONE document now (they were two channels before the
  // merge), so the T1↔T2 toggle submits both — a write carrying half would let the two
  // drift apart on disk.
  it('the T1↔T2 toggle submits `open` AND the tabs (FR-06)', () => {
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

// The data-loss family (fixed). An id absent from `workbench` used to be read
// as "known empty" by every write path — `?? emptyTabSet()` — so a write for a session
// the renderer had never read landed an EMPTY strip over main's saved tabs. That
// `persistWorkbench` refused to write on an absent strip protected nothing: each caller
// seeded the strip first and walked straight past the refusal. Measured on a store probe
// with disk seeded `{open: false, tabs: [web A, file b.md]}`:
//   pre-bind setOpenFile        → setState(sid, {open: true, tabs: []}), zero reads
//   agent open, unfetched sid   → setState(sid, {open: true, tabs: [the one new tab]})
// Every case below is that probe. The oracle in each is the WRITE, not the strip in
// memory — the strip can look right while disk has already been emptied.
describe('an unfetched session is read before anything is written (the data-loss family)', () => {
  const SAVED: SessionWorkbenchState = {
    open: false,
    tabs: [
      { kind: 'web', title: 'A', url: 'http://localhost:1/a' },
      { kind: 'file', title: 'b.md', path: '/ws/b.md' }
    ]
  }

  beforeEach(() => {
    // nothing read yet, nothing toggled: where every session stands after a reload until
    // the panel's bind-time read lands — and where a background session stays
    useStore.setState({ workbenchFetched: {}, workbenchOpen: {} })
    disk = { [SID]: SAVED, [SID2]: SAVED }
  })

  it('FR-57 pre-bind: a user file open never writes `tabs: []` — the flag lands on main’s tabs', async () => {
    // the pre-bind window of a tab that HAS an anchor — a resume or a ⇧⌘R: the tab
    // carries the session id, the sessions stream has no entry for it yet (the branch
    // `setOpenFile` resolves the id off the tab for). Nothing parks here; the write
    // simply has an id to go out under.
    useStore.setState({
      tabs: [{ id: TAB, kind: 'claude', title: 'S', cwd: '/ws', alive: true, sessionId: SID }],
      sessions: []
    })

    useStore.getState().setOpenFile({ src: '/ws/a.md', label: 'a.md' })
    // the gesture shows at once — the panel expands without waiting on the read…
    expect(useStore.getState().workbenchOpen[TAB]).toBe(true)
    // …but nothing is written on a guess
    expect(setState).not.toHaveBeenCalled()
    await flush()

    expect(get).toHaveBeenCalledTimes(1)
    // ONE write, carrying the saved tabs under the gesture's flag — never an empty strip
    expect(setState.mock.calls).toEqual([[SID, { open: true, tabs: SAVED.tabs }]])
    expect(strip().tabs.map((t) => t.kind)).toEqual(['files', 'web', 'file'])
    expect(strip().activeId).toBe(FILES_TAB_ID)
  })

  it('an agent open reads first: the new tab joins the saved ones and `open` stays as saved', async () => {
    openWeb('http://localhost:1/c', 'agent', TAB2)
    // parked, not seeded: there is no invented strip to write from
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
    // FR-13 held across the read: no expansion, no load, an unread mark only
    expect(useStore.getState().workbenchOpen[TAB2]).toBe(false)
    expect(useStore.getState().workbenchLoad).toBeNull()
    expect(strip(TAB2).tabs.at(-1)?.unread).toBe(true)
  })

  it('a read that fails once is asked again, and the parked gesture still lands on main’s tabs', async () => {
    get.mockRejectedValueOnce(new Error('ipc closed'))
    openWeb('http://localhost:1/c', 'agent', TAB2)
    await flush()

    // the rejection cleared the in-flight read, so the second ask is a real round trip —
    // and the write that follows is built on what main holds, never on a guess
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
    expect(setState).not.toHaveBeenCalled() // the strip on disk stays as main last wrote it
    expect(strip(TAB2)).toBeUndefined() // and nothing was invented in memory either
    expect(useStore.getState().workbenchFetched[TAB2]).toBeUndefined() // the next write asks again
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
    // and no write on the way there carried less than the saved tabs
    for (const [, state] of setState.mock.calls) {
      expect(state.tabs.slice(0, SAVED.tabs.length)).toEqual(SAVED.tabs)
    }
    expect(useStore.getState().workbenchLoad?.ownerTabId).toBe(TAB2)
  })

  it('a gesture before the read does not record the session as known-empty', async () => {
    gesture((prev) => activateTab(prev, FILES_TAB_ID), TAB2)
    // parked rather than applied to an invented strip: still unfetched, still no strip
    expect(strip(TAB2)).toBeUndefined()
    expect(useStore.getState().workbenchFetched[TAB2]).toBeUndefined()

    await useStore.getState().ensureWorkbench(TAB2)

    // the saved tabs come back whole, and the parked gesture shared the one read
    expect(strip(TAB2).tabs.map((t) => t.title)).toEqual(['Files', 'A', 'b.md'])
    expect(get).toHaveBeenCalledTimes(1)
    expect(setState).not.toHaveBeenCalled() // a pure activation, still off the disk
  })

  it('a gesture’s follow-up runs after the parked updater lands, never before', async () => {
    const after = vi.fn(() => strip(TAB2)?.tabs.length)
    useStore.getState().updateWorkbenchTabs(TAB2, (prev) => activateTab(prev, FILES_TAB_ID), after)
    // parked with the updater — the panel would otherwise read a result that is not there
    expect(after).not.toHaveBeenCalled()

    void useStore.getState().ensureWorkbench(TAB2)
    await flush()

    // ran once, and saw the applied strip (main’s three tabs), not an empty one
    expect(after).toHaveBeenCalledTimes(1)
    expect(after.mock.results[0].value).toBe(3)
  })

  it('ensureWorkbench reads once per session — concurrent callers share it, a fetched one is never re-read', async () => {
    const st = useStore.getState()
    await Promise.all([st.ensureWorkbench(TAB), st.ensureWorkbench(TAB)])
    await st.ensureWorkbench(TAB)

    expect(get).toHaveBeenCalledTimes(1)
    expect(useStore.getState().workbenchFetched[TAB]).toBe(true)
    expect(useStore.getState().workbenchOpen[TAB]).toBe(false) // main's word; nobody toggled
  })

  it('a session main holds nothing for counts as fetched — a new session is not re-read forever', async () => {
    bindThirdTab()
    get.mockResolvedValueOnce(undefined as unknown as SessionWorkbenchState)
    await useStore.getState().ensureWorkbench('pty-3')
    expect(useStore.getState().workbenchFetched['pty-3']).toBe(true)
    expect(strip('pty-3')).toBeUndefined()

    // past the gate the empty set is legitimate — main said that is what it holds
    openWeb('http://localhost:1/c', 'agent', 'pty-3')
    expect(get).toHaveBeenCalledTimes(1)
    expect(setState).toHaveBeenCalledTimes(1)
    expect(strip('pty-3').tabs.map((t) => t.kind)).toEqual(['files', 'web'])
  })

  /**
   * D8/R1 — the read happens at the tab's FIRST BIND, and the trigger is "this tab has a
   * bound session id and has not been read", never "this tab exists".
   *
   * REGRESSION GUARD, measured on the built app: a conversation tab exists a beat before
   * its claude session binds, so an unbound tab that counted as read-and-empty latched
   * `workbenchFetched` in that beat — and the bind that followed never asked main
   * anything. Every fresh session came up with no panel at all (WB-T02 saw zero
   * `.wb-tab`s, BB-M10 waited out 25s for `.wb-panel`), and a resumed session would have
   * lost its saved tabs the same way. The oracle here is the READ: whether main was asked,
   * and exactly once.
   */
  it('an unbound tab is not marked fetched, and its first bind reads once', async () => {
    disk = { 'sess-fresh': { open: true, tabs: [{ kind: 'web', title: 'A', url: 'u1' }] } }
    useStore.setState({
      tabs: [{ id: 'pty-new', kind: 'claude', title: 'Claude', cwd: '/ws', alive: true }],
      sessions: [],
      activeTabId: 'pty-new',
      workbench: {},
      workbenchFetched: {},
      workbenchOpen: {}
    })

    // before the bind: nothing to read by, and nothing latched that would stop the read
    await useStore.getState().ensureWorkbench('pty-new')
    expect(get).not.toHaveBeenCalled()
    expect(useStore.getState().workbenchFetched['pty-new']).toBeUndefined()

    // …the session binds, which is the signal the read hangs off
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
    // main's document landed whole — this is what the regression threw away
    expect(strip('pty-new').tabs.map((t) => t.kind)).toEqual(['files', 'web'])
    expect(useStore.getState().workbenchOpen['pty-new']).toBe(true)

    // …and it is never asked twice
    await useStore.getState().ensureWorkbench('pty-new')
    expect(get).toHaveBeenCalledTimes(1)
  })

  // The other half of the same rule: a gesture made in the pre-bind window may neither be
  // dropped nor run against an invented empty strip. It waits, and lands ON TOP of what
  // main holds — while the flag the gesture set still outranks main's own `open`.
  //
  // The window this models is narrower than "any pre-bind", and worth naming because the
  // obvious candidate is not it: a ⇧⌘R or a resume writes the tab's own anchor, so
  // `boundSessionId` answers for those from the first frame and nothing ever parks. What
  // has no anchor at all is a brand-new ⌘N tab in the seconds between its pty starting and
  // Claude Code's SessionStart hook firing — and claude prints its login and onboarding
  // links in exactly those seconds. Clicking one is `termLinks` → `openWebPage` → here,
  // which is the `openWeb(…, 'user', …)` below.
  it('a link clicked in the TUI before the session binds waits, then lands on main’s saved tabs', async () => {
    disk = { 'sess-fresh': { open: false, tabs: [{ kind: 'web', title: 'A', url: 'u1' }] } }
    useStore.setState({
      tabs: [{ id: 'pty-new', kind: 'claude', title: 'Claude', cwd: '/ws', alive: true }],
      sessions: [],
      activeTabId: 'pty-new',
      workbench: {},
      workbenchFetched: {},
      workbenchOpen: {}
    })

    openWeb('http://localhost:1/c', 'user', 'pty-new')

    // parked, not applied: no invented strip, and nothing written on a guess
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

    // the saved tab came back AND the parked open landed after it
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
      tabs: [{ id: 'pty-new', kind: 'claude', title: 'Claude', cwd: '/ws', alive: true }],
      sessions: [],
      activeTabId: 'pty-new',
      workbench: {},
      workbenchFetched: {}
    })
    openWeb('http://localhost:1/c', 'user', 'pty-new')

    useStore.getState().removeTab('pty-new')
    // a later tab could reuse neither the id nor the gesture; the queue must not outlive
    // the tab and fire against whatever comes next
    useStore.getState().setSessions([])

    expect(get).not.toHaveBeenCalled()
    expect(setState).not.toHaveBeenCalled()
    expect(strip('pty-new')).toBeUndefined()
  })
})

describe('openWebPage (FR-11 — an .html file renders in a `web` tab)', () => {
  it('keeps remote Claude links in the existing session web-tab route', () => {
    useStore.setState({
      tabs: [{ id: TAB, kind: 'claude', title: 'Remote', cwd: 'ssh://host/ws', alive: true }]
    })
    openWebPage('https://example.com')
    expect(strip().tabs.at(-1)?.url).toBe('https://example.com')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens Codex web links externally without creating a Workbench', () => {
    useStore.setState({
      tabs: [{ id: TAB, kind: 'codex', title: 'Codex', cwd: '/ws', alive: true }]
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

  // "no session SELECTED" — the only state left with nowhere in-app to put the page.
  // (A dead session is never the selected one — its tab closes with its pty, T-LIFE-05.)
  //
  // R1 rewrote this case: it used to assert the page reached the OS. The
  // click is the user's own, so the overlay shows it at once and nothing leaves Koloft —
  // the old assertion is retired.
  it('with no session selected the global overlay takes it — never the OS', () => {
    // D8: "no session selected" is a fact about the TAB — the welcome screen, or a plain
    // shell tab. A live session list is not what decides it.
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

/**
 * §4.1c — `Target.createTarget`, the store half: it goes through the same
 * fetch gate every other write does (a client can drive a background session whose strip
 * the panel has never read). What the page looks like (background, unread, two pages are
 * two tabs) and D5's refusal are e2e's — BB-34/35 and BB-38/39.
 */
describe('openCdpTab', () => {
  // D8: the client names a session, the caller (App) converts it to that session's
  // conversation tab, and THAT is what arrives here — the same id every other write uses.
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
        { id: TAB, kind: 'claude', title: 'S', cwd: '/ws', alive: true },
        { id: TAB2, kind: 'claude', title: 'T', cwd: '/ws2', alive: true }
      ]
    })

    useStore.getState().activateTab(TAB2)

    expect(useStore.getState().workbenchFull).toBe(false)
  })
})

describe('a session that goes cold keeps its panel STATE (FR-25/FR-04)', () => {
  // A cold row has nothing on screen (its tab closed with its pty), but its strip is
  // what the resume comes back to — the same one main persisted. So going cold drops
  // no entry; only the guests die (at the mount site, via `liveSessions`). (WB-T14)
  //
  // Cold is `alive: false` while the session is STILL LISTED, which is the shape main
  // pushes for it (`tracker.setAlive(id, false)` on the pty's exit keeps the entry). This
  // case used to model it by dropping the row from the push entirely — the shape of an
  // EVICTION, whose opposite verdict the describe below now pins — so it passed for the
  // wrong reason and would have gone on passing had cold and evicted been swapped.
  it('keeps the cold session’s strip and open state, and leaves a running one alone', () => {
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

  // The other half of FR-25's "still readable": a markdown link inside a cold session's
  // file tab. `openWebPage` used to require `alive`, so the only session state that can
  // still SHOW a link had no in-panel route for it — every click left for the OS browser
  // with nothing on screen to say why (G0). `panelSid` dropped the same clause; this is it.
  it('a cold session’s markdown link still opens in its own panel, not the OS browser', () => {
    useStore.setState({ sessions: [{ ...boundSession(), alive: false }] })

    openWebPage('/ws/docs/page.html')

    expect(osOpen).not.toHaveBeenCalled()
    expect(strip().tabs.map((t) => t.kind)).toEqual(['files', 'web'])
    expect(strip().tabs[1].url).toBe('file:///ws/docs/page.html')
  })
})

/**
 * Issue D8/R1 — the disk half of the two-layer key. Everything above works in
 * conversation-tab ids; this is the one boundary where they turn back into claude session
 * ids, and the three ways that conversion can go wrong are all silent: writing under the
 * old id (the panel comes back stale), writing under no id at all (a lost panel), and
 * re-reading on an id change (the pages reload, which is the whole bug D8 exists to kill).
 */
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
      tabs: [{ id: 'pty-new', kind: 'claude', title: 'Claude', cwd: '/ws', alive: true }],
      sessions: [],
      activeTabId: 'pty-new',
      workbenchFetched: { 'pty-new': true }
    })

    openWeb('http://localhost:1/a', 'user', 'pty-new')

    expect(strip('pty-new').tabs).toHaveLength(2) // the gesture landed on screen…
    expect(setState).not.toHaveBeenCalled() // …and stopped at the disk boundary
  })

  // R11, accepted by default: after an in-TUI `/resume` the tab is bound to the TARGET
  // session, so the next write goes there and overwrites whatever that id held. The panel
  // itself does not move, does not reload and is not re-read — nothing about it is a
  // function of the session id any more.
  it('after a /resume the next write lands under the TARGET session id, panel untouched', () => {
    openWeb('http://localhost:1/a', 'user')
    const before = strip()
    setState.mockClear()
    get.mockClear()

    // the tracker reports the same tab bound to a different session (an in-TUI /resume)
    useStore
      .getState()
      .setSessions([
        { tabId: TAB, sessionId: 'sess-target', alive: true, title: 'S', cwd: '/ws' } as SessionInfo
      ])

    // the panel is the same object: no rebuild, no re-read, no reload
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
    // and nothing was written under the id it left behind
    expect(setState.mock.calls.every(([id]) => id !== SID)).toBe(true)
  })

  // The same shape for `/clear`, from the renderer's side: main moves the entry on disk,
  // the renderer does nothing whatsoever.
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

/**
 * D8/R9 — the tab going away is what ends its panel, and the ONLY thing that does. The
 * rows-driven eviction this replaces (FR-29/D13) could not survive a tab-keyed panel: a
 * `/clear` retires a session id while the tab and its panel carry straight on, so a sweep
 * keyed on ownership would have taken a panel the user is looking at.
 */
describe('removeTab clears the tab’s panel state (D8/R9)', () => {
  it('drops the strip, the open flag and the fetched marker — and leaves disk alone', () => {
    openWeb('http://localhost:1/a', 'user')
    openWeb('http://localhost:1/b', 'user', TAB2)
    setState.mockClear()

    useStore.getState().removeTab(TAB)

    expect(strip()).toBeUndefined()
    expect(useStore.getState().workbenchOpen[TAB]).toBeUndefined()
    expect(useStore.getState().workbenchFetched[TAB]).toBeUndefined()
    // nothing was written on the way out: what main holds under `sess-1` is what a later
    // resume comes back to
    expect(setState).not.toHaveBeenCalled()
    // …and the other tab is untouched
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

  // claude exiting on its own closes the tab without ever asking about unsaved work, and
  // this map holds the only copy of it — the quit guard's "Save all" is what still writes
  // it out. Every close the USER drives saves before it gets here.
  it('keeps a buffer with unsaved typing, which nothing else holds', () => {
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

    // the resume lands on a fresh pty bound to the same conversation
    useStore.setState((s) => ({
      tabs: [...s.tabs, { id: 'pty-resumed', kind: 'claude', title: 'S', cwd: '/ws', alive: true }],
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

describe('Codex optional capabilities', () => {
  it('does not create panel state or services through any Workbench entry', async () => {
    useStore.setState({
      tabs: [{ id: TAB, kind: 'codex', title: 'Codex', cwd: '/ws', alive: true }],
      sessions: [{ ...boundSession(), backendId: 'codex' }],
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
  })
})
