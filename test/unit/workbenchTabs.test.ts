import { describe, it, expect } from 'vitest'
import {
  FILES_TAB_ID,
  KIND_TAB_CAP,
  activateTab,
  cdpVisibleTabs,
  closeTab,
  cycleTab,
  dialogHasLiveOwner,
  emptyTabSet,
  fileLabels,
  liveWebTabs,
  moveTab,
  navigateTab,
  openTab,
  persistTabs,
  restoreTabSet,
  retargetOrOpenTab,
  retargetTab,
  retitleTab,
  setTabView,
  cwdFallbackNotice,
  shortAuxCwd,
  tabLabel,
  type WorkbenchTabSet
} from '../../src/renderer/src/components/workbenchTabs'

function webTabs(n: number, base = 'http://localhost:5173/t'): WorkbenchTabSet {
  let set = emptyTabSet()
  for (let i = 1; i <= n; i++) {
    set = openTab(set, { kind: 'web', url: `${base}${i}`, source: 'user' }).set
  }
  return set
}

function fileTabs(paths: string[]): WorkbenchTabSet {
  let set = emptyTabSet()
  for (const path of paths) set = openTab(set, { kind: 'file', path, source: 'user' }).set
  return set
}

const ids = (set: WorkbenchTabSet): string[] => set.tabs.map((t) => t.id)
const kinds = (set: WorkbenchTabSet): string[] => set.tabs.map((t) => t.kind)
const urls = (set: WorkbenchTabSet): (string | undefined)[] =>
  set.tabs.filter((t) => t.kind === 'web').map((t) => t.url)
const paths = (set: WorkbenchTabSet): (string | undefined)[] =>
  set.tabs.filter((t) => t.kind === 'file').map((t) => t.path)
const labels = (set: WorkbenchTabSet): string[] =>
  set.tabs.filter((t) => t.kind === 'file').map((t) => tabLabel(set, t))

describe('the pinned files tab (FR-02, FR-18, FR-21)', () => {
  it('FR-02: an empty set is exactly the files tab, active and in slot 0', () => {
    const set = emptyTabSet()
    expect(set.tabs).toHaveLength(1)
    expect(set.tabs[0]).toEqual({ id: FILES_TAB_ID, kind: 'files', title: 'Files', unread: false })
    expect(set.activeId).toBe(FILES_TAB_ID)
    expect(set.recency).toEqual([FILES_TAB_ID])
  })

  it('FR-02: stays in slot 0 however many tabs open on top of it', () => {
    let set = webTabs(3)
    set = openTab(set, { kind: 'file', path: '/ws/a.ts', source: 'user' }).set
    expect(set.tabs[0].id).toBe(FILES_TAB_ID)
    expect(kinds(set)).toEqual(['files', 'web', 'web', 'web', 'file'])
  })

  it('FR-18/WB-T01: ⌘W on files is a no-op — the set comes back untouched', () => {
    const set = webTabs(2)
    expect(closeTab(set, FILES_TAB_ID)).toBe(set)
    expect(closeTab(emptyTabSet(), FILES_TAB_ID).tabs).toHaveLength(1)
  })

  it('FR-21/WB-T01: files cannot be dragged out of slot 0', () => {
    const set = webTabs(2)
    expect(moveTab(set, FILES_TAB_ID, 1)).toBe(set)
    expect(moveTab(set, FILES_TAB_ID, 2)).toBe(set)
  })

  it('FR-21: files cannot be displaced either — a drop on slot 0 clamps to slot 1', () => {
    const set = webTabs(2)
    const [, a, b] = set.tabs
    expect(ids(moveTab(set, b.id, 0))).toEqual([FILES_TAB_ID, b.id, a.id])
    expect(moveTab(set, a.id, 0)).toBe(set)
    expect(moveTab(set, a.id, -5)).toBe(set)
  })

  it('FR-21: an ordinary reorder still works, and a drop past the end clamps to it', () => {
    const set = webTabs(3)
    const [, a, b, c] = set.tabs
    expect(ids(moveTab(set, c.id, 1))).toEqual([FILES_TAB_ID, c.id, a.id, b.id])
    expect(ids(moveTab(set, a.id, 99))).toEqual([FILES_TAB_ID, b.id, c.id, a.id])
    expect(moveTab(set, c.id, 1).tabs[1]).toBe(c)
    expect(moveTab(set, c.id, 1).activeId).toBe(set.activeId)
  })

  it('FR-21: never loses or duplicates a tab, at any drop index', () => {
    const set = webTabs(3)
    for (const to of [-5, 0, 1, 2, 3, 99]) {
      const moved = moveTab(set, set.tabs[1].id, to)
      expect(moved.tabs).toHaveLength(4)
      expect(new Set(moved.tabs.map((t) => t.id)).size).toBe(4)
      expect(moved.tabs[0].id).toBe(FILES_TAB_ID)
    }
  })

  it('FR-21: ignores a tab id the set does not have', () => {
    const set = webTabs(2)
    expect(moveTab(set, 'nope', 1)).toBe(set)
  })
})

