import { describe, expect, it } from 'vitest'
import {
  carrySessionWorkbench,
  decideWorkspaceAdd,
  gcSessions,
  parseWorktreeEntries,
  resolveWorkbenchState,
  withWorkbenchState
} from '../../src/main/workspaceOps'
import { type LayoutV4, type SessionWorkbenchState } from '@shared/types'

// Pure workspace-management decisions (A1 add/remove rules, §6 sessions GC).
// A wrong branch here surfaces in e2e only as "add silently did the wrong thing"
// or "panel state vanished much later" — neither localises to the decision.

describe('parseWorktreeEntries', () => {
  it('returns checkouts in porcelain order (first = main) with their short branch', () => {
    expect(
      parseWorktreeEntries(
        'worktree /Users/dev/proj\n' +
          'HEAD 1111111111111111111111111111111111111111\n' +
          'branch refs/heads/main\n' +
          '\n' +
          'worktree /Users/dev/proj/.claude/worktrees/bugfix\n' +
          'HEAD 2222222222222222222222222222222222222222\n' +
          'branch refs/heads/worktree-bugfix\n'
      )
    ).toEqual([
      { dir: '/Users/dev/proj', branch: 'main' },
      { dir: '/Users/dev/proj/.claude/worktrees/bugfix', branch: 'worktree-bugfix' }
    ])
  })

  it('keeps a detached checkout (no branch), skips a bare entry (no working dir)', () => {
    expect(
      parseWorktreeEntries(
        'worktree /Users/dev/bare.git\nbare\n\n' +
          'worktree /Users/dev/detached-co\n' +
          'HEAD 3333333333333333333333333333333333333333\n' +
          'detached\n'
      )
    ).toEqual([{ dir: '/Users/dev/detached-co' }])
  })

  // git says `prunable` for a checkout whose directory is gone. Locally a dirExists
  // filter catches those later; a remote list has no such filter, so the only
  // place they can be dropped is here.
  it('skips a checkout git marks prunable', () => {
    expect(
      parseWorktreeEntries(
        'worktree /Users/dev/proj\nbranch refs/heads/main\n\n' +
          'worktree /Users/dev/gone\nbranch refs/heads/worktree-gone\n' +
          'prunable gitdir file points to non-existent location\n'
      )
    ).toEqual([{ dir: '/Users/dev/proj', branch: 'main' }])
  })

  it('preserves paths containing spaces and returns [] for empty output', () => {
    expect(parseWorktreeEntries('worktree /Users/dev/my proj\nHEAD 4444\n')).toEqual([
      { dir: '/Users/dev/my proj' }
    ])
    expect(parseWorktreeEntries('')).toEqual([])
  })
})

describe('decideWorkspaceAdd (A1)', () => {
  it('rejects a linked worktree of ANY repo (worktreeName present)', () => {
    expect(
      decideWorkspaceAdd(
        { root: '/repo', treeRoot: '/repo/.claude/worktrees/x', worktreeName: 'x' },
        []
      )
    ).toEqual({ code: 'rejected-worktree' })
  })

  it('normalizes a subdir to the repo root (root comes from projectInfoFor)', () => {
    // projectInfoFor('/repo/src/deep').root === '/repo' — the decision persists the root
    expect(decideWorkspaceAdd({ root: '/repo', treeRoot: '/repo' }, ['/other'])).toEqual({
      code: 'added',
      path: '/repo'
    })
  })

  it('is idempotent: an already-pinned root reports exists, never a duplicate add', () => {
    expect(decideWorkspaceAdd({ root: '/repo', treeRoot: '/repo' }, ['/repo', '/other'])).toEqual({
      code: 'exists',
      path: '/repo'
    })
  })

  it('accepts a non-git dir as its own root', () => {
    expect(decideWorkspaceAdd({ root: '/notes', treeRoot: '/notes' }, [])).toEqual({
      code: 'added',
      path: '/notes'
    })
  })
})

