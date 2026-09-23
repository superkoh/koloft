import { describe, it, expect } from 'vitest'
import { PERSISTED_TAB_CAP, sanitizeTab, sanitizeSessionWorkbench } from '@shared/workbenchState'

/**
 * The Workbench's persisted-state boundary. Three callers share it — the
 * v2→v3 migration, the `workbench.setState` write path and the read path — so anything a
 * hand-edited layout.json can hold has to be decided exactly once, here.
 *
 * The rule under test is per-item repair, never wholesale rejection (§6/hand-edited
 * layout.json, WB-P04): one dirty entry drops and the rest of the panel still restores.
 */

describe('sanitizeTab — one tab, repaired or dropped', () => {
  it('keeps a well-formed web tab as {kind,title,url} only', () => {
    expect(
      sanitizeTab({ kind: 'web', title: 'App', url: 'http://localhost:5173/', unread: true })
    ).toEqual({ kind: 'web', title: 'App', url: 'http://localhost:5173/' })
  })

  it('keeps a well-formed file tab, view included', () => {
    expect(sanitizeTab({ kind: 'file', title: 'b.ts', path: '/ws/b.ts', view: 'diff' })).toEqual({
      kind: 'file',
      title: 'b.ts',
      path: '/ws/b.ts',
      view: 'diff'
    })
  })

  it('drops runtime fields a hand-edited document tries to smuggle in', () => {
    expect(
      sanitizeTab({
        kind: 'file',
        title: 'b.ts',
        path: '/ws/b.ts',
        sourceTabId: 'wt7',
        line: 42,
        id: 'wt9',
        unread: true
      })
    ).toEqual({ kind: 'file', title: 'b.ts', path: '/ws/b.ts' })
  })

  it('drops anything that is not a record at all', () => {
    for (const raw of [null, undefined, 42, 'web', true, () => 1]) {
      expect(sanitizeTab(raw)).toBeNull()
    }
  })

  it('drops a web tab with no url — there is nothing to repair it with', () => {
    expect(sanitizeTab({ kind: 'web', title: 'A' })).toBeNull()
    expect(sanitizeTab({ kind: 'web', title: 'A', url: '' })).toBeNull()
    expect(sanitizeTab({ kind: 'web', title: 'A', url: 42 })).toBeNull()
    expect(sanitizeTab({ kind: 'web', title: 'A', url: null })).toBeNull()
  })

  it('drops a file tab with no path, for the same reason', () => {
    expect(sanitizeTab({ kind: 'file', title: 'b.ts' })).toBeNull()
    expect(sanitizeTab({ kind: 'file', title: 'b.ts', path: '' })).toBeNull()
    expect(sanitizeTab({ kind: 'file', title: 'b.ts', path: ['/ws/b.ts'] })).toBeNull()
  })

  it('drops an unknown kind', () => {
    expect(sanitizeTab({ kind: 'terminal', title: 'sh' })).toBeNull()
    expect(sanitizeTab({ kind: 'browser', title: 'A', url: 'http://x.test/' })).toBeNull()
    expect(sanitizeTab({ title: 'A', url: 'http://x.test/' })).toBeNull()
  })

  it('FR-02: drops a stored `files` entry — the pinned tab is implied, never persisted', () => {
    expect(sanitizeTab({ kind: 'files', title: 'Files' })).toBeNull()
  })

  it('degrades an unknown view to absent WITHOUT dropping the tab — the path is the tab', () => {
    for (const view of ['content', 'rendered', '', 42, null]) {
      const tab = sanitizeTab({ kind: 'file', title: '', path: '/ws/b.ts', view })
      expect(tab).toEqual({ kind: 'file', title: '', path: '/ws/b.ts' })
      expect(tab?.view).toBeUndefined()
    }
  })

  it('accepts each of the three real views', () => {
    for (const view of ['render', 'diff', 'source']) {
      expect(sanitizeTab({ kind: 'file', title: '', path: '/ws/b.ts', view })?.view).toBe(view)
    }
  })

  it('degrades a non-string title to empty rather than dropping the tab', () => {
    expect(sanitizeTab({ kind: 'web', title: 42, url: 'http://x.test/' })).toEqual({
      kind: 'web',
      title: '',
      url: 'http://x.test/'
    })
    expect(sanitizeTab({ kind: 'file', path: '/ws/b.ts' })).toEqual({
      kind: 'file',
      title: '',
      path: '/ws/b.ts'
    })
  })

  it('ignores a `view` on a web tab — the field belongs to the other kind', () => {
    expect(sanitizeTab({ kind: 'web', title: '', url: 'http://x.test/', view: 'diff' })).toEqual({
      kind: 'web',
      title: '',
      url: 'http://x.test/'
    })
  })
})