describe('opening a target that already has a tab (FR-15)', () => {
  it('WB-T06: a user open of a live url activates the existing tab, creating nothing', () => {
    let set = webTabs(2)
    set = activateTab(set, FILES_TAB_ID)

    const r = openTab(set, { kind: 'web', url: 'http://localhost:5173/t2', source: 'user' })

    expect(r.created).toBe(false)
    expect(r.set.tabs).toHaveLength(3)
    expect(r.tabId).toBe(set.tabs[2].id)
    expect(r.set.activeId).toBe(set.tabs[2].id)
  })

  it('WB-T03: an agent open of the same url only re-lights unread, never switching away', () => {
    let set = webTabs(2)
    set = activateTab(set, FILES_TAB_ID)

    const r = openTab(set, { kind: 'web', url: 'http://localhost:5173/t2', source: 'agent' })

    expect(r.created).toBe(false)
    expect(r.set.tabs).toHaveLength(3)
    expect(r.set.activeId).toBe(FILES_TAB_ID)
    expect(r.set.tabs[2].unread).toBe(true)
    expect(r.set.tabs[1].unread).toBe(false)
  })

  it('an agent re-open of the ACTIVE tab lights no dot — the user is already looking at it', () => {
    const set = webTabs(2)
    const r = openTab(set, { kind: 'web', url: 'http://localhost:5173/t2', source: 'agent' })

    expect(r.created).toBe(false)
    expect(r.tabId).toBe(set.activeId)
    expect(r.set).toBe(set)
    expect(r.set.tabs.every((t) => !t.unread)).toBe(true)
  })

  it('routes url dedup through dedupKey — trailing slash and query order are one tab', () => {
    let set = openTab(emptyTabSet(), {
      kind: 'web',
      url: 'http://localhost/docs?a=1&b=2',
      source: 'user'
    }).set
    for (const variant of [
      'http://localhost/docs/?a=1&b=2',
      'http://LOCALHOST:80/docs?a=1&b=2',
      'http://localhost/docs?b=2&a=1',
      'http://localhost/docs?a=1&b=2#section'
    ]) {
      set = openTab(set, { kind: 'web', url: variant, source: 'user' }).set
    }
    expect(set.tabs).toHaveLength(2)
  })

  it('dedups a file on its EXACT path — no normalization of any kind', () => {
    const set = fileTabs(['/ws/src/a.ts'])
    expect(openTab(set, { kind: 'file', path: '/ws/src/a.ts', source: 'user' }).created).toBe(false)
    for (const variant of ['/ws/src/a.ts/', '/ws/src/A.ts', '/ws//src/a.ts']) {
      expect(openTab(set, { kind: 'file', path: variant, source: 'user' }).created).toBe(true)
    }
  })

  it('never deduplicates a file against a web tab that happens to carry the same string', () => {
    const set = openTab(emptyTabSet(), { kind: 'web', url: '/ws/a.ts', source: 'user' }).set
    const r = openTab(set, { kind: 'file', path: '/ws/a.ts', source: 'user' })
    expect(r.created).toBe(true)
    expect(kinds(r.set)).toEqual(['files', 'web', 'file'])
  })

  it('FR-34: a user re-open carries a fresh anchor line onto the tab it found', () => {
    const set = openTab(emptyTabSet(), {
      kind: 'file',
      path: '/ws/a.ts',
      source: 'user',
      line: 12
    }).set
    const r = openTab(set, { kind: 'file', path: '/ws/a.ts', source: 'user', line: 40 })
    expect(r.created).toBe(false)
    expect(r.set.tabs[1].line).toBe(40)
    expect(
      openTab(r.set, { kind: 'file', path: '/ws/a.ts', source: 'user' }).set.tabs[1].line
    ).toBe(40)
  })

  it('a blank web tab has no dedup key — two ＋ presses are two tabs', () => {
    let set = openTab(emptyTabSet(), { kind: 'web', url: '', source: 'user' }).set
    set = openTab(set, { kind: 'web', url: '', source: 'user' }).set
    expect(set.tabs).toHaveLength(3)
    expect(urls(set)).toEqual(['', ''])
  })
})

describe('an agent open never takes the active tab (FR-13, FR-15)', () => {
  it('WB-T02: appends a background tab carrying the unread dot', () => {
    let set = webTabs(1)
    const active = set.activeId
    set = openTab(set, { kind: 'web', url: 'http://x.test/new', source: 'agent' }).set

    expect(set.tabs).toHaveLength(3)
    expect(set.tabs[2].unread).toBe(true)
    expect(set.activeId).toBe(active)
  })

  it('leaves the pinned tab active when the panel has nothing else open', () => {
    const r = openTab(emptyTabSet(), { kind: 'web', url: 'http://x.test/a', source: 'agent' })
    expect(r.created).toBe(true)
    expect(r.set.activeId).toBe(FILES_TAB_ID)
  })

  it('a user open, by contrast, always becomes the active tab', () => {
    const r = openTab(emptyTabSet(), { kind: 'web', url: 'http://x.test/a', source: 'user' })
    expect(r.set.activeId).toBe(r.tabId)
    expect(r.set.tabs[1].unread).toBe(false)
  })
})

describe('a cold session answers only ownerless dialogs', () => {
  const owners: Record<number, string> = { 7: 'tab-A', 9: 'tab-B' }
  const ownerOf = (gid: number): string | undefined => owners[gid]
  const live = new Set(['tab-B'])

  it('a background session’s guest keeps its dialog — that session is still live', () => {
    expect(dialogHasLiveOwner({ guestId: 9 }, ownerOf, live)).toBe(true)
  })

  it('the cold session’s own guest has no one left to answer', () => {
    expect(dialogHasLiveOwner({ guestId: 7 }, ownerOf, live)).toBe(false)
  })

  it('a guest no tab can name, and an auth challenge with no guest, are ownerless too', () => {
    expect(dialogHasLiveOwner({ guestId: 42 }, ownerOf, live)).toBe(false)
    expect(dialogHasLiveOwner({}, ownerOf, live)).toBe(false)
  })
})

describe('the unread mark clears on activation and nowhere else (FR-16)', () => {
  function withUnread(): { set: WorkbenchTabSet; unreadId: string } {
    const r = openTab(emptyTabSet(), { kind: 'web', url: 'http://x.test/a', source: 'agent' })
    return { set: r.set, unreadId: r.tabId }
  }

  it('WB-T04: activating the tab clears its dot and makes it current', () => {
    const { set, unreadId } = withUnread()
    const next = activateTab(set, unreadId)
    expect(next.tabs[1].unread).toBe(false)
    expect(next.activeId).toBe(unreadId)
  })

  it('WB-T05: clears only the activated tab, leaving its siblings marked', () => {
    let set = openTab(emptyTabSet(), { kind: 'web', url: 'http://x.test/a', source: 'agent' }).set
    const second = openTab(set, { kind: 'web', url: 'http://x.test/b', source: 'agent' })
    set = activateTab(second.set, second.tabId)
    expect(set.tabs[1].unread).toBe(true)
    expect(set.tabs[2].unread).toBe(false)
  })

  it('survives every other mutation of the set', () => {
    const { set, unreadId } = withUnread()
    const other = openTab(set, { kind: 'file', path: '/ws/x.ts', source: 'user' })
    const stillUnread = (s: WorkbenchTabSet): boolean =>
      s.tabs.find((t) => t.id === unreadId)!.unread
    expect(stillUnread(navigateTab(set, unreadId, 'http://x.test/moved'))).toBe(true)
    expect(stillUnread(retitleTab(set, unreadId, 'Page'))).toBe(true)
    expect(stillUnread(setTabView(set, unreadId, 'source'))).toBe(true)
    expect(stillUnread(moveTab(set, unreadId, 1))).toBe(true)
    expect(stillUnread(other.set)).toBe(true)
    expect(stillUnread(closeTab(other.set, other.tabId))).toBe(true)
  })

  it('ignores an activation of a tab the set no longer has', () => {
    const set = webTabs(2)
    expect(activateTab(set, 'gone')).toBe(set)
  })
})

