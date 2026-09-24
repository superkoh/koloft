import { describe, expect, it } from 'vitest'
import {
  carrySessionWorkbench,
  decideWorkspaceAdd,
  gcSessions,
  parseWorktreeEntries,
  resolveWorkbenchState,
  withWorkbenchState
} from '../../src/main/workspaceOps'
import { type LayoutV5, type SessionWorkbenchState } from '@shared/types'

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

  it('skips a checkout git marks prunable — a remote list has no directory check to drop it later', () => {
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

  it("'/clear' copies the old id's state to the new id, keeping the old key for the caller to drop (D2)", () => {
    const input = { old: entry(), other: { open: false, tabs: [] } }
    const out = carrySessionWorkbench(input, 'old', 'fresh', 'clear')
    expect(out.changed).toBe(true)
    expect(out.sessions.fresh).toEqual(entry())
    expect(out.sessions.old).toEqual(entry())
    expect(out.sessions.other).toEqual({ open: false, tabs: [] })
    expect(out.sessions.fresh).not.toBe(out.sessions.old)
    expect(Object.keys(input)).toEqual(['old', 'other'])
  })

  it('carries the whole tab set onto the new id — /clear is a rebind, not a removal (FR-29)', () => {
    const tabs: SessionWorkbenchState['tabs'] = [
      { kind: 'web', title: 'app', url: 'http://localhost:5173/' },
      { kind: 'file', title: 'README.md', path: '/repo/README.md', view: 'render' }
    ]
    const out = carrySessionWorkbench({ old: { open: true, tabs } }, 'old', 'fresh', 'clear')
    expect(out.changed).toBe(true)
    expect(out.sessions.fresh).toEqual({ open: true, tabs })
  })

  it('carries a collapsed panel as collapsed, never re-expanding it (FR-29)', () => {
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
  const layout = (sessions: LayoutV5['sessions'], defaultOpen = true): LayoutV5 => ({
    version: 5,
    workspaces: [],
    members: [],
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

  it('returns the stored entry verbatim — a collapsed panel stays collapsed across restarts (A6/A10)', () => {
    const stored: SessionWorkbenchState = {
      open: false,
      tabs: [{ kind: 'web', title: 'app', url: 'http://localhost:5173/' }]
    }
    expect(resolveWorkbenchState(layout({ s1: stored }), 's1')).toEqual(stored)
  })
})

describe('withWorkbenchState (§6: the panel state round-trips through layout v3)', () => {
  const layout = (sessions: LayoutV5['sessions']): LayoutV5 => ({
    version: 5,
    workspaces: [],
    members: [],
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
    expect(
      withWorkbenchState(layout({ other: { open: false, tabs: [] } }), 's1', {
        open: true,
        tabs: []
      }).other
    ).toEqual({ open: false, tabs: [] })
  })
})
