import { describe, it, expect } from 'vitest'
import path from 'path'
import { planResume, worktreeHomeRoot, type ResumeProbes } from '../../src/main/resumePlan'
import type { SessionRow, WorktreeStateMeta } from '@shared/types'

const REPO = '/repo'
const WT = '/repo/.claude/worktrees/session-tab'

const binding: WorktreeStateMeta = {
  originalCwd: REPO,
  worktreePath: WT,
  worktreeName: 'session-tab',
  worktreeBranch: 'worktree-session-tab',
  originalHeadCommit: 'abc1234'
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's1',
    title: 'a session',
    worktree: 'session-tab',
    cwd: REPO,
    running: false,
    invalidCwd: false,
    mtime: 1,
    ...over
  }
}

function probes(over: Partial<ResumeProbes> = {}): ResumeProbes {
  return {
    dirExists: (p) => p === REPO || p === WT,
    branchAt: async () => 'worktree-session-tab',
    dirtyAt: async () => false,
    occupantOf: () => null,
    branchExists: async () => true,
    headAt: async () => 'head9876',
    ...over
  }
}

describe('planResume: sessions with no worktree binding', () => {
  it('reports not-found when no row carries the id', async () => {
    expect(await planResume(undefined, probes())).toEqual({
      action: 'unavailable',
      reason: 'not-found'
    })
  })

  it('resumes directly in the recorded cwd', async () => {
    expect(await planResume(row(), probes())).toEqual({ action: 'direct', cwd: REPO })
  })

  it('is unavailable when the recorded cwd is a plain dir that is gone', async () => {
    expect(await planResume(row({ cwd: '/gone' }), probes())).toEqual({
      action: 'unavailable',
      reason: 'no-cwd'
    })
  })
})

describe('planResume: unbound session whose cwd WAS a claude worktree (§4 left box)', () => {
  const inWorktree = row({ cwd: WT, worktree: 'session-tab' })
  const gone = { dirExists: (p: string) => p === REPO }

  it('rebuilds at the recorded path, on the branch the worktree name derives', async () => {
    expect(await planResume(inWorktree, probes(gone))).toEqual({
      action: 'rebuild',
      worktreeName: 'session-tab',
      worktreePath: WT,
      branch: 'worktree-session-tab',
      baseRef: 'worktree-session-tab',
      resumeCwd: WT
    })
  })

  it("bases the rebuild on the repo's head when that branch is gone too", async () => {
    const plan = await planResume(inWorktree, probes({ ...gone, branchExists: async () => false }))
    expect(plan).toMatchObject({
      action: 'rebuild',
      branch: 'worktree-session-tab',
      baseRef: 'head9876'
    })
  })

  it('stays unavailable when the repo can supply no baseline at all', async () => {
    const plan = await planResume(
      inWorktree,
      probes({ ...gone, branchExists: async () => false, headAt: async () => null })
    )
    expect(plan).toEqual({ action: 'unavailable', reason: 'no-cwd' })
  })
})