describe('the per-kind tab cap (FR-22, FR-23)', () => {
  it('allows exactly KIND_TAB_CAP tabs of a kind, plus the pinned one', () => {
    const set = webTabs(KIND_TAB_CAP)
    expect(set.tabs).toHaveLength(KIND_TAB_CAP + 1)
    expect(urls(set)).toHaveLength(8)
  })

  it('WB-T10: evicts the least recently viewed non-current tab and reports it', () => {
    const set = webTabs(KIND_TAB_CAP)
    const r = openTab(set, { kind: 'web', url: 'http://localhost:5173/t9', source: 'user' })

    expect(r.evicted?.url).toBe('http://localhost:5173/t1')
    expect(urls(r.set)).toHaveLength(8)
    expect(urls(r.set)).not.toContain('http://localhost:5173/t1')
    expect(urls(r.set)).toContain('http://localhost:5173/t9')
  })

  it('WB-T10: the victim is the least recently VIEWED, not the first created', () => {
    let set = webTabs(KIND_TAB_CAP)
    set = activateTab(set, set.tabs[1].id)
    set = activateTab(set, set.tabs[KIND_TAB_CAP].id)

    const r = openTab(set, { kind: 'web', url: 'http://localhost:5173/t9', source: 'user' })

    expect(r.evicted?.url).toBe('http://localhost:5173/t2')
    expect(urls(r.set)).toContain('http://localhost:5173/t1')
  })

  it('FR-23: the evicted tab comes back whole, so the toast can name it', () => {
    let set = webTabs(KIND_TAB_CAP)
    set = retitleTab(set, set.tabs[1].id, 'Doomed Page')

    const r = openTab(set, { kind: 'web', url: 'http://localhost:5173/t9', source: 'user' })

    expect(r.evicted).toMatchObject({
      id: set.tabs[1].id,
      kind: 'web',
      title: 'Doomed Page',
      url: 'http://localhost:5173/t1'
    })
    expect(r.set.tabs.some((t) => t.id === r.evicted!.id)).toBe(false)
    expect(r.set.recency).not.toContain(r.evicted!.id)
  })

  it('WB-T10: never evicts the current tab', () => {
    let set = webTabs(KIND_TAB_CAP)
    const current = set.tabs[1]
    set = activateTab(set, current.id)

    const r = openTab(set, { kind: 'web', url: 'http://localhost:5173/t9', source: 'agent' })

    expect(r.evicted?.id).not.toBe(current.id)
    expect(r.set.tabs.some((t) => t.id === current.id)).toBe(true)
    expect(r.set.activeId).toBe(current.id)
  })

  it('WB-T12: a tab never activated participates by creation order', () => {
    let set = emptyTabSet()
    for (let i = 1; i <= KIND_TAB_CAP; i++) {
      set = openTab(set, { kind: 'web', url: `http://x.test/a${i}`, source: 'agent' }).set
    }
    expect(set.activeId).toBe(FILES_TAB_ID)

    const r = openTab(set, { kind: 'web', url: 'http://x.test/a9', source: 'agent' })
    expect(r.evicted?.url).toBe('http://x.test/a1')
  })

  it('WB-T11: the two kinds count separately — 8 web tabs never evict a file tab', () => {
    let set = webTabs(KIND_TAB_CAP)
    const file = openTab(set, { kind: 'file', path: '/ws/keep.ts', source: 'user' })
    expect(file.evicted).toBeNull()
    set = file.set
    expect(set.tabs).toHaveLength(KIND_TAB_CAP + 2)

    const ninthWeb = openTab(set, { kind: 'web', url: 'http://localhost:5173/t9', source: 'user' })
    expect(ninthWeb.evicted?.kind).toBe('web')
    expect(paths(ninthWeb.set)).toEqual(['/ws/keep.ts'])
  })

  it('WB-T11: and the same in reverse — 8 file tabs never evict a web tab', () => {
    let set = fileTabs(Array.from({ length: KIND_TAB_CAP }, (_, i) => `/ws/f${i + 1}.ts`))
    const web = openTab(set, { kind: 'web', url: 'http://x.test/keep', source: 'user' })
    expect(web.evicted).toBeNull()
    set = web.set

    const ninthFile = openTab(set, { kind: 'file', path: '/ws/f9.ts', source: 'user' })
    expect(ninthFile.evicted?.path).toBe('/ws/f1.ts')
    expect(paths(ninthFile.set)).not.toContain('/ws/f1.ts')
    expect(urls(ninthFile.set)).toEqual(['http://x.test/keep'])
  })

  it('FR-02: the pinned tab is never a victim, however long the flood runs', () => {
    let set = emptyTabSet()
    for (let i = 1; i <= 30; i++) {
      set = openTab(set, { kind: 'web', url: `http://x.test/f${i}`, source: 'agent' }).set
      set = openTab(set, { kind: 'file', path: `/ws/f${i}.ts`, source: 'agent' }).set
    }
    expect(set.tabs[0].id).toBe(FILES_TAB_ID)
    expect(urls(set)).toHaveLength(KIND_TAB_CAP)
    expect(paths(set)).toHaveLength(KIND_TAB_CAP)
  })

  it('FR-23: reports no eviction while the kind is still under the cap', () => {
    const r = openTab(webTabs(KIND_TAB_CAP - 1), {
      kind: 'web',
      url: 'http://x.test/last',
      source: 'user'
    })
    expect(r.evicted).toBeNull()
    expect(r.created).toBe(true)
  })

  it('FR-23: a dedup hit is not an open, so it never evicts', () => {
    const set = webTabs(KIND_TAB_CAP)
    const r = openTab(set, { kind: 'web', url: 'http://localhost:5173/t1', source: 'user' })
    expect(r.evicted).toBeNull()
    expect(urls(r.set)).toHaveLength(8)
  })
})

describe('closing a tab (FR-19)', () => {
  it('WB-T07: activates the right-hand neighbour', () => {
    let set = webTabs(3)
    set = activateTab(set, set.tabs[2].id)
    const next = closeTab(set, set.tabs[2].id)
    expect(next.tabs).toHaveLength(3)
    expect(next.activeId).toBe(set.tabs[3].id)
  })

  it('WB-T07: falls back to the left when the last tab closes', () => {
    let set = webTabs(3)
    set = activateTab(set, set.tabs[3].id)
    expect(closeTab(set, set.tabs[3].id).activeId).toBe(set.tabs[2].id)
  })

  it('falls back to files when the only other tab closes', () => {
    const set = webTabs(1)
    const next = closeTab(set, set.tabs[1].id)
    expect(next.tabs).toHaveLength(1)
    expect(next.activeId).toBe(FILES_TAB_ID)
  })

  it('WB-T08: closing a background tab leaves the active tab alone', () => {
    let set = webTabs(3)
    set = activateTab(set, set.tabs[3].id)
    const next = closeTab(set, set.tabs[1].id)
    expect(next.activeId).toBe(set.tabs[3].id)
    expect(next.tabs).toHaveLength(3)
  })

  it('drops the closed tab from recency, so it cannot be evicted twice', () => {
    const set = webTabs(3)
    const next = closeTab(set, set.tabs[2].id)
    expect(next.recency).not.toContain(set.tabs[2].id)
    expect(next.recency).toHaveLength(3)
  })

  it('ignores a tab id the set does not have', () => {
    const set = webTabs(2)
    expect(closeTab(set, 'gone')).toBe(set)
  })
})

