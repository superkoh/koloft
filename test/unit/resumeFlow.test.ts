import { describe, expect, it } from 'vitest'
import type { ResumeEvidence, ResumePlan } from '@shared/types'
import {
  evidenceLines,
  existingRequest,
  mainRequest,
  mayBeRunningElsewhere,
  planToStep,
  rebuildRequest,
  releaseResume,
  releaseSettledResumes,
  renamedRequest,
  resumeFailureMessage,
  resumeInFlight,
  resumeSession,
  UNAVAILABLE_NOTICE,
  STILL_RUNNING_NOTICE
} from '../../src/renderer/src/resumeFlow'
import { useStore } from '../../src/renderer/src/store'

const target = { id: 'sid-1', backendId: 'claude' as const, title: 'Refactor session management' }

const evidence = (over: Partial<ResumeEvidence> = {}): ResumeEvidence => ({
  worktreePath: '/repo/.claude/worktrees/session-tab',
  worktreeName: 'session-tab',
  expectedBranch: 'worktree-session-tab',
  currentBranch: 'worktree-session-tab',
  branchMatches: true,
  dirty: false,
  occupiedBy: null,
  ...over
})

const dialogPlan = (ev: ResumeEvidence): Extract<ResumePlan, { action: 'dialog' }> => ({
  action: 'dialog',
  evidence: ev,
  resumeCwd: '/repo',
  renamedName: 'session-tab-2'
})

const rebuildPlan: Extract<ResumePlan, { action: 'rebuild' }> = {
  action: 'rebuild',
  worktreeName: 'session-tab',
  worktreePath: '/repo/.claude/worktrees/session-tab',
  branch: 'worktree-session-tab',
  baseRef: 'abc123',
  resumeCwd: '/repo'
}

describe('planToStep (D6/D8 routing)', () => {
  it('spawns straight away on a green plan — no dialog (D8)', () => {
    expect(planToStep({ action: 'direct', cwd: '/repo' }, target)).toEqual({
      kind: 'spawn',
      req: { sessionId: 'sid-1', cwd: '/repo', mode: 'direct' }
    })
  })

  it('spawns the rebuild straight away when the worktree is gone: the row already says so, so the click is the consent', () => {
    expect(planToStep(rebuildPlan, target)).toEqual({
      kind: 'spawn',
      req: {
        sessionId: 'sid-1',
        cwd: '/repo',
        mode: 'rebuild',
        rebuild: {
          worktreePath: '/repo/.claude/worktrees/session-tab',
          branch: 'worktree-session-tab',
          baseRef: 'abc123'
        }
      }
    })
  })

  it('raises the two-choice dialog on anomalous evidence (§4.1)', () => {
    const plan = dialogPlan(evidence({ dirty: true }))
    expect(planToStep(plan, target)).toEqual({
      kind: 'dialog',
      dialog: { kind: 'choose', target, plan }
    })
  })

  it('degrades to a non-blocking notice when there is nothing to resume into', () => {
    expect(planToStep({ action: 'unavailable', reason: 'no-cwd' }, target)).toEqual({
      kind: 'notice',
      message: UNAVAILABLE_NOTICE
    })
    expect(UNAVAILABLE_NOTICE).toBe("This session's directory no longer exists — transcript only.")
  })

  it('a session still running in another claude is never opened a second time', () => {
    expect(planToStep({ action: 'unavailable', reason: 'running' }, target)).toEqual({
      kind: 'notice',
      message: STILL_RUNNING_NOTICE
    })
  })
})

describe('resume requests (D10/D12 modes)', () => {
  it('rebuild carries the recreate spec and resumes at the plan cwd', () => {
    expect(rebuildRequest(target, rebuildPlan)).toEqual({
      sessionId: 'sid-1',
      cwd: '/repo',
      mode: 'rebuild',
      rebuild: {
        worktreePath: '/repo/.claude/worktrees/session-tab',
        branch: 'worktree-session-tab',
        baseRef: 'abc123'
      }
    })
  })

  it('"resume in existing" is a plain resume at the plan cwd — claude re-enters', () => {
    expect(existingRequest(target, dialogPlan(evidence({ dirty: true })))).toEqual({
      sessionId: 'sid-1',
      cwd: '/repo',
      mode: 'direct'
    })
  })

  it('"resume in new worktree" passes the renamed name through to `-w` (D10)', () => {
    expect(renamedRequest(target, dialogPlan(evidence({ dirty: true })))).toEqual({
      sessionId: 'sid-1',
      cwd: '/repo',
      mode: 'renamed',
      worktree: 'session-tab-2'
    })
  })

  it('the D12 escape resumes in main with no isolation', () => {
    expect(mainRequest(target, '/repo')).toEqual({
      sessionId: 'sid-1',
      cwd: '/repo',
      mode: 'main'
    })
  })
})

