import { describe, it, expect } from 'vitest'
import { ageLabel, canPull, freshLineState } from '@shared/freshnessOps'
import type { WorkspaceFreshness } from '@shared/types'

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
    fetchedAt: NOW - MIN,
    lastAttemptAt: NOW - MIN,
    ...patch
  }
}

describe('canPull', () => {
  it('allows a clean, purely-behind default branch', () => {
    expect(canPull(f())).toBe(true)
  })

  it.each([
    ['state none', { state: 'none' as const }],
    ['state error', { state: 'error' as const }],
    ['already up to date', { behind: 0 }],
    ['diverged (ahead)', { ahead: 2 }],
    ['dirty tree', { dirty: true }],
    ['off the default branch', { onDefault: false, branch: 'fix-auth' }],
    // D5: Koloft's one write hand touches a MAIN checkout only — a linked worktree
    // sitting on the default branch is still not ours to fast-forward
    ['a linked worktree, even on the default branch', { linked: true }]
  ])('refuses: %s', (_label, patch) => {
    expect(canPull(f(patch))).toBe(false)
  })
})

describe('freshLineState', () => {
  it('never renders for an existing worktree choice, whatever the data', () => {
    expect(freshLineState(f(), false, 'existing', NOW)).toBe('hidden')
    expect(freshLineState(f(), true, 'existing', NOW)).toBe('hidden')
  })

  it('shows checking while a fetch is in flight', () => {
    expect(freshLineState(undefined, true, 'main', NOW)).toBe('checking')
    expect(freshLineState(f(), true, 'create', NOW)).toBe('checking')
  })

  it('hides unknown and no-remote workspaces', () => {
    expect(freshLineState(undefined, false, 'main', NOW)).toBe('hidden')
    expect(freshLineState(null, false, 'main', NOW)).toBe('hidden')
    expect(freshLineState(f({ state: 'none' }), false, 'main', NOW)).toBe('hidden')
  })

  it('greens only a fresh, in-sync measurement', () => {
    expect(freshLineState(f({ behind: 0, fetchedAt: NOW - MIN }), false, 'main', NOW)).toBe('ok')
    expect(freshLineState(f({ behind: 0, fetchedAt: NOW - 16 * MIN }), false, 'main', NOW)).toBe(
      'hidden'
    )
    expect(freshLineState(f({ behind: 0, fetchedAt: null }), false, 'main', NOW)).toBe('hidden')
  })

  it('separates pullable from blocked staleness', () => {
    expect(freshLineState(f(), false, 'main', NOW)).toBe('stale-pullable')
    expect(freshLineState(f(), false, 'create', NOW)).toBe('stale-pullable')
    expect(freshLineState(f({ dirty: true }), false, 'main', NOW)).toBe('stale-blocked')
    expect(freshLineState(f({ onDefault: false }), false, 'main', NOW)).toBe('stale-blocked')
    expect(freshLineState(f({ ahead: 1 }), false, 'main', NOW)).toBe('stale-blocked')
    expect(freshLineState(f({ linked: true }), false, 'main', NOW)).toBe('stale-blocked')
  })

  it('offline never morphs into a pullable state', () => {
    expect(freshLineState(f({ state: 'error' }), false, 'main', NOW)).toBe('offline')
    // error with nothing known to be behind is simply unknown — not "up to date"
    expect(freshLineState(f({ state: 'error', behind: 0 }), false, 'main', NOW)).toBe('hidden')
  })
})

describe('ageLabel', () => {
  it.each([
    [NOW, 'just now'],
    [NOW - 59_000, 'just now'],
    [NOW - 2 * MIN, '2 min ago'],
    [NOW - 59 * MIN, '59 min ago'],
    [NOW - 60 * MIN, '1 h ago'],
    [NOW - 23 * 60 * MIN, '23 h ago'],
    [NOW - 24 * 60 * MIN, '1 day ago'],
    [NOW - 47 * 60 * MIN, '1 day ago'],
    [NOW - 72 * 60 * MIN, '3 days ago']
  ])('%s → %s', (ms, label) => {
    expect(ageLabel(ms, NOW)).toBe(label)
  })
})