describe('the ← Back to source backlink (FR-56)', () => {
  it('WB-R10: closing the source tab clears the backlink on every tab pointing at it', () => {
    const source = openTab(emptyTabSet(), { kind: 'file', path: '/ws/page.html', source: 'user' })
    let set = source.set
    const a = openTab(set, {
      kind: 'web',
      url: 'file:///ws/page.html',
      source: 'user',
      sourceTabId: source.tabId
    })
    const b = openTab(a.set, {
      kind: 'web',
      url: 'file:///ws/other.html',
      source: 'user',
      sourceTabId: source.tabId
    })
    set = b.set
    expect(set.tabs.filter((t) => t.sourceTabId === source.tabId)).toHaveLength(2)

    const next = closeTab(set, source.tabId)
    expect(next.tabs.some((t) => t.sourceTabId !== undefined)).toBe(false)
  })

  it('WB-R10: a directly created web tab carries no backlink at all', () => {
    const r = openTab(emptyTabSet(), { kind: 'web', url: 'http://x.test/a', source: 'user' })
    expect(r.set.tabs[1].sourceTabId).toBeUndefined()
  })

  it('leaves an unrelated tab’s backlink intact when a different tab closes', () => {
    const source = openTab(emptyTabSet(), { kind: 'file', path: '/ws/page.html', source: 'user' })
    const linked = openTab(source.set, {
      kind: 'web',
      url: 'file:///ws/page.html',
      source: 'user',
      sourceTabId: source.tabId
    })
    const spare = openTab(linked.set, { kind: 'web', url: 'http://x.test/z', source: 'user' })

    const next = closeTab(spare.set, spare.tabId)
    expect(next.tabs.find((t) => t.id === linked.tabId)!.sourceTabId).toBe(source.tabId)
  })

  it('keeps a backlink to files alive — the pinned source can never close', () => {
    const r = openTab(emptyTabSet(), {
      kind: 'web',
      url: 'file:///ws/page.html',
      source: 'user',
      sourceTabId: FILES_TAB_ID
    })
    expect(closeTab(r.set, FILES_TAB_ID).tabs[1].sourceTabId).toBe(FILES_TAB_ID)
  })
})

describe('retargetTab (FR-34)', () => {
  it('moves the tab to the new path and anchor, dropping its title and view', () => {
    let set = fileTabs(['/ws/a.ts'])
    const id = set.tabs[1].id
    set = retitleTab(setTabView(set, id, 'source'), id, 'a.ts')

    const next = retargetTab(set, id, '/ws/b.ts', 12)

    expect(next.tabs[1]).toMatchObject({ id, kind: 'file', path: '/ws/b.ts', line: 12, title: '' })
    expect(next.tabs[1].view).toBeUndefined()
  })

  it('clears the anchor when the reference carries none', () => {
    const set = openTab(emptyTabSet(), {
      kind: 'file',
      path: '/ws/a.ts',
      source: 'user',
      line: 7
    }).set
    expect(retargetTab(set, set.tabs[1].id, '/ws/b.ts').tabs[1].line).toBeUndefined()
  })

  it('keeps the id, the unread mark and the FR-56 backlink, and touches no other tab', () => {
    const source = openTab(emptyTabSet(), { kind: 'file', path: '/ws/src.md', source: 'user' })
    const r = openTab(source.set, {
      kind: 'file',
      path: '/ws/a.ts',
      source: 'agent',
      sourceTabId: source.tabId
    })

    const next = retargetTab(r.set, r.tabId, '/ws/b.ts')

    const moved = next.tabs.find((t) => t.id === r.tabId)!
    expect(moved.unread).toBe(true)
    expect(moved.sourceTabId).toBe(source.tabId)
    expect(next.tabs[0]).toBe(r.set.tabs[0])
    expect(next.tabs[1]).toBe(r.set.tabs[1])
    expect(next.activeId).toBe(r.set.activeId)
    expect(next.recency).toEqual(r.set.recency)
  })

  it('never folds into a tab already on the target path — FR-34 is "same tab"', () => {
    const set = fileTabs(['/ws/a.ts', '/ws/b.ts'])
    const next = retargetTab(set, set.tabs[1].id, '/ws/b.ts')
    expect(next.tabs).toHaveLength(3)
    expect(paths(next)).toEqual(['/ws/b.ts', '/ws/b.ts'])
  })

  it('ignores a tab id the set does not have', () => {
    const set = fileTabs(['/ws/a.ts'])
    expect(retargetTab(set, 'gone', '/ws/b.ts').tabs).toEqual(set.tabs)
  })
})

describe('cycleTab (FR-53)', () => {
  it('WB-K03: walks right from files through the strip and wraps back to it', () => {
    const set = webTabs(2)
    const [files, a, b] = set.tabs
    expect(cycleTab(set, 1).activeId).toBe(files.id)
    expect(cycleTab(cycleTab(set, 1), 1).activeId).toBe(a.id)
    expect(cycleTab(activateTab(set, files.id), 1).activeId).toBe(a.id)
    expect(cycleTab(activateTab(set, a.id), 1).activeId).toBe(b.id)
  })

  it('WB-K03: walks left with the same wrap', () => {
    const set = webTabs(2)
    const [files, a, b] = set.tabs
    expect(cycleTab(activateTab(set, files.id), -1).activeId).toBe(b.id)
    expect(cycleTab(activateTab(set, b.id), -1).activeId).toBe(a.id)
    expect(cycleTab(activateTab(set, a.id), -1).activeId).toBe(files.id)
  })

  it('follows the strip order after a drag, not creation order', () => {
    const set = webTabs(2)
    const reordered = moveTab(set, set.tabs[2].id, 1)
    const walked = cycleTab(activateTab(reordered, FILES_TAB_ID), 1)
    expect(walked.activeId).toBe(set.tabs[2].id)
  })

  it('FR-16: cycling ONTO an unread tab clears it, like any activation', () => {
    const r = openTab(emptyTabSet(), { kind: 'web', url: 'http://x.test/a', source: 'agent' })
    expect(cycleTab(r.set, 1).tabs[1].unread).toBe(false)
  })

  it('is a no-op when files is the only tab', () => {
    const set = emptyTabSet()
    expect(cycleTab(set, 1)).toBe(set)
    expect(cycleTab(set, -1)).toBe(set)
  })
})