describe('gcSessions (T-AGG-09①: keys follow their jsonl)', () => {
  const entry = (open: boolean): SessionWorkbenchState => ({ open, tabs: [] })

  it('drops keys whose jsonl vanished, keeps live ones', () => {
    const input = { alive: entry(true), orphan: entry(false) }
    const out = gcSessions(input, new Set(['alive', 'unrelated-live-id']))
    expect(out.changed).toBe(true)
    expect(Object.keys(out.sessions)).toEqual(['alive'])
    expect(out.sessions.alive).toEqual(entry(true))
    // the caller's object is not mutated — save decisions key off `changed`
    expect(Object.keys(input)).toEqual(['alive', 'orphan'])
  })

  it('reports changed=false when every key is live', () => {
    const input = { a: entry(false) }
    const out = gcSessions(input, new Set(['a']))
    expect(out.changed).toBe(false)
    expect(out.sessions).toEqual(input)
  })

  it('handles the empty table', () => {
    expect(gcSessions({}, new Set())).toEqual({ changed: false, sessions: {} })
  })
})

describe('carrySessionWorkbench (T-LIFE-07: the panel follows a /clear id change)', () => {
  const entry = (): SessionWorkbenchState => ({ open: true, tabs: [] })

  it("'/clear' copies the old id's state to the new id, keeping the old key", () => {
    const input = { old: entry(), other: { open: false, tabs: [] } }
    const out = carrySessionWorkbench(input, 'old', 'fresh', 'clear')
    expect(out.changed).toBe(true)
    expect(out.sessions.fresh).toEqual(entry())
    // the copy is all this function does; the lifecycle contract D2 turns it into a MOVE by
    // having the caller drop the old key right after (index.ts dropOwnership), which
    // is deliberately NOT folded in here — the two halves have different guards
    expect(out.sessions.old).toEqual(entry())
    expect(out.sessions.other).toEqual({ open: false, tabs: [] })
    // a copy, not the same object: a later write of one id must not rewrite the other
    expect(out.sessions.fresh).not.toBe(out.sessions.old)
    expect(Object.keys(input)).toEqual(['old', 'other'])
  })

  // FR-29 / §Edge: /clear is a rebind, not a removal — the tab set MOVES to the new id
  // and is never emptied. Carrying `open` alone would leave the user's pages on the dead
  // id, which is the failure session-browser IMPL-1 already booked once.
  it('carries the whole tab set onto the new id', () => {
    const tabs: SessionWorkbenchState['tabs'] = [
      { kind: 'web', title: 'app', url: 'http://localhost:5173/' },
      { kind: 'file', title: 'README.md', path: '/repo/README.md', view: 'render' }
    ]
    const out = carrySessionWorkbench({ old: { open: true, tabs } }, 'old', 'fresh', 'clear')
    expect(out.changed).toBe(true)
    expect(out.sessions.fresh).toEqual({ open: true, tabs })
  })

  // a collapsed panel is state too: FR-29 keeps the OPEN state across the move, so a
  // /clear must not silently re-expand the panel the user had closed
  it('carries a collapsed panel as collapsed', () => {
    const out = carrySessionWorkbench({ old: { open: false, tabs: [] } }, 'old', 'f', 'clear')
    expect(out.sessions.f).toEqual({ open: false, tabs: [] })
  })

  it('never clobbers a panel the new id already owns', () => {
    const input = { old: entry(), fresh: { open: false, tabs: [] } }
    const out = carrySessionWorkbench(input, 'old', 'fresh', 'clear')
    expect(out.changed).toBe(false)
    expect(out.sessions).toBe(input)
  })

  it('carries nothing when the old id never had an entry (it ran on the default)', () => {
    const out = carrySessionWorkbench({ other: entry() }, 'old', 'fresh', 'clear')
    expect(out.changed).toBe(false)
    expect(out.sessions.fresh).toBeUndefined()
  })

  it('a /resume or startup id change is a session SWITCH — nothing is carried (A8)', () => {
    // §4 case ②: the panel comes from the target id's own entry, or the default — a
    // resumed session must not inherit the tab set of whatever the tab ran before.
    const tabs: SessionWorkbenchState['tabs'] = [
      { kind: 'web', title: 'app', url: 'http://localhost:5173/' }
    ]
    for (const source of ['resume', 'startup', 'compact', '']) {
      const out = carrySessionWorkbench({ old: { open: true, tabs } }, 'old', 'fresh', source)
      expect(out.changed, source).toBe(false)
      expect(out.sessions.fresh, source).toBeUndefined()
    }
  })
})

