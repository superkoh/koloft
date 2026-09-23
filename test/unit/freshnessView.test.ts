import { describe, it, expect } from 'vitest'
import type { WorkspaceFreshness } from '../../src/shared/types'
import { behindBadge, headAge, pullNote, pullToast } from '../../src/renderer/src/freshnessView'

const NOW = 1_700_000_000_000
const MIN = 60_000

function f(patch: Partial<WorkspaceFreshness> = {}): WorkspaceFreshness {
  return {
    state: 'ok',
    behind: 3,
    ahead: 0,
    branch: 'main',
    head: 'a'.repeat(40),
    defRef: 'origin/main',
    onDefault: true,
    dirty: false,
    linked: false,
    hasSubmodules: false,
    fetchedAt: NOW - 2 * MIN,
    lastAttemptAt: NOW - 2 * MIN,
    ...patch
  }
}

describe('behindBadge', () => {
  it('draws nothing for unknown, synced or ahead-only workspaces (D5)', () => {
    expect(behindBadge(undefined, NOW)).toBeNull()
    expect(behindBadge(f({ behind: 0 }), NOW)).toBeNull()
    expect(behindBadge(f({ behind: 0, ahead: 4 }), NOW)).toBeNull()
  })

  it('is amber and actionable on the default branch', () => {
    const b = behindBadge(f(), NOW)
    expect(b).toEqual({
      cls: 'ws-behind',
      label: '3',
      name: 'main is 3 commits behind origin/main · last fetch 2 min ago'
    })
  })

  it('singularizes a one-commit gap', () => {
    expect(behindBadge(f({ behind: 1 }), NOW)?.name).toBe(
      'main is 1 commit behind origin/main · last fetch 2 min ago'
    )
  })

  it('degrades to the grey info state off the default branch, and says why', () => {
    const b = behindBadge(f({ behind: 2, branch: 'fix-auth', onDefault: false }), NOW)
    expect(b?.cls).toBe('ws-behind info')
    expect(b?.label).toBe('2')
    expect(b?.name).toBe(
      'fix-auth is 2 commits behind origin/main · last fetch 2 min ago · Root is on fix-auth — Koloft only pulls the default branch.'
    )
  })

  it('is grey for a linked worktree even on the default branch', () => {
    const b = behindBadge(f({ behind: 2, linked: true }), NOW)
    expect(b?.cls).toBe('ws-behind info')
    expect(b?.name).toBe(
      "main is 2 commits behind origin/main · last fetch 2 min ago · This workspace is a linked worktree — Koloft only pulls a main checkout's default branch."
    )
  })

  it('still shows the stale counts of a failed fetch', () => {
    expect(behindBadge(f({ state: 'error', fetchedAt: NOW - 90 * MIN }), NOW)?.name).toBe(
      'main is 3 commits behind origin/main · last fetch 1 h ago'
    )
  })

  it('says never rather than inventing an age when nothing ever fetched', () => {
    expect(behindBadge(f({ fetchedAt: null }), NOW)?.name).toBe(
      'main is 3 commits behind origin/main · last fetch never'
    )
  })
})

describe('headAge', () => {
  it('reads as a successful fetch while the engine is healthy', () => {
    expect(headAge(f(), NOW)).toBe('fetched 2 min ago')
  })

  it('reads as the LAST fetch once one failed — the counts below it are old', () => {
    expect(headAge(f({ state: 'error', fetchedAt: NOW - 60 * MIN }), NOW)).toBe(
      'last fetch 1 h ago'
    )
  })

  it('never fetched', () => {
    expect(headAge(f({ fetchedAt: null }), NOW)).toBe('never fetched')
  })
})

describe('pullNote', () => {
  it('clean and pullable', () => {
    expect(pullNote(f())).toEqual({
      text: 'Working tree clean — fast-forward is safe.',
      tone: 'plain'
    })
  })

  it('warns that a fast-forward leaves the submodules behind — but only on the clean note', () => {
    expect(pullNote(f({ hasSubmodules: true })).extra).toBe(
      'Submodules are not updated by pull — run git submodule update after.'
    )
    expect(pullNote(f({ hasSubmodules: true, dirty: true })).extra).toBeUndefined()
    expect(pullNote(f({ hasSubmodules: true, linked: true })).extra).toBeUndefined()
    expect(pullNote(f()).extra).toBeUndefined()
  })

  it('a linked worktree outranks every other reason — Koloft never pulls one (D5)', () => {
    expect(
      pullNote(f({ linked: true, branch: 'fix-auth', onDefault: false, dirty: true, ahead: 2 }))
    ).toEqual({
      text: "This workspace is a linked worktree — Koloft only pulls a main checkout's default branch.",
      tone: 'plain'
    })
  })

  it('off the default branch wins over every other reason', () => {
    expect(
      pullNote(f({ branch: 'fix-auth', onDefault: false, dirty: true, ahead: 2, state: 'error' }))
    ).toEqual({
      text: 'Root is on fix-auth — Koloft only pulls the default branch.',
      tone: 'plain'
    })
  })

  it('offline outranks a dirty tree', () => {
    expect(pullNote(f({ state: 'error', dirty: true }))).toEqual({
      text: "can't reach origin — check network or credentials.",
      tone: 'alarm'
    })
  })

  it('dirty outranks divergence', () => {
    expect(pullNote(f({ dirty: true, ahead: 2 }))).toEqual({
      text: 'Koloft only pulls into a clean tree — commit or discard local changes first.',
      tone: 'warn'
    })
  })

  it('diverged', () => {
    expect(pullNote(f({ ahead: 2 }))).toEqual({
      text: 'Local commits diverge from origin/main — merge or rebase outside Koloft.',
      tone: 'warn'
    })
  })
})

describe('pullToast', () => {
  it('prefixes the workspace name — the toast is a single global slot', () => {
    expect(
      pullToast('/Users/me/Projects/koloft', 'main', { count: 3, from: '69bd8f3', to: 'a1c2e3f' })
    ).toBe('koloft · main: fast-forwarded 3 commits (69bd8f3 → a1c2e3f)')
  })

  it('singular', () => {
    expect(
      pullToast('/Users/me/Projects/koloft', 'main', { count: 1, from: '69bd8f3', to: 'a1c2e3f' })
    ).toBe('koloft · main: fast-forwarded 1 commit (69bd8f3 → a1c2e3f)')
  })
})