describe('the web tab label (FR-27)', () => {
  const label = (url: string, title = ''): string => {
    const r = openTab(emptyTabSet(), { kind: 'web', url, source: 'user', title })
    return tabLabel(r.set, r.set.tabs[1])
  }

  it('takes the page title once the guest has reported one', () => {
    expect(label('http://x.test/pricing', 'Acme · Pricing')).toBe('Acme · Pricing')
  })

  it('derives host + last segment while the tab has no title', () => {
    expect(label('http://localhost:5173/pricing')).toBe('localhost:5173/pricing')
    expect(label('http://x.test/a/b/c.html')).toBe('x.test/c.html')
  })

  it('tells two pages of the same host apart', () => {
    expect(label('http://127.0.0.1:5173/a')).not.toBe(label('http://127.0.0.1:5173/b'))
  })

  it('keeps the host alone for a site root', () => {
    expect(label('http://localhost:5173/')).toBe('localhost:5173')
    expect(label('http://localhost:5173')).toBe('localhost:5173')
  })

  it('names the file for a file:// url, which has no host to fall back on', () => {
    expect(label('file:///Users/koloft/ws/docs/page.html')).toBe('page.html')
    expect(label('file:///Users/koloft/ws/docs/')).toBe('docs')
  })

  it('reads New tab for a tab with no url at all, about:blank included', () => {
    expect(label('')).toBe('New tab')
    expect(label('about:blank')).toBe('New tab')
  })

  it('never leaves New tab on a tab that has been sent somewhere', () => {
    const r = openTab(emptyTabSet(), { kind: 'web', url: '', source: 'user' })
    const sent = navigateTab(r.set, r.tabId, 'http://localhost:5173/b')
    expect(tabLabel(sent, sent.tabs[1])).toBe('localhost:5173/b')
  })

  it('ellipsizes at 40 characters so a hostile url cannot flood the strip', () => {
    const long = label(`http://x.test/deep/${'x'.repeat(60)}.html`)
    expect(long).toHaveLength(40)
    expect(long.endsWith('…')).toBe(true)
    expect(long.startsWith('x.test/')).toBe(true)
  })

  it('drops query, hash and intermediate path depth rather than truncating them away', () => {
    expect(label(`http://x.test/${'seg/'.repeat(20)}page.html?a=1#top`)).toBe('x.test/page.html')
  })

  it('falls back to the raw target when it is not a url at all', () => {
    expect(label('not a url')).toBe('not a url')
  })

  it('always reads Files on the pinned tab', () => {
    const set = webTabs(1)
    expect(tabLabel(set, set.tabs[0])).toBe('Files')
  })
})

describe('file tab labels disambiguate by parent directory (FR-27)', () => {
  it('leaves a lone file bare, however deep it sits', () => {
    expect(labels(fileTabs(['/ws/src/very/deep/nested/config.ts']))).toEqual(['config.ts'])
  })

  it('WB-T19: two same-named files each grow one parent, and the first is relabelled', () => {
    const one = fileTabs(['/ws/a/config.ts'])
    expect(labels(one)).toEqual(['config.ts'])

    const two = openTab(one, { kind: 'file', path: '/ws/b/config.ts', source: 'user' }).set
    expect(labels(two)).toEqual(['a/config.ts', 'b/config.ts'])
  })

  it('grows only as far as it needs to — a third file stops at one parent as well', () => {
    const set = fileTabs(['/ws/a/config.ts', '/ws/b/config.ts', '/ws/x/y/config.ts'])
    expect(labels(set)).toEqual(['a/config.ts', 'b/config.ts', 'y/config.ts'])
  })

  it('goes deeper only for the tabs still colliding at the current depth', () => {
    const set = fileTabs(['/ws/a/y/config.ts', '/ws/b/y/config.ts', '/ws/c/index.ts'])
    expect(labels(set)).toEqual(['a/y/config.ts', 'b/y/config.ts', 'index.ts'])
  })

  it('never grows a tab that is already unambiguous', () => {
    const set = fileTabs(['/ws/a/config.ts', '/ws/b/config.ts', '/ws/a/main.ts'])
    expect(labels(set)).toEqual(['a/config.ts', 'b/config.ts', 'main.ts'])
  })

  it('stops rather than loops when a path has run out of parents', () => {
    const set = fileTabs(['/config.ts', 'config.ts'])
    expect(labels(set)).toEqual(['config.ts', 'config.ts'])
  })

  it('grows the other side when only one of the two still has parents', () => {
    const set = fileTabs(['config.ts', '/ws/a/config.ts'])
    expect(labels(set)).toEqual(['config.ts', 'a/config.ts'])
  })

  it('scopes uniqueness to file tabs — a web tab with a lookalike url changes nothing', () => {
    let set = fileTabs(['/ws/a/config.ts'])
    set = openTab(set, { kind: 'web', url: 'file:///ws/b/config.ts', source: 'user' }).set
    expect(labels(set)).toEqual(['config.ts'])
  })

  it('keys the map by tab id and covers exactly the file tabs with a path', () => {
    const set = fileTabs(['/ws/a/config.ts', '/ws/b/config.ts'])
    const map = fileLabels(set)
    expect(Object.keys(map).sort()).toEqual(
      set.tabs
        .slice(1)
        .map((t) => t.id)
        .sort()
    )
    expect(map[FILES_TAB_ID]).toBeUndefined()
  })
})

describe('liveWebTabs (FR-24)', () => {
  it('keeps every web tab live while the set is under the limit', () => {
    const set = webTabs(3)
    expect(liveWebTabs(set, 5).size).toBe(3)
  })

  it('freezes the least recently viewed once over the limit', () => {
    let set = webTabs(3)
    set = activateTab(set, set.tabs[1].id)
    const live = liveWebTabs(set, 2)
    expect(live.has(set.tabs[1].id)).toBe(true)
    expect(live.has(set.tabs[3].id)).toBe(true)
    expect(live.has(set.tabs[2].id)).toBe(false)
  })

  it('WB-T13: the active tab stays live at a limit of one, newer arrivals notwithstanding', () => {
    let set = webTabs(2)
    const watching = set.activeId
    set = openTab(set, { kind: 'web', url: 'http://x.test/agent', source: 'agent' }).set
    expect(set.recency[set.recency.length - 1]).not.toBe(watching)
    expect([...liveWebTabs(set, 1)]).toEqual([watching])
  })

  it('treats a limit of zero or less as one — never a fully blank panel', () => {
    const set = webTabs(3)
    expect(liveWebTabs(set, 0).size).toBe(1)
    expect(liveWebTabs(set, -4).size).toBe(1)
  })

  it('counts only web tabs — files and file tabs hold no guest', () => {
    let set = webTabs(2)
    set = openTab(set, { kind: 'file', path: '/ws/a.ts', source: 'user' }).set
    const live = liveWebTabs(set, 8)
    expect(live.size).toBe(2)
    expect(live.has(FILES_TAB_ID)).toBe(false)
    expect([...live].every((id) => set.tabs.find((t) => t.id === id)!.kind === 'web')).toBe(true)
  })

  it('ranks by recency when the active tab is not a web tab at all', () => {
    let set = webTabs(3)
    set = activateTab(set, FILES_TAB_ID)
    expect([...liveWebTabs(set, 1)]).toEqual([set.tabs[3].id])
  })

  it('is empty for a set that has no web tab', () => {
    expect(liveWebTabs(fileTabs(['/ws/a.ts']), 4).size).toBe(0)
  })
})