// WB-P04 — the whole session entry. The failure this shape exists to prevent is blanking
// a panel over one bad tab, so every case below asserts what SURVIVES, not just what drops.
describe('sanitizeSessionWorkbench (WB-P04)', () => {
  it('keeps a well-formed entry as it stands', () => {
    const raw = {
      open: true,
      tabs: [
        { kind: 'web', title: 'A', url: 'http://x.test/a' },
        { kind: 'file', title: 'b', path: '/ws/b.ts', view: 'source' }
      ]
    }
    expect(sanitizeSessionWorkbench(raw, false)).toEqual({
      open: true,
      tabs: [
        { kind: 'web', title: 'A', url: 'http://x.test/a' },
        { kind: 'file', title: 'b', path: '/ws/b.ts', view: 'source' }
      ]
    })
  })

  it('WB-P04: drops the dirty items and restores the rest — never a blank panel', () => {
    const raw = {
      open: true,
      tabs: [
        { kind: 'web', title: 'A', url: 'http://x.test/a' },
        { kind: 'web', title: 'no url' },
        null,
        { kind: 'wat', title: 'unknown kind' },
        { kind: 'files', title: 'Files' },
        'not a tab',
        { kind: 'file', title: 'B', path: '/ws/b.ts' }
      ]
    }
    expect(sanitizeSessionWorkbench(raw, false)).toEqual({
      open: true,
      tabs: [
        { kind: 'web', title: 'A', url: 'http://x.test/a' },
        { kind: 'file', title: 'B', path: '/ws/b.ts' }
      ]
    })
  })

  it('preserves the stored order of the survivors', () => {
    const raw = {
      open: false,
      tabs: [
        { kind: 'file', title: '', path: '/ws/c.ts' },
        { kind: 'web', title: '', url: 'http://x.test/a' },
        { kind: 'file', title: '', path: '/ws/a.ts' }
      ]
    }
    expect(sanitizeSessionWorkbench(raw, true).tabs.map((t) => t.path ?? t.url)).toEqual([
      '/ws/c.ts',
      'http://x.test/a',
      '/ws/a.ts'
    ])
  })

  it('FR-22/WB-P04: truncates per kind at PERSISTED_TAB_CAP, counting the kinds apart', () => {
    const raw = {
      open: true,
      tabs: [
        ...Array.from({ length: 12 }, (_, i) => ({
          kind: 'web',
          title: `W${i}`,
          url: `http://x.test/${i}`
        })),
        ...Array.from({ length: 12 }, (_, i) => ({
          kind: 'file',
          title: `F${i}`,
          path: `/ws/f${i}.ts`
        }))
      ]
    }
    const out = sanitizeSessionWorkbench(raw, false)
    expect(out.tabs.filter((t) => t.kind === 'web')).toHaveLength(PERSISTED_TAB_CAP)
    expect(out.tabs.filter((t) => t.kind === 'file')).toHaveLength(PERSISTED_TAB_CAP)
    // the survivors are the first of each kind, not a slice of the mixed list
    expect(out.tabs[0].url).toBe('http://x.test/0')
    expect(out.tabs[PERSISTED_TAB_CAP].path).toBe('/ws/f0.ts')
  })

  it('counts only the tabs it KEPT toward the cap', () => {
    const raw = {
      open: true,
      tabs: [
        ...Array.from({ length: 4 }, () => ({ kind: 'web', title: 'bad' })),
        ...Array.from({ length: PERSISTED_TAB_CAP }, (_, i) => ({
          kind: 'web',
          title: `W${i}`,
          url: `http://x.test/${i}`
        }))
      ]
    }
    expect(sanitizeSessionWorkbench(raw, false).tabs).toHaveLength(PERSISTED_TAB_CAP)
  })

  it('falls back to the caller’s default when `open` is not a boolean', () => {
    for (const open of [undefined, null, 'true', 1, {}]) {
      expect(sanitizeSessionWorkbench({ open, tabs: [] }, true).open).toBe(true)
      expect(sanitizeSessionWorkbench({ open, tabs: [] }, false).open).toBe(false)
    }
    // …and honours a real boolean over the default, in both directions
    expect(sanitizeSessionWorkbench({ open: false, tabs: [] }, true).open).toBe(false)
    expect(sanitizeSessionWorkbench({ open: true, tabs: [] }, false).open).toBe(true)
  })

  it('degrades a `tabs` that is not an array to an empty strip, keeping `open`', () => {
    expect(sanitizeSessionWorkbench({ open: true, tabs: 'wat' }, false)).toEqual({
      open: true,
      tabs: []
    })
    expect(sanitizeSessionWorkbench({ open: true }, false)).toEqual({ open: true, tabs: [] })
  })

  it('degrades an entry that is not the shape at all to the caller’s default', () => {
    for (const raw of [undefined, null, 42, 'entry', true]) {
      expect(sanitizeSessionWorkbench(raw, true)).toEqual({ open: true, tabs: [] })
      expect(sanitizeSessionWorkbench(raw, false)).toEqual({ open: false, tabs: [] })
    }
  })

  it('is idempotent — sanitizing its own output changes nothing (NFR-06)', () => {
    const raw = {
      open: true,
      tabs: [
        { kind: 'web', title: 'A', url: 'http://x.test/a', unread: true },
        { kind: 'web', title: 'no url' },
        { kind: 'file', title: 'B', path: '/ws/b.ts', view: 'nope' }
      ]
    }
    const once = sanitizeSessionWorkbench(raw, false)
    expect(sanitizeSessionWorkbench(once, false)).toEqual(once)
  })
})
