import { describe, expect, it } from 'vitest'
import {
  escPeel,
  freshLineCopy,
  isDimmed,
  mainRunningCount,
  moveHot,
  primaryKind,
  primaryLabel,
  pullFailedReason,
  resolveLaunch,
  sortWorktrees,
  worktreeAim,
  worktreeBaseMode,
  type WtHot
} from '../../src/renderer/src/newSession'
import { freshLineState, type FreshLineState } from '@shared/freshnessOps'
import type { SessionRow, WorkspaceFreshness } from '@shared/types'

const NOW = 1_700_000_000_000
const MIN = 60_000

const wt = (
  name: string,
  inUse = false
): { name: string; dir: string; branch?: string; inUse: boolean } => ({
  name,
  dir: `/repo/.claude/worktrees/${name}`,
  branch: `worktree-${name}`,
  inUse
})

describe('resolveLaunch (§5 — the two branches C8 chooses between)', () => {
  it('an existing worktree cds into its checkout — never `-w` (V2)', () => {
    expect(resolveLaunch({ kind: 'existing', ...wt('bugfix') }, '/repo')).toEqual({
      cwd: '/repo/.claude/worktrees/bugfix'
    })
  })

  it("an existing worktree of a remote workspace travels as the machine's key", () => {
    expect(resolveLaunch({ kind: 'existing', ...wt('bugfix') }, 'ssh://devbox/repo')).toEqual({
      cwd: 'ssh://devbox/repo/.claude/worktrees/bugfix'
    })
  })

  it('a new name runs `claude -w <name>` from the repo root', () => {
    expect(resolveLaunch({ kind: 'create', name: 'payment-retry' }, '/repo')).toEqual({
      cwd: '/repo',
      worktree: 'payment-retry'
    })
  })
})

const peel = (p: { locked?: boolean; confirmOpen?: boolean }): string =>
  escPeel({ locked: false, confirmOpen: false, ...p })

describe('escPeel (shared Esc ladder — the C10 rungs)', () => {
  it('swallows the key outright while a pull is in flight (D6: no cancel, no escape)', () => {
    expect(peel({ locked: true })).toBe('none')
    expect(peel({ locked: true, confirmOpen: true })).toBe('none')
  })

  it('closes the stacked pull confirm before the dialog behind it (D4)', () => {
    expect(peel({ confirmOpen: true })).toBe('confirm')
  })

  it('closes a dialog with no rungs of its own on the first press (C10)', () => {
    expect(peel({})).toBe('close')
  })
})

const fresh = (patch: Partial<WorkspaceFreshness> = {}): WorkspaceFreshness => ({
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
})

const sessionRow = (patch: Partial<SessionRow> = {}): SessionRow => ({
  id: 's1',
  backendId: 'claude',
  host: 'local',
  title: 't',
  worktree: 'main',
  cwd: '/repo',
  running: true,
  invalidCwd: false,
  mtime: 0,
  ...patch
})

describe('primaryKind / primaryLabel (D6 button morph)', () => {
  it('morphs to Pull & Start only on a pullable stale line', () => {
    expect(primaryKind('stale-pullable', 'idle')).toBe('pull')
    expect(primaryLabel('pull')).toBe('Pull & Start')
  })

  it.each<FreshLineState>(['hidden', 'checking', 'ok', 'stale-blocked', 'offline'])(
    'stays plain Start on %s',
    (line) => {
      expect(primaryKind(line, 'idle')).toBe('start')
      expect(primaryLabel('start')).toBe('Start')
    }
  )

  it('locks to Pulling… while the pull is in flight', () => {
    expect(primaryKind('stale-pullable', 'pulling')).toBe('pulling')
    expect(primaryLabel('pulling')).toBe('Pulling…')
  })

  it('never re-offers the pull after a failure — the brake is Start (D6)', () => {
    expect(primaryKind('stale-pullable', 'failed')).toBe('start')
  })
})