describe('persistence round-trip (WB-P01)', () => {
  function mixedSet(): WorkbenchTabSet {
    const a = openTab(emptyTabSet(), { kind: 'web', url: 'http://x.test/a', source: 'agent' })
    const b = openTab(a.set, {
      kind: 'file',
      path: '/ws/src/b.ts',
      source: 'user',
      view: 'source',
      sourceTabId: a.tabId,
      line: 42
    })
    return retitleTab(b.set, a.tabId, 'Page A')
  }

  it('persists kind / order / url / path / view, and nothing else', () => {
    expect(persistTabs(mixedSet())).toEqual([
      { kind: 'web', title: 'Page A', url: 'http://x.test/a' },
      { kind: 'file', title: '', path: '/ws/src/b.ts', view: 'source' }
    ])
  })

  it('FR-02: never writes the pinned tab — it is implied, not stored', () => {
    expect(persistTabs(emptyTabSet())).toEqual([])
    expect(persistTabs(mixedSet()).some((t) => (t.kind as string) === 'files')).toBe(false)
  })

  it('WB-P01: comes back in the same order with files pinned back in front', () => {
    const set = restoreTabSet(persistTabs(mixedSet()))
    expect(kinds(set)).toEqual(['files', 'web', 'file'])
    expect(set.tabs[1].url).toBe('http://x.test/a')
    expect(set.tabs[1].title).toBe('Page A')
    expect(set.tabs[2].path).toBe('/ws/src/b.ts')
    expect(set.tabs[2].view).toBe('source')
  })

  it('WB-P01: lands on files with every unread mark and backlink gone', () => {
    const set = restoreTabSet(persistTabs(mixedSet()))
    expect(set.activeId).toBe(FILES_TAB_ID)
    expect(set.tabs.some((t) => t.unread)).toBe(false)
    expect(set.tabs.some((t) => t.sourceTabId !== undefined)).toBe(false)
    expect(set.tabs.some((t) => t.line !== undefined)).toBe(false)
    expect(set.recency).toEqual(ids(set))
  })

  it('keeps a restored tab’s runtime fields off the other kind', () => {
    const set = restoreTabSet(persistTabs(mixedSet()))
    expect(set.tabs[1].path).toBeUndefined()
    expect(set.tabs[1].view).toBeUndefined()
    expect(set.tabs[2].url).toBeUndefined()
  })

  it('restores an empty document as the bare pinned tab', () => {
    const set = restoreTabSet([])
    expect(set.tabs).toHaveLength(1)
    expect(set.activeId).toBe(FILES_TAB_ID)
  })

  it('gives every restored tab its own id, across sets', () => {
    const a = restoreTabSet([{ kind: 'web', title: 'A', url: 'http://x.test/a' }])
    const b = restoreTabSet([{ kind: 'web', title: 'A', url: 'http://x.test/a' }])
    expect(a.tabs[1].id).not.toBe(b.tabs[1].id)
  })

  it('FR-22: truncates per kind at the cap a ＋ could actually have built', () => {
    const web = Array.from({ length: KIND_TAB_CAP + 4 }, (_, i) => ({
      kind: 'web' as const,
      title: `W${i}`,
      url: `http://x.test/${i}`
    }))
    const files = Array.from({ length: KIND_TAB_CAP + 4 }, (_, i) => ({
      kind: 'file' as const,
      title: `F${i}`,
      path: `/ws/f${i}.ts`
    }))
    const set = restoreTabSet([...web, ...files])
    expect(urls(set)).toHaveLength(KIND_TAB_CAP)
    expect(paths(set)).toHaveLength(KIND_TAB_CAP)
    expect(urls(set)).toEqual(web.slice(0, KIND_TAB_CAP).map((t) => t.url))
    expect(paths(set)).toEqual(files.slice(0, KIND_TAB_CAP).map((t) => t.path))
  })

  it('drops an entry whose kind is not one of the two persisted ones', () => {
    const set = restoreTabSet([
      { kind: 'files', title: 'Files' } as never,
      { kind: 'web', title: 'A', url: 'http://x.test/a' }
    ])
    expect(kinds(set)).toEqual(['files', 'web'])
  })
})

