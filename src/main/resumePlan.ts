import fs from 'fs'
import path from 'path'
import { PLACEHOLDER_SESSION_TITLE } from '@shared/types'
import type { ResumeEvidence, ResumePlan, SessionRow } from '@shared/types'

export interface ResumeProbes {
  dirExists(p: string): boolean | Promise<boolean>
  branchAt(dir: string): Promise<string | null>
  dirtyAt(dir: string): Promise<boolean | null>
  occupantOf(dir: string): string | null
  branchExists(repoDir: string, branch: string): Promise<boolean>
  headAt(repoDir: string): Promise<string | null>
}

export function dirExistsSync(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export type GitOut = (dir: string, args: string[]) => Promise<string | null>

export function gitProbes(git: GitOut): Omit<ResumeProbes, 'dirExists' | 'occupantOf'> {
  return {
    branchAt: async (dir) => (await git(dir, ['symbolic-ref', '--short', 'HEAD']))?.trim() || null,
    dirtyAt: async (dir) => {
      const out = await git(dir, ['status', '--porcelain'])
      return out === null ? null : out.trim() !== ''
    },
    branchExists: async (repoDir, branch) =>
      (await git(repoDir, ['rev-parse', '--verify', 'refs/heads/' + branch])) !== null,
    headAt: async (repoDir) => (await git(repoDir, ['rev-parse', 'HEAD']))?.trim() || null
  }
}

export function occupantName(s: { title: string; sessionId: string }): string {
  if (s.title && s.title !== PLACEHOLDER_SESSION_TITLE) return s.title
  return s.sessionId || 'a launching session'
}

// CC§3
export function worktreeHomeRoot(worktreePath: string): string | null {
  if (!path.isAbsolute(worktreePath)) return null
  const home = path.dirname(worktreePath)
  const root = path.dirname(path.dirname(home))
  return path.join(root, '.claude', 'worktrees') === home ? root : null
}

const RENAME_SUFFIX_CAP = 100

// CC§3
async function freeWorktreeName(
  base: string,
  home: string,
  dirExists: ResumeProbes['dirExists']
): Promise<string> {
  let n = 2
  while (n < RENAME_SUFFIX_CAP && (await dirExists(path.join(home, `${base}-${n}`)))) n++
  return `${base}-${n}`
}

// CC§3
async function planUnboundRebuild(cwd: string, probes: ResumeProbes): Promise<ResumePlan> {
  const root = worktreeHomeRoot(cwd)
  if (!root) return { action: 'unavailable', reason: 'no-cwd' }
  const worktreeName = path.basename(cwd)
  const branch = `worktree-${worktreeName}`
  const baseRef = (await probes.branchExists(root, branch)) ? branch : await probes.headAt(root)
  if (!baseRef) return { action: 'unavailable', reason: 'no-cwd' }
  return { action: 'rebuild', worktreeName, worktreePath: cwd, branch, baseRef, resumeCwd: cwd }
}

export async function planResume(
  row: SessionRow | undefined,
  probes: ResumeProbes,
  bucketDir?: string
): Promise<ResumePlan> {
  if (!row) return { action: 'unavailable', reason: 'not-found' }
  const ws = row.worktreeState
  if (!ws) {
    if (await probes.dirExists(row.cwd)) return { action: 'direct', cwd: row.cwd }
    return planUnboundRebuild(row.cwd, probes)
  }
  // CC§2 CC§3
  const resumeCwd =
    bucketDir && path.resolve(bucketDir) === path.resolve(ws.worktreePath)
      ? ws.worktreePath
      : ws.originalCwd

  if (!(await probes.dirExists(ws.worktreePath))) {
    // CC§3
    const branchLives = await probes.branchExists(ws.originalCwd, ws.worktreeBranch)
    return {
      action: 'rebuild',
      worktreeName: ws.worktreeName,
      worktreePath: ws.worktreePath,
      branch: ws.worktreeBranch,
      baseRef: branchLives ? ws.worktreeBranch : ws.originalHeadCommit,
      resumeCwd
    }
  }

  const [branch, dirty] = await Promise.all([
    probes.branchAt(ws.worktreePath),
    probes.dirtyAt(ws.worktreePath)
  ])
  const evidence: ResumeEvidence = {
    worktreePath: ws.worktreePath,
    worktreeName: ws.worktreeName,
    expectedBranch: ws.worktreeBranch,
    currentBranch: branch,
    branchMatches: branch === ws.worktreeBranch,
    // CC§3
    dirty: dirty !== false,
    occupiedBy: probes.occupantOf(ws.worktreePath)
  }
  // CC§3
  if (evidence.branchMatches && !evidence.occupiedBy) {
    return { action: 'direct', cwd: resumeCwd }
  }
  return {
    action: 'dialog',
    evidence,
    resumeCwd,
    renamedName: await freeWorktreeName(
      ws.worktreeName,
      path.dirname(ws.worktreePath),
      probes.dirExists
    )
  }
}