describe('resolveWorkbenchState (§7: what the panel starts from)', () => {
  const layout = (sessions: LayoutV4['sessions'], defaultOpen = true): LayoutV4 => ({
    version: 4,
    workspaces: [],
    workbench: { defaultOpen },
    sessions
  })

  it('gives a session with no entry the global default, with no tabs (FR-02)', () => {
    expect(resolveWorkbenchState(layout({}), 'brand-new')).toEqual({ open: true, tabs: [] })
    expect(resolveWorkbenchState(layout({}, false), 'brand-new')).toEqual({
      open: false,
      tabs: []
    })
  })

  it('returns the stored entry verbatim — a collapsed panel stays collapsed', () => {
    // `open: false` means "the user collapsed the panel for this session"; falling back
    // to defaultOpen here would re-expand it on every restart (A6/A10)
    const stored: SessionWorkbenchState = {
      open: false,
      tabs: [{ kind: 'web', title: 'app', url: 'http://localhost:5173/' }]
    }
    expect(resolveWorkbenchState(layout({ s1: stored }), 's1')).toEqual(stored)
  })
})

describe('withWorkbenchState (§6: the panel state round-trips through layout v3)', () => {
  const layout = (sessions: LayoutV4['sessions']): LayoutV4 => ({
    version: 4,
    workspaces: [],
    workbench: { defaultOpen: true },
    sessions
  })
  const tab = (url: string): SessionWorkbenchState['tabs'][number] => ({
    kind: 'web',
    title: url,
    url
  })

  it('creates a missing entry from the submitted state', () => {
    const state = { open: false, tabs: [tab('http://a/')] }
    expect(withWorkbenchState(layout({}), 's1', state)).toEqual({ s1: state })
  })

  it('replaces the stored entry wholesale — `open` and the tabs move together now', () => {
    const base = layout({ s1: { open: true, tabs: [tab('http://a/')] } })
    const state = { open: false, tabs: [tab('http://b/')] }
    expect(withWorkbenchState(base, 's1', state).s1).toEqual(state)
  })

  // D8: the submitted state is the whole truth, not a merge — v2 patched one field at a
  // time, so `browser` could only ever be replaced, never the entry. Closing the last tab
  // has to be able to empty what is on disk.
  it('writes an empty tab list, so a closed tab really leaves disk', () => {
    const base = layout({ s1: { open: true, tabs: [tab('http://a/')] } })
    expect(withWorkbenchState(base, 's1', { open: true, tabs: [] }).s1).toEqual({
      open: true,
      tabs: []
    })
  })

  it('does not mutate the layout it was handed', () => {
    const stored = { open: true, tabs: [tab('http://a/')] }
    const base = layout({ s1: stored })
    const out = withWorkbenchState(base, 's1', { open: false, tabs: [] })
    expect(base.sessions.s1).toEqual(stored)
    expect(out).not.toBe(base.sessions)
    // sibling sessions are carried through untouched
    expect(
      withWorkbenchState(layout({ other: { open: false, tabs: [] } }), 's1', {
        open: true,
        tabs: []
      }).other
    ).toEqual({ open: false, tabs: [] })
  })
})