describe('a CDP-source tab (§4.1c/D5): not an `open`, and a driven tab is not the cap’s to close', () => {
  it('is never deduped — two calls on one url are two tabs', () => {
    const first = openTab(emptyTabSet(), {
      kind: 'web',
      url: 'http://localhost/a',
      source: 'cdp'
    }).set
    const r = openTab(first, { kind: 'web', url: 'http://localhost/a', source: 'cdp' })

    expect(r.created).toBe(true)
    expect(urls(r.set)).toEqual(['http://localhost/a', 'http://localhost/a'])
  })

  it('lands in the background with an unread mark, like an agent’s (D3)', () => {
    const before = webTabs(1)
    const set = openTab(before, { kind: 'web', url: 'http://localhost/x', source: 'cdp' }).set

    expect(set.activeId).toBe(before.activeId)
    expect(set.tabs[set.tabs.length - 1].unread).toBe(true)
  })

  it('leaves a user open’s dedup alone — the two sources do not share the rule', () => {
    const set = openTab(emptyTabSet(), {
      kind: 'web',
      url: 'http://localhost/a',
      source: 'cdp'
    }).set
    const r = openTab(set, { kind: 'web', url: 'http://localhost/a', source: 'user' })
    expect(r.created).toBe(false)
    expect(urls(r.set)).toEqual(['http://localhost/a'])
  })

  it('the cap skips a pinned tab and takes the next victim instead', () => {
    const set = webTabs(KIND_TAB_CAP)
    const web = set.tabs.filter((t) => t.kind === 'web')
    const oldest = web[0].id
    const nextOldest = web[1].id

    const r = openTab(set, {
      kind: 'web',
      url: 'http://localhost/new',
      source: 'cdp',
      pinned: new Set([oldest])
    })

    expect(r.evicted?.id).toBe(nextOldest)
    expect(r.set.tabs.some((t) => t.id === oldest)).toBe(true)
  })

  it('refuses rather than close a pinned tab when every candidate is pinned', () => {
    const set = webTabs(KIND_TAB_CAP)
    const all = new Set(set.tabs.filter((t) => t.kind === 'web').map((t) => t.id))

    const r = openTab(set, { kind: 'web', url: 'http://localhost/new', source: 'cdp', pinned: all })

    expect(r.refused).toBe('tab-cap')
    expect(r.created).toBe(false)
    expect(r.evicted).toBeNull()
    expect(r.set).toBe(set)
  })

  it('a USER open still gets its tab when the cap is full of pinned ones — an agent’s grip never tells the user no', () => {
    const set = webTabs(KIND_TAB_CAP)
    const all = new Set(set.tabs.filter((t) => t.kind === 'web').map((t) => t.id))

    const r = openTab(set, {
      kind: 'web',
      url: 'http://localhost/new',
      source: 'user',
      pinned: all
    })

    expect(r.refused).toBeUndefined()
    expect(r.created).toBe(true)
    expect(r.evicted).not.toBeNull()
  })

  it('a driven tab (D5) and a dirty tab (B-27) are both stepped over — the two exemptions compose', () => {
    const set = webTabs(KIND_TAB_CAP)
    const web = set.tabs.filter((t) => t.kind === 'web')
    const [oldest, nextOldest, third] = web.map((t) => t.id)

    const r = openTab(set, {
      kind: 'web',
      url: 'http://localhost/new',
      source: 'cdp',
      pinned: new Set([oldest]),
      isDirty: (id) => id === nextOldest
    })

    expect(r.evicted?.id).toBe(third)
    expect(r.set.tabs.some((t) => t.id === oldest)).toBe(true)
    expect(r.set.tabs.some((t) => t.id === nextOldest)).toBe(true)
  })
})

describe('tabs with unsaved changes (B-27, B-28)', () => {
  const fileIds = (set: WorkbenchTabSet): string[] =>
    set.tabs.filter((t) => t.kind === 'file').map((t) => t.id)

  const fullFileStrip = (): WorkbenchTabSet =>
    fileTabs(Array.from({ length: KIND_TAB_CAP }, (_, i) => `/ws/f${i + 1}.ts`))

  it('picks the same victim as before when nothing is dirty', () => {
    const set = webTabs(KIND_TAB_CAP)
    const r = openTab(set, {
      kind: 'web',
      url: 'http://localhost:5173/t9',
      source: 'user',
      isDirty: () => false
    })
    expect(r.evicted?.url).toBe('http://localhost:5173/t1')
    expect(r.refused).toBeUndefined()
  })

  it('B-27: skips a dirty tab and evicts the next least recently viewed', () => {
    const set = fullFileStrip()
    const oldest = fileIds(set)[0]

    const r = openTab(set, {
      kind: 'file',
      path: '/ws/f9.ts',
      source: 'user',
      isDirty: (id) => id === oldest
    })

    expect(r.evicted?.path).toBe('/ws/f2.ts')
    expect(paths(r.set)).toContain('/ws/f1.ts')
    expect(paths(r.set)).toContain('/ws/f9.ts')
  })

  it('B-27: refuses the open outright when every candidate is dirty', () => {
    const set = fullFileStrip()

    const r = openTab(set, { kind: 'file', path: '/ws/f9.ts', source: 'user', isDirty: () => true })

    expect(r.refused).toBe('all-dirty')
    expect(r.created).toBe(false)
    expect(r.tabId).toBe('')
    expect(r.evicted).toBeNull()
    expect(r.set).toBe(set)
  })

  it('B-27: an agent open is refused the same way, since it may not steal the current tab', () => {
    let set = fullFileStrip()
    set = activateTab(set, FILES_TAB_ID)

    const r = openTab(set, {
      kind: 'file',
      path: '/ws/f9.ts',
      source: 'agent',
      isDirty: () => true
    })

    expect(r.refused).toBe('all-dirty')
    expect(r.set.activeId).toBe(FILES_TAB_ID)
    expect(paths(r.set)).not.toContain('/ws/f9.ts')
  })

  it('B-27: a dedup hit is not an open, so a full strip of dirty tabs still focuses it', () => {
    const set = fullFileStrip()

    const r = openTab(set, { kind: 'file', path: '/ws/f3.ts', source: 'user', isDirty: () => true })

    expect(r.refused).toBeUndefined()
    expect(r.created).toBe(false)
    expect(r.set.activeId).toBe(fileIds(set)[2])
  })

  it('B-27: the other kind is unaffected — 8 dirty file tabs do not refuse a web open', () => {
    const set = fullFileStrip()

    const r = openTab(set, {
      kind: 'web',
      url: 'http://x.test/a',
      source: 'user',
      isDirty: () => true
    })

    expect(r.refused).toBeUndefined()
    expect(r.created).toBe(true)
  })

  it('B-28: a clean tab still retargets in place', () => {
    const set = fileTabs(['/ws/a.ts'])
    const id = set.tabs[1].id

    const r = retargetOrOpenTab(set, id, '/ws/b.ts', 12, () => false)

    expect(r.openedNew).toBe(false)
    expect(r.tabId).toBe(id)
    expect(r.set.tabs).toHaveLength(2)
    expect(r.set.tabs[1]).toMatchObject({ id, path: '/ws/b.ts', line: 12 })
  })

  it('B-28: with no dirty check at all it behaves exactly like retargetTab', () => {
    const set = fileTabs(['/ws/a.ts'])
    const id = set.tabs[1].id

    const r = retargetOrOpenTab(set, id, '/ws/b.ts', 12)

    expect(r.openedNew).toBe(false)
    expect(r.set).toEqual(retargetTab(set, id, '/ws/b.ts', 12))
  })

  it('B-28: a dirty tab opens a new tab instead, keeping its own text where it is', () => {
    const set = fileTabs(['/ws/a.ts'])
    const id = set.tabs[1].id

    const r = retargetOrOpenTab(set, id, '/ws/b.ts', 12, (t) => t === id)

    expect(r.openedNew).toBe(true)
    expect(r.tabId).not.toBe(id)
    expect(paths(r.set)).toEqual(['/ws/a.ts', '/ws/b.ts'])
    expect(r.set.tabs[1]).toBe(set.tabs[1])
    expect(r.set.activeId).toBe(r.tabId)
    expect(r.set.tabs.find((t) => t.id === r.tabId)).toMatchObject({ path: '/ws/b.ts', line: 12 })
  })

  it('B-28: a dirty tab whose target is already open focuses that tab rather than a third', () => {
    const set = fileTabs(['/ws/a.ts', '/ws/b.ts'])
    const id = set.tabs[1].id

    const r = retargetOrOpenTab(set, id, '/ws/b.ts', undefined, (t) => t === id)

    expect(r.openedNew).toBe(true)
    expect(r.tabId).toBe(set.tabs[2].id)
    expect(paths(r.set)).toEqual(['/ws/a.ts', '/ws/b.ts'])
  })

  it('B-28: the open it falls back to obeys B-27 and can be refused', () => {
    const set = fullFileStrip()

    const r = retargetOrOpenTab(set, set.tabs[1].id, '/ws/f9.ts', undefined, () => true)

    expect(r.refused).toBe('all-dirty')
    expect(r.openedNew).toBe(false)
    expect(r.set).toBe(set)
  })
})