describe('freshLineCopy (M4 wording)', () => {
  it('greens an in-sync checkout with the real fetch age', () => {
    expect(freshLineCopy('ok', fresh({ behind: 0 }), NOW)).toEqual({
      strong: 'main is up to date',
      rest: ' — fetched 2 min ago.'
    })
  })

  it('words the pullable line with the count, the ref and the age', () => {
    expect(freshLineCopy('stale-pullable', fresh(), NOW)).toEqual({
      strong: 'main is 3 commits behind origin/main',
      rest: ' (fetched 2 min ago) — Pull & Start will fast-forward first.'
    })
  })

  it('singularizes a one-commit gap', () => {
    expect(freshLineCopy('stale-pullable', fresh({ behind: 1 }), NOW)?.strong).toBe(
      'main is 1 commit behind origin/main'
    )
  })

  it('says never fetched rather than going silent when no fetch ever succeeded', () => {
    expect(freshLineCopy('stale-pullable', fresh({ fetchedAt: null }), NOW)?.rest).toBe(
      ' (never fetched) — Pull & Start will fast-forward first.'
    )
    expect(freshLineCopy('offline', fresh({ state: 'error', fetchedAt: null }), NOW)?.rest).toBe(
      " (never fetched) — can't reach origin. Start uses the current HEAD."
    )
    expect(freshLineCopy('ok', fresh({ behind: 0, fetchedAt: null }), NOW)?.rest).toBe(
      ' — never fetched.'
    )
  })

  it('names the blocking reason, non-default branch first (M2 priority)', () => {
    expect(
      freshLineCopy(
        'stale-blocked',
        fresh({ onDefault: false, branch: 'fix-auth', dirty: true }),
        NOW
      )
    ).toEqual({
      strong: 'fix-auth is 3 commits behind origin/main',
      rest: ' — Koloft only pulls the default branch. Start uses the current HEAD.'
    })
    expect(freshLineCopy('stale-blocked', fresh({ dirty: true }), NOW)?.rest).toBe(
      ' — working tree has local changes; Koloft only pulls into a clean tree. Start uses the current HEAD.'
    )
    expect(freshLineCopy('stale-blocked', fresh({ ahead: 2 }), NOW)?.rest).toBe(
      ' — local commits diverge from origin/main; merge or rebase outside Koloft. Start uses the current HEAD.'
    )
  })

  it('blames the linked worktree before any other reason (D5)', () => {
    expect(
      freshLineCopy(
        'stale-blocked',
        fresh({ linked: true, branch: 'fix-auth', onDefault: false, dirty: true }),
        NOW
      )?.rest
    ).toBe(
      " — this workspace is a linked worktree; Koloft only pulls a main checkout's default branch. Start uses the current HEAD."
    )
  })

  it('dates the offline line by its last successful fetch', () => {
    expect(
      freshLineCopy('offline', fresh({ state: 'error', fetchedAt: NOW - 60 * MIN }), NOW)
    ).toEqual({
      strong: 'main is 3 commits behind origin/main',
      rest: " (last fetch 1 h ago) — can't reach origin. Start uses the current HEAD."
    })
  })

  it('has no copy for the states the line does not paint', () => {
    expect(freshLineCopy('hidden', fresh(), NOW)).toBeNull()
    expect(freshLineCopy('checking', fresh(), NOW)).toBeNull()
  })
})

describe('pullFailedReason (git speaks in full sentences, or not)', () => {
  it('keeps git own terminal period', () => {
    expect(pullFailedReason('fatal: Not possible to fast-forward, aborting.')).toBe(
      'fatal: Not possible to fast-forward, aborting.'
    )
  })

  it('terminates a bare reason', () => {
    expect(pullFailedReason('state changed')).toBe('state changed.')
    expect(pullFailedReason('  state changed  ')).toBe('state changed.')
  })
})

describe('mainRunningCount (D4 guard counts only root-checkout Koloft sessions)', () => {
  it('counts running and pending rows in the main bucket only', () => {
    expect(
      mainRunningCount([
        sessionRow(),
        sessionRow({ id: 's2', running: false, pending: true }),
        sessionRow({ id: 's3', worktree: 'bugfix' }),
        sessionRow({ id: 's4', running: false })
      ])
    ).toBe(2)
  })

  it('is zero for an idle checkout', () => {
    expect(mainRunningCount([sessionRow({ running: false })])).toBe(0)
  })
})

