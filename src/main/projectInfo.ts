import fs from 'fs'
import path from 'path'
import os from 'os'
import type { ProjectInfo } from '@shared/types'

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Resolve the project root (the sidebar group key) + git worktree name for a working
 * directory. Drives the derived workspace grouping (see workspace-refactor-design §2):
 *
 *  - git repo, main worktree    → root = treeRoot = repo root, no worktree name
 *  - git repo, linked worktree  → root = the *common* repo root (so a worktree tab
 *    aggregates under the main project), treeRoot = the worktree's *own* checkout root
 *    (where its `.git` file lives), worktree name set → the 🌿 badge
 *  - submodule / non-git dir    → root = treeRoot = the directory itself (no marker walk)
 *
 * `treeRoot` is the dir holding the `.git` marker the walk stopped on — the file tree
 * roots there, so it pins to the checkout top-level and never drifts when the Claude
 * TUI cd's into a subdir (a deeper cwd walks back up to the same marker).
 *
 * Pure filesystem — no `git` binary. A Finder/Dock-launched packaged app inherits
 * launchd's minimal PATH, so shelling out to `git` would silently fail and the badge /
 * grouping would never resolve. Reading the literal `gitdir:` path also sidesteps the
 * relative-vs-absolute / symlinked-cwd pitfalls of comparing `rev-parse --git-dir`
 * against `--git-common-dir`.
 *
 * `cwd` is realpath'd up front so macOS `/var` vs `/private/var` and symlinked paths
 * canonicalize before the walk — otherwise two tabs in the same dir could split into two
 * groups. Synchronous (a handful of stats up the tree, only ever on a cwd change) so
 * there is no stale-callback race; callers memoize per cwd.
 *
 * The worktree-name half is the unchanged behavior of the old private `worktreeNameFor`
 * (now removed from sessionTracker): stable from every subdir, survives a checkout
 * folder rename, absent for the main worktree / submodules / non-git dirs.
 */
export function projectInfoFor(cwd: string): ProjectInfo {
  // A relative path can't be a meaningful project root, and dirname would converge at
  // "." immediately — bail. Callers always pass absolute paths regardless.
  if (!path.isAbsolute(cwd)) return { root: cwd, treeRoot: cwd }
  let dir = realpathSafe(cwd)
  // The walk always terminates at the filesystem root (dirname('/') === '/'); the depth
  // cap is an explicit guard so the loop's termination never depends on input shape.
  for (let depth = 0; depth < 128; depth++) {
    const dotgit = path.join(dir, '.git')
    let st: fs.Stats | undefined
    try {
      st = fs.lstatSync(dotgit)
    } catch {
      st = undefined
    }
    if (st?.isDirectory()) {
      // a `.git` directory is the main worktree — the repo root is this directory
      return { root: dir, treeRoot: dir }
    }
    if (st?.isFile()) {
      // a `.git` file holds `gitdir: <repo>/.git/worktrees/<name>` for a linked worktree
      // (or `<repo>/.git/modules/<name>` for a submodule). Read it to tell them apart.
      try {
        const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)
        const raw = m?.[1]
        if (raw) {
          const gitdir = path.isAbsolute(raw) ? raw : path.resolve(dir, raw)
          // linked worktree => <repo>/.git/worktrees/<name>; a submodule's parent is
          // `modules`, not `worktrees`, so it correctly yields no worktree badge
          if (path.basename(path.dirname(gitdir)) === 'worktrees') {
            // root = the common repo dir (3 dirnames up from gitdir) so the worktree
            // aggregates with the main worktree; name = the worktree's registered id.
            // treeRoot = this dir — the worktree's own checkout root — so the file tree
            // browses the worktree's files, not the main repo's.
            const root = path.dirname(path.dirname(path.dirname(gitdir)))
            return { root: realpathSafe(root), treeRoot: dir, worktreeName: path.basename(gitdir) }
          }
        }
      } catch {
        // unreadable .git file — treat this directory as its own root
      }
      // submodule (parent is `modules`) or unparseable gitdir: this dir is its own root
      return { root: dir, treeRoot: dir }
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      // hit the filesystem root with no `.git` → non-git dir is its own group
      const r = realpathSafe(cwd)
      return { root: r, treeRoot: r }
    }
    dir = parent
  }
  // depth cap hit (pathological input) — treat the original cwd as its own root
  const r = realpathSafe(cwd)
  return { root: r, treeRoot: r }
}

/**
 * Whether `dir` is itself a git checkout — the `.git` marker sits directly inside it
 * (a directory for a main checkout, a file for a linked worktree or submodule root).
 * A1 normalizes a pinned workspace to that root, so no walk-up is wanted: a plain
 * subdir of a repo is not a git workspace of its own. Same no-`git`-binary doctrine
 * as projectInfoFor.
 */
export function isGitCheckout(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'))
}

/**
 * Where a tab's shell should spawn for a requested (possibly restored) cwd. The dir
 * itself when it still exists; when it vanished since the layout was saved — typically
 * a cleaned-up `--worktree` checkout — walk up to the nearest enclosing checkout root
 * (`projectInfoFor` lstats parents, so it works for nonexistent leaves) instead of
 * stranding the tab in the user's home. Home remains the last resort.
 */
export function resolveSpawnCwd(requested: string | undefined): string {
  if (requested && fs.existsSync(requested)) return requested
  if (requested) {
    const { treeRoot } = projectInfoFor(requested)
    if (fs.existsSync(treeRoot)) return treeRoot
  }
  return os.homedir()
}