function withShells(n: number): WorkbenchTabSet {
  let set = emptyTabSet()
  for (let i = 1; i <= n; i++) {
    set = openTab(set, {
      kind: 'terminal',
      id: `pty${i}`,
      cwd: '/w',
      title: 'zsh',
      source: 'user'
    }).set
  }
  return set
}

describe('a terminal tab (R2/R19)', () => {
  it('takes the pty id as its own id, so every report about that shell finds it', () => {
    const r = openTab(emptyTabSet(), {
      kind: 'terminal',
      id: 'pty-77',
      cwd: '/w',
      title: 'zsh',
      source: 'user'
    })
    expect(r.created).toBe(true)
    expect(r.tabId).toBe('pty-77')
    expect(r.set.tabs.map((t) => t.id)).toEqual([FILES_TAB_ID, 'pty-77'])
    expect(r.set.activeId).toBe('pty-77')
    expect(r.set.tabs[1].cwd).toBe('/w')
  })

  it('is never deduped — two shells in one directory are two tabs, not one', () => {
    const set = withShells(2)
    expect(set.tabs.filter((t) => t.kind === 'terminal')).toHaveLength(2)
  })

  it('lands at the RIGHT end, and a later web tab goes in FRONT of it', () => {
    const withTerm = withShells(1)
    const after = openTab(withTerm, { kind: 'web', url: 'http://h/p', source: 'user' }).set
    expect(after.tabs.map((t) => t.kind)).toEqual(['files', 'web', 'terminal'])
  })

  it('refuses the ninth instead of evicting one of the eight, which could kill a running shell (R2)', () => {
    const full = withShells(KIND_TAB_CAP)
    const r = openTab(full, {
      kind: 'terminal',
      id: 'pty9',
      cwd: '/w',
      title: 'zsh',
      source: 'user'
    })
    expect(r.refused).toBe('cap')
    expect(r.created).toBe(false)
    expect(r.evicted).toBeNull()
    expect(r.set).toBe(full)
    expect(r.set.tabs.filter((t) => t.kind === 'terminal')).toHaveLength(KIND_TAB_CAP)
  })

  it('takes no part in drag ordering, in either direction', () => {
    let set = openTab(emptyTabSet(), { kind: 'web', url: 'http://h/a', source: 'user' }).set
    set = openTab(set, {
      kind: 'terminal',
      id: 'pty1',
      cwd: '/w',
      title: 'zsh',
      source: 'user'
    }).set
    set = openTab(set, { kind: 'web', url: 'http://h/b', source: 'user' }).set
    expect(set.tabs.map((t) => t.kind)).toEqual(['files', 'web', 'web', 'terminal'])
    expect(moveTab(set, 'pty1', 1)).toBe(set)
    const moved = moveTab(set, set.tabs[1].id, 9)
    expect(moved.tabs.map((t) => t.kind)).toEqual(['files', 'web', 'web', 'terminal'])
    expect(moved.tabs[3].id).toBe('pty1')
  })

  it('labels itself with its title alone (R19), never with its directory', () => {
    const set = retitleTab(withShells(1), 'pty1', 'node')
    expect(tabLabel(set, set.tabs[1])).toBe('node')
  })

  it('is never written to disk — a shell opening or closing is not a layout change', () => {
    const set = openTab(withShells(3), { kind: 'web', url: 'http://h/p', source: 'user' }).set
    expect(persistTabs(set)).toEqual([{ kind: 'web', title: '', url: 'http://h/p' }])
  })
})

describe('a terminal tab’s cwd label (R19)', () => {
  it('keeps the last two segments of a deep path, marked as elided', () => {
    expect(shortAuxCwd('/Users/me/Projects/app/.claude/worktrees/bugfix')).toBe(
      '…/worktrees/bugfix'
    )
  })

  it('shows a two-segment path whole', () => {
    expect(shortAuxCwd('/tmp/koloft')).toBe('/tmp/koloft')
  })

  it('shows a one-segment path whole', () => {
    expect(shortAuxCwd('/tmp')).toBe('/tmp')
  })

  it('ignores a trailing slash', () => {
    expect(shortAuxCwd('/Users/me/Projects/app/')).toBe('…/Projects/app')
  })

  it('has nothing to show for an empty cwd', () => {
    expect(shortAuxCwd('')).toBe('')
  })
})

describe('the vanished-root notice (R4): the only sign a shell opened somewhere other than its vanished root', () => {
  it('names where the shell actually landed', () => {
    expect(cwdFallbackNotice('/Users/me/Projects/app')).toBe(
      'Folder is gone — terminal opened in …/Projects/app'
    )
  })

  it('elides a deep fallback the same way the kind bar does', () => {
    expect(cwdFallbackNotice('/Users/me/Projects/app/.claude/worktrees/bugfix')).toContain(
      '…/worktrees/bugfix'
    )
  })
})

describe('what a CDP client is shown', () => {
  it('lists only the web tabs the agent opened — never one the user opened or one restored from disk', () => {
    let set = openTab(emptyTabSet(), {
      kind: 'web',
      url: 'file:///tmp/mine.html',
      source: 'user'
    }).set
    set = openTab(set, { kind: 'web', url: 'http://localhost:8000/a', source: 'agent' }).set
    set = openTab(set, { kind: 'web', url: 'http://localhost:8000/b', source: 'cdp' }).set
    expect(cdpVisibleTabs(set).map((t) => t.url)).toEqual([
      'http://localhost:8000/a',
      'http://localhost:8000/b'
    ])

    const restored = restoreTabSet(persistTabs(set))
    expect(cdpVisibleTabs(restored)).toEqual([])
  })

  it('an agent open that lands on a tab the user already has keeps that tab the user’s', () => {
    let set = openTab(emptyTabSet(), {
      kind: 'web',
      url: 'http://localhost:8000/a',
      source: 'user'
    }).set
    set = openTab(set, { kind: 'web', url: 'http://localhost:8000/a', source: 'agent' }).set
    expect(cdpVisibleTabs(set)).toEqual([])
  })
})
