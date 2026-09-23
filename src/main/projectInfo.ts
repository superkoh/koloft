import fs from 'fs'
import path from 'path'
import os from 'os'
import type { ProjectInfo } from '@shared/types'

const WALK_UP_DEPTH_CAP = 128

export function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

// PLATFORM§1
export function projectInfoFor(cwd: string): ProjectInfo {
  if (!path.isAbsolute(cwd)) return { root: cwd, treeRoot: cwd }
  let dir = realpathSafe(cwd)
  for (let depth = 0; depth < WALK_UP_DEPTH_CAP; depth++) {
    const dotgit = path.join(dir, '.git')
    let st: fs.Stats | undefined
    try {
      st = fs.lstatSync(dotgit)
    } catch {
      st = undefined
    }
    if (st?.isDirectory()) {
      return { root: dir, treeRoot: dir }
    }
    // PLATFORM§30
    if (st?.isFile()) {
      try {
        const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)
        const raw = m?.[1]
        if (raw) {
          const gitdir = path.isAbsolute(raw) ? raw : path.resolve(dir, raw)
          if (path.basename(path.dirname(gitdir)) === 'worktrees') {
            const root = path.dirname(path.dirname(path.dirname(gitdir)))
            return { root: realpathSafe(root), treeRoot: dir, worktreeName: path.basename(gitdir) }
          }
        }
      } catch {}
      return { root: dir, treeRoot: dir }
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      const r = realpathSafe(cwd)
      return { root: r, treeRoot: r }
    }
    dir = parent
  }
  const r = realpathSafe(cwd)
  return { root: r, treeRoot: r }
}

export function isGitCheckout(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'))
}

export function resolveSpawnCwd(requested: string | undefined): string {
  if (requested && fs.existsSync(requested)) return requested
  if (requested) {
    const { treeRoot } = projectInfoFor(requested)
    if (fs.existsSync(treeRoot)) return treeRoot
  }
  return os.homedir()
}
