import path from 'path'
import type { ResumeEvidence, ResumePlan, SessionRow } from '@shared/types'

// The resume decision tree (the lifecycle contract §4, D6/D8/D9/D12). Pure over injected
// probes — index.ts supplies the git/fs/tracker IO — so every leaf is unit-testable.

export interface ResumeProbes {
  dirExists(p: string): boolean
  /** `git symbolic-ref --short HEAD` at a checkout. null covers BOTH a detached head
   *  and a failed git call: neither may read as a match (D8 is a green-only gate). */
  branchAt(dir: string): Promise<string | null>
  /** `git status --porcelain` non-empty; null when git failed. */
  dirtyAt(dir: string): Promise<boolean | null>
  /** Title (or id) of the RUNNING Koloft session that IS in this dir (D9). Koloft cannot
   *  see claude processes it did not spawn — honest boundary, not a lock. */
  occupantOf(dir: string): string | null
  /** `git rev-parse --verify refs/heads/<branch>` resolves in the repo at `repoDir`. */
  branchExists(repoDir: string, branch: string): Promise<boolean>
  /** `git rev-parse HEAD` at a repo. The baseline for a rebuild with no recorded
   *  commit of its own; null (git failed / not a repo) leaves nothing to build on. */
  headAt(repoDir: string): Promise<string | null>
}

/** The repo root a claude worktree checkout hangs off: they live exactly one level
 *  under `<root>/.claude/worktrees/`, and that home is the ONLY place Koloft will run a
 *  `git worktree add` into (§7 — never create over anything it didn't create). null
 *  for any other shape, including a nested path inside a worktree. */
export function worktreeHomeRoot(worktreePath: string): string | null {
  if (!path.isAbsolute(worktreePath)) return null
  const home = path.dirname(worktreePath)
  const root = path.dirname(path.dirname(home))
  return path.join(root, '.claude', 'worktrees') === home ? root : null
}

/** D7: same-named old/new worktrees are indistinguishable on disk, so the rename
 *  never reuses a name that is taken — `-2`, then `-3`… */
function freeWorktreeName(base: string, home: string, dirExists: (p: string) => boolean): string {
  let n = 2
  while (n < 100 && dirExists(path.join(home, `${base}-${n}`))) n++
  return `${base}-${n}`
}

/** §4 left box: an unbound session whose recorded cwd IS a claude worktree checkout.
 *  Nothing about it is on record, so the whole spec is derived — the branch from the
 *  worktree name (claude's own rule, §1) and the baseline from the branch if it
 *  survived, else the repo as it stands now. A repo that answers neither leaves
 *  nothing to rebuild from. */
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
  /** the slug bucket the transcript sits in (§1✎): when it IS the worktree, the resume
   *  starts there; a root-slug transcript starts at `originalCwd`. Absent = root. */
  bucketDir?: string
): Promise<ResumePlan> {
  if (!row) return { action: 'unavailable', reason: 'not-found' }
  const ws = row.worktreeState
  if (!ws) {
    if (probes.dirExists(row.cwd)) return { action: 'direct', cwd: row.cwd }
    return planUnboundRebuild(row.cwd, probes)
  }
  // §1✎: slug and binding are independent axes. claude performs the re-enter itself
  // from wherever the session originally started (V2, global id lookup) — but a
  // transcript that lives in the worktree's own slug started IN the worktree.
  const resumeCwd =
    bucketDir && path.resolve(bucketDir) === path.resolve(ws.worktreePath)
      ? ws.worktreePath
      : ws.originalCwd

  if (!probes.dirExists(ws.worktreePath)) {
    // claude has no rebuild path of its own (it would silently drop the binding and
    // run unisolated) — Koloft recreates the checkout first, at the recorded baseline
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
    // an unreadable working tree (git failed → null) counts as dirty: claude's
    // re-enter may `git reset --hard` to its baseline, so "unknown" must not pass
    dirty: dirty !== false,
    occupiedBy: probes.occupantOf(ws.worktreePath)
  }
  // D8 revision: dirty no longer gates — resuming your own half-done
  // worktree IS the normal case, and E8 proved re-entering a dirty same-branch
  // worktree is silent and lossless. Only the facts that mean the worktree is no
  // longer this session's still ask: branch drift (a failed git probe reads as one —
  // branchAt null never matches) and another running session working in it (D9).
  // Dirty stays in the evidence block for the dialogs those two raise.
  if (evidence.branchMatches && !evidence.occupiedBy) {
    return { action: 'direct', cwd: resumeCwd }
  }
  return {
    action: 'dialog',
    evidence,
    resumeCwd,
    renamedName: freeWorktreeName(ws.worktreeName, path.dirname(ws.worktreePath), probes.dirExists)
  }
}