describe('planResume: bound session whose worktree still exists (D8 evidence gate)', () => {
  const bound = row({ worktreeState: binding })

  // CC§3
  it('resumes silently from originalCwd, never the worktree (claude re-enters it), when branch, cleanliness and occupancy are green', async () => {
    expect(await planResume(bound, probes())).toEqual({ action: 'direct', cwd: REPO })
  })

  it('opens the dialog on a branch mismatch, carrying both branches', async () => {
    const plan = await planResume(bound, probes({ branchAt: async () => 'main' }))
    expect(plan).toMatchObject({
      action: 'dialog',
      resumeCwd: REPO,
      renamedName: 'session-tab-2',
      evidence: {
        worktreePath: WT,
        worktreeName: 'session-tab',
        expectedBranch: 'worktree-session-tab',
        currentBranch: 'main',
        branchMatches: false,
        dirty: false,
        occupiedBy: null
      }
    })
  })

  // CC§3
  it('resumes silently despite uncommitted changes when branch matches and nobody else is in: dirty is the normal state of your own half-done worktree (E8)', async () => {
    expect(await planResume(bound, probes({ dirtyAt: async () => true }))).toEqual({
      action: 'direct',
      cwd: REPO
    })
  })

  it('still carries dirty into the evidence when a real anomaly opens the dialog', async () => {
    const plan = await planResume(
      bound,
      probes({ branchAt: async () => 'main', dirtyAt: async () => true })
    )
    expect(plan).toMatchObject({
      action: 'dialog',
      evidence: { dirty: true, branchMatches: false }
    })
  })

  it('opens the dialog when another running session works in the worktree (D9)', async () => {
    const plan = await planResume(bound, probes({ occupantOf: () => 'Refactor sessions' }))
    expect(plan).toMatchObject({
      action: 'dialog',
      evidence: { occupiedBy: 'Refactor sessions' }
    })
  })

  it('treats a failed git probe as an anomaly, never as green', async () => {
    const plan = await planResume(
      bound,
      probes({ branchAt: async () => null, dirtyAt: async () => null })
    )
    expect(plan).toMatchObject({
      action: 'dialog',
      evidence: { currentBranch: null, branchMatches: false, dirty: true }
    })
  })

  it('picks the first free renamed worktree name', async () => {
    const taken = new Set([WT, REPO, WT + '-2', WT + '-3'])
    const plan = await planResume(
      bound,
      probes({ branchAt: async () => 'main', dirExists: (p) => taken.has(p) })
    )
    expect(plan).toMatchObject({ renamedName: 'session-tab-4' })
  })
})

describe('planResume: bound session whose worktree is gone (rebuild)', () => {
  const bound = row({ worktreeState: binding })
  const gone = { dirExists: (p: string) => p === REPO }

  it('checks out the surviving branch at the recorded path', async () => {
    expect(await planResume(bound, probes(gone))).toEqual({
      action: 'rebuild',
      worktreeName: 'session-tab',
      worktreePath: WT,
      branch: 'worktree-session-tab',
      baseRef: 'worktree-session-tab',
      resumeCwd: REPO
    })
  })

  it('falls back to the recorded head commit when the branch is gone too', async () => {
    const plan = await planResume(bound, probes({ ...gone, branchExists: async () => false }))
    expect(plan).toMatchObject({ action: 'rebuild', baseRef: 'abc1234' })
  })
})

describe('planResume: the resume start follows the transcript slug (§1✎)', () => {
  const bound = row({ worktreeState: binding })

  it('starts a root-slug transcript at the original cwd (claude re-enters itself)', async () => {
    expect(await planResume(bound, probes(), REPO)).toEqual({ action: 'direct', cwd: REPO })
  })

  it('starts a worktree-slug transcript in the worktree itself', async () => {
    expect(await planResume(bound, probes(), WT)).toEqual({ action: 'direct', cwd: WT })
  })

  it('carries that start into the dialog and the rebuild alike', async () => {
    const dialog = await planResume(bound, probes({ branchAt: async () => 'main' }), WT)
    expect(dialog).toMatchObject({ action: 'dialog', resumeCwd: WT })
    const rebuild = await planResume(bound, probes({ dirExists: (p) => p === REPO }), WT)
    expect(rebuild).toMatchObject({ action: 'rebuild', resumeCwd: WT })
  })

  it('falls back to the original cwd for any other bucket (unknown included)', async () => {
    expect(await planResume(bound, probes(), '/repo/.claude/worktrees/other')).toMatchObject({
      cwd: REPO
    })
    expect(await planResume(bound, probes())).toMatchObject({ cwd: REPO })
  })
})

describe('worktreeHomeRoot', () => {
  it('derives the repo root of a claude worktree checkout', () => {
    expect(worktreeHomeRoot(WT)).toBe(REPO)
    expect(worktreeHomeRoot(path.join('/a/b', '.claude', 'worktrees', 'x'))).toBe('/a/b')
  })

  it('refuses any path that is not one level under a .claude/worktrees home', () => {
    expect(worktreeHomeRoot('/repo/src/thing')).toBeNull()
    expect(worktreeHomeRoot('/repo/.claude/worktrees/x/nested')).toBeNull()
    expect(worktreeHomeRoot('relative/.claude/worktrees/x')).toBeNull()
  })
})