describe('worktreeAim (D5 — what the primary acts on)', () => {
  const field: WtHot = { where: 'field' }
  const trees = [wt('new-session-ux'), wt('alpha')]

  it('creates a name that does not exist yet', () => {
    expect(worktreeAim(trees, 'payment-retry', field)).toEqual({
      kind: 'create',
      name: 'payment-retry'
    })
  })

  it('still creates when the name only PREFIXES an existing worktree (D5 reversal)', () => {
    expect(worktreeAim(trees, 'new-session', field)).toEqual({
      kind: 'create',
      name: 'new-session'
    })
  })

  it('opens an exact hit case-insensitively, under the worktree’s own spelling', () => {
    expect(worktreeAim(trees, 'Alpha', field)).toEqual({
      kind: 'open',
      name: 'alpha',
      dir: '/repo/.claude/worktrees/alpha'
    })
  })

  it('refuses `main` in any case — the root bucket owns that name (§04A)', () => {
    expect(worktreeAim(trees, 'main', field)).toEqual({ kind: 'reserved', name: 'main' })
    expect(worktreeAim(trees, 'MAIN', field)).toEqual({ kind: 'reserved', name: 'MAIN' })
  })

  it('opens a worktree that really is called `main` instead of refusing it', () => {
    expect(worktreeAim([wt('main')], 'main', field)).toEqual({
      kind: 'open',
      name: 'main',
      dir: '/repo/.claude/worktrees/main'
    })
  })

  it('refuses an illegal name (shared validator, A12)', () => {
    expect(worktreeAim(trees, 'bad name!', field)).toEqual({ kind: 'invalid', name: 'bad name!' })
    expect(worktreeAim(trees, 'mаin', field)).toEqual({ kind: 'invalid', name: 'mаin' })
    expect(worktreeAim(trees, 'a'.repeat(65), field).kind).toBe('invalid')
    expect(worktreeAim(trees, 'a'.repeat(64), field).kind).toBe('create')
  })

  it('has nothing to act on while the field is empty', () => {
    expect(worktreeAim(trees, '', field)).toEqual({ kind: 'none' })
    expect(worktreeAim(trees, '   ', field)).toEqual({ kind: 'none' })
  })

  it('follows hot into the list, whatever the field says', () => {
    expect(worktreeAim(trees, 'payment-retry', { where: 'list', index: 1 })).toEqual({
      kind: 'open',
      name: 'alpha',
      dir: '/repo/.claude/worktrees/alpha'
    })
    expect(worktreeAim(trees, 'x', { where: 'list', index: 9 })).toEqual({ kind: 'none' })
  })
})

describe('sortWorktrees (D6 — most recently worked in, first)', () => {
  const row = (worktree: string, mtime: number): SessionRow => sessionRow({ worktree, mtime })

  it('orders by the newest session activity in each checkout', () => {
    const out = sortWorktrees(
      [wt('alpha'), wt('zeta')],
      [row('alpha', 1_000), row('zeta', 5_000), row('alpha', 2_000)]
    )
    expect(out.map((w) => w.name)).toEqual(['zeta', 'alpha'])
  })

  it('tails the worktrees with no working-set session, by name (§04B boundary)', () => {
    const out = sortWorktrees([wt('zzz'), wt('aaa-tail'), wt('busy')], [row('busy', 1_000)])
    expect(out.map((w) => w.name)).toEqual(['busy', 'aaa-tail', 'zzz'])
  })

  it('ignores rows belonging to the root bucket or to a vanished worktree', () => {
    const out = sortWorktrees(
      [wt('alpha'), wt('beta')],
      [row('main', 9_000), row('gone', 9_000), row('beta', 100)]
    )
    expect(out.map((w) => w.name)).toEqual(['beta', 'alpha'])
  })

  it('leaves its input alone — the dialog snapshots the order once (D6)', () => {
    const input = [wt('zeta'), wt('alpha')]
    sortWorktrees(input, [row('alpha', 5_000)])
    expect(input.map((w) => w.name)).toEqual(['zeta', 'alpha'])
  })
})

describe('isDimmed (D6 — filtering down-weights, never removes)', () => {
  it('dims nothing while the field is empty', () => {
    expect(isDimmed('alpha', '')).toBe(false)
    expect(isDimmed('alpha', '  ')).toBe(false)
  })

  it('keeps a substring match lit, case-insensitively', () => {
    expect(isDimmed('new-session-ux', 'SESSION')).toBe(false)
    expect(isDimmed('new-session-ux', 'new-session')).toBe(false)
  })

  it('dims what the typed name does not match', () => {
    expect(isDimmed('apple', 'ban')).toBe(true)
  })
})

describe('moveHot (§04A key table)', () => {
  const names = ['apple', 'banana', 'cherry']

  it('takes ↓ from the field to the first row that is not dimmed', () => {
    expect(moveHot({ where: 'field' }, names, '', 'down')).toEqual({ where: 'list', index: 0 })
    expect(moveHot({ where: 'field' }, names, 'ban', 'down')).toEqual({ where: 'list', index: 1 })
  })

  it('skips dimmed rows on the way down, and stops at the last lit one', () => {
    expect(moveHot({ where: 'list', index: 0 }, names, 'a', 'down')).toEqual({
      where: 'list',
      index: 1
    })
    expect(moveHot({ where: 'list', index: 1 }, names, 'a', 'down')).toEqual({
      where: 'list',
      index: 1
    })
  })

  it('returns to the field from the first lit row, and does nothing above it', () => {
    expect(moveHot({ where: 'list', index: 0 }, names, '', 'up')).toEqual({ where: 'field' })
    expect(moveHot({ where: 'list', index: 1 }, names, 'ban', 'up')).toEqual({ where: 'field' })
    expect(moveHot({ where: 'list', index: 2 }, names, '', 'up')).toEqual({
      where: 'list',
      index: 1
    })
    expect(moveHot({ where: 'field' }, names, '', 'up')).toEqual({ where: 'field' })
  })

  it('stays in the field when every row is dimmed, and when there are none', () => {
    expect(moveHot({ where: 'field' }, names, 'zzz', 'down')).toEqual({ where: 'field' })
    expect(moveHot({ where: 'field' }, [], '', 'down')).toEqual({ where: 'field' })
  })
})