describe('evidenceLines (§4.1 evidence block)', () => {
  it('confirms a matching branch and a clean tree without alarming', () => {
    expect(evidenceLines(evidence())).toEqual([
      { label: 'worktree', text: '/repo/.claude/worktrees/session-tab' },
      { label: 'branch', text: 'worktree-session-tab (matches record)' },
      { label: 'changes', text: 'clean' }
    ])
  })

  it('names the branch that is actually checked out when it drifted', () => {
    const lines = evidenceLines(evidence({ currentBranch: 'main', branchMatches: false }))
    expect(lines[1]).toEqual({
      label: 'branch',
      text: 'main (record: worktree-session-tab)',
      tone: 'warn'
    })
  })

  it('reads a detached head as such rather than printing null', () => {
    const lines = evidenceLines(evidence({ currentBranch: null, branchMatches: false }))
    expect(lines[1].text).toBe('detached (record: worktree-session-tab)')
  })

  it('flags uncommitted changes', () => {
    expect(evidenceLines(evidence({ dirty: true }))[2]).toEqual({
      label: 'changes',
      text: 'uncommitted changes',
      tone: 'warn'
    })
  })

  it('adds the occupancy line ONLY when Koloft sees a running session in there (D9)', () => {
    expect(evidenceLines(evidence()).some((l) => l.label === 'in use')).toBe(false)
    expect(evidenceLines(evidence({ occupiedBy: 'Other run' })).at(-1)).toEqual({
      label: 'in use',
      text: 'another running session is working in this worktree',
      tone: 'danger'
    })
  })
})

describe('history rows (D5/D9)', () => {
  it('tags a transcript touched within the last minute — Koloft cannot see outside claudes', () => {
    const now = 1_000_000_000
    expect(mayBeRunningElsewhere(now - 59_000, now)).toBe(true)
    expect(mayBeRunningElsewhere(now - 61_000, now)).toBe(false)
    expect(mayBeRunningElsewhere(now + 5_000, now)).toBe(true)
  })
})

function stubApi(): { resumePlan: () => Promise<ResumePlan> } {
  const sessions = {
    resumePlan: async (): Promise<ResumePlan> => ({ action: 'direct', cwd: '/repo' }),
    resume: async (): Promise<{ ok: true; id: string; cwd: string }> => ({
      ok: true,
      id: 'pty-1',
      cwd: '/repo'
    })
  }
  ;(globalThis as { window?: unknown }).window = { api: { sessions } }
  return sessions
}

describe('the in-flight latch (double-click dedupe)', () => {
  it('lets go of a member-row resume as soon as its row is no longer cold', async () => {
    stubApi()
    await resumeSession({ id: 'sid-member', backendId: 'claude', title: 'a session' })
    expect(resumeInFlight('sid-member')).toBe(true)
    releaseSettledResumes(new Set())
    expect(resumeInFlight('sid-member')).toBe(false)
  })

  it('holds a D5 restore across the rows push that has no row for it at all, so a second click cannot spawn a second pty', async () => {
    stubApi()
    await resumeSession({
      id: 'sid-restore',
      backendId: 'claude',
      title: 'from history',
      restore: true
    })
    expect(resumeInFlight('sid-restore')).toBe(true)
    releaseSettledResumes(new Set())
    releaseSettledResumes(new Set())
    expect(resumeInFlight('sid-restore')).toBe(true)
    releaseResume('sid-restore')
    expect(resumeInFlight('sid-restore')).toBe(false)
  })
})

describe('the click-time placeholder: the store holds the target before the first IPC, so a slow plan never reads as a hang', () => {
  it('is up from the click until the tab lands, and gone the moment it does', async () => {
    const api = stubApi()
    let answer!: (p: ResumePlan) => void
    api.resumePlan = () => new Promise<ResumePlan>((r) => (answer = r))
    const done = resumeSession({ id: 'sid-slow', backendId: 'claude', title: 'Slow to plan' })
    expect(useStore.getState().resumeLaunch).toEqual({ id: 'sid-slow', title: 'Slow to plan' })
    answer({ action: 'direct', cwd: '/repo' })
    await done
    expect(useStore.getState().resumeLaunch).toBeNull()
    expect(useStore.getState().activeTabId).toBe('pty-1')
    releaseResume('sid-slow')
  })

  it('comes down when the resume ends without a tab (failed plan)', async () => {
    const api = stubApi()
    api.resumePlan = () => Promise.reject(new Error('ipc down'))
    await resumeSession({ id: 'sid-fail', backendId: 'claude', title: 'Never lands' })
    expect(useStore.getState().resumeLaunch).toBeNull()
  })
})

describe('resumeFailureMessage', () => {
  it('keeps the vanished-folder wording distinct from a generic failure', () => {
    expect(resumeFailureMessage('cwd-missing')).toBe('Folder is gone — cannot resume here')
    expect(resumeFailureMessage('invalid-args')).toBe('Resume failed')
    expect(resumeFailureMessage('rebuild-failed')).toBe('Resume failed')
  })
})