describe('escPeel (C8 ladder — §04A)', () => {
  it('swallows the key while C8 pulls, and closes its confirm first', () => {
    expect(escPeel({ locked: true, confirmOpen: true, inList: true, hasText: true })).toBe('none')
    expect(escPeel({ locked: false, confirmOpen: true, inList: true, hasText: true })).toBe(
      'confirm'
    )
  })

  it('peels list → text → dialog, in that order', () => {
    expect(escPeel({ locked: false, confirmOpen: false, inList: true, hasText: true })).toBe('list')
    expect(escPeel({ locked: false, confirmOpen: false, inList: false, hasText: true })).toBe(
      'clear'
    )
    expect(escPeel({ locked: false, confirmOpen: false, inList: false, hasText: false })).toBe(
      'close'
    )
  })
})

describe('primaryLabel (C8 — the button says the whole action, D12)', () => {
  it('names what will happen to the name in the field', () => {
    expect(primaryLabel('start', { verb: 'Create', name: 'feat-x' })).toBe(
      'Create worktree “feat-x”'
    )
    expect(primaryLabel('start', { verb: 'Open', name: 'alpha' })).toBe('Open worktree “alpha”')
  })

  it('prefixes the pull when the base is behind and pullable', () => {
    expect(primaryLabel('pull', { verb: 'Create', name: 'feat-x' })).toBe(
      'Pull & Create worktree “feat-x”'
    )
  })

  it('names the ref it is fast-forwarding onto while the pull runs', () => {
    expect(primaryLabel('pulling', { verb: 'Create', name: 'feat-x', ref: 'origin/main' })).toBe(
      'Pulling origin/main…'
    )
  })

  it('keeps its verb with no name yet — the disabled button still says Create (D12)', () => {
    expect(primaryLabel('start', { verb: 'Create', name: null })).toBe('Create worktree')
  })

  it('names the method after the verb, never instead of it', () => {
    expect(primaryLabel('start', { verb: 'Create', name: 'feat-x' }, 'Claude')).toBe(
      'Create · Claude'
    )
    expect(primaryLabel('start', { verb: 'Open', name: 'alpha' }, 'Codex')).toBe('Open · Codex')
    expect(primaryLabel('start', { verb: 'Create', name: null }, 'Codex')).toBe('Create · Codex')
    expect(primaryLabel('pull', { verb: 'Create', name: 'feat-x' }, 'Codex')).toBe(
      'Pull & Create · Codex'
    )
    expect(primaryLabel('start', undefined, 'Claude')).toBe('Start · Claude')
    expect(primaryLabel('pull', undefined, 'Codex')).toBe('Pull & Start · Codex')
  })

  it('leaves the method out of the in-flight pull, which is about the ref', () => {
    expect(
      primaryLabel('pulling', { verb: 'Create', name: 'x', ref: 'origin/main' }, 'Claude')
    ).toBe('Pulling origin/main…')
  })
})

describe('worktree preparation recovery', () => {
  const resource = {
    name: 'interrupted',
    dir: '/repo/.koloft/worktrees/interrupted',
    recoveryResourceId: 'resource-1'
  }

  it('recovers the recorded resource for an exact name or a selected row', () => {
    for (const aim of [
      worktreeAim([resource], 'Interrupted', { where: 'field' }),
      worktreeAim([resource], '', { where: 'list', index: 0 })
    ]) {
      expect(aim.kind).toBe('recover')
      if (aim.kind !== 'recover') throw new Error('expected recovery')
      expect(resolveLaunch(aim, '/repo')).toEqual({
        cwd: '/repo',
        worktreeResourceId: 'resource-1'
      })
      expect(primaryLabel('start', { verb: 'Recover', name: aim.name }, 'Codex')).toBe(
        'Recover · Codex'
      )
    }
  })

  it('does not pull the repository before recovering a saved baseline', () => {
    const aim = worktreeAim([resource], resource.name, { where: 'field' })
    const line = freshLineState(fresh(), false, worktreeBaseMode(aim), NOW)
    expect(line).toBe('hidden')
    expect(primaryKind(line, 'idle')).toBe('start')
  })
})
