import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { isGitCheckout, projectInfoFor, resolveSpawnCwd } from '../../src/main/projectInfo'

// projectInfoFor is pure filesystem (no `git` binary): it walks up looking for a `.git`
// marker and parses a linked-worktree `.git` FILE's `gitdir:` line. These are the subtle
// paths (worktree vs submodule vs main vs subdir) with no other test coverage.
let root: string
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-projinfo-')))
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function mk(name: string): string {
  const d = path.join(root, name)
  fs.mkdirSync(d, { recursive: true })
  return fs.realpathSync(d)
}

describe('projectInfoFor', () => {
  it('main worktree (.git directory): root === treeRoot, no worktree name', () => {
    const repo = mk('main-repo')
    fs.mkdirSync(path.join(repo, '.git'))
    const info = projectInfoFor(repo)
    expect(info.root).toBe(repo)
    expect(info.treeRoot).toBe(repo)
    expect(info.worktreeName).toBeUndefined()
  })

  it('a subdir of a repo resolves up to the repo root', () => {
    const repo = mk('deep-repo')
    fs.mkdirSync(path.join(repo, '.git'))
    const deep = mk('deep-repo/src/nested/here')
    const info = projectInfoFor(deep)
    expect(info.root).toBe(repo)
    expect(info.treeRoot).toBe(repo)
  })

  it('linked worktree (.git file): root = common repo, treeRoot = own checkout, name set', () => {
    const repo = mk('wt-repo')
    const wt = mk('wt-checkout')
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${repo}/.git/worktrees/feature-x\n`)
    const info = projectInfoFor(wt)
    expect(info.root).toBe(repo) // aggregates under the main repo
    expect(info.treeRoot).toBe(wt) // browses its own checkout
    expect(info.worktreeName).toBe('feature-x')
  })

  it('submodule (.git file under modules): its own root, no worktree name', () => {
    const repo = mk('sm-parent')
    const sub = mk('sm-parent/sub')
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${repo}/.git/modules/sub\n`)
    const info = projectInfoFor(sub)
    expect(info.root).toBe(sub)
    expect(info.treeRoot).toBe(sub)
    expect(info.worktreeName).toBeUndefined()
  })

  it('non-git directory is its own group', () => {
    const plain = mk('plain-dir')
    const info = projectInfoFor(plain)
    expect(info.root).toBe(plain)
    expect(info.treeRoot).toBe(plain)
    expect(info.worktreeName).toBeUndefined()
  })
})

// A pinned workspace advertises `isGit` so the sidebar badge and the C7 dialog know
// whether it has worktree abilities at all (agent-centric A1/A4). A1 normalizes the
// pin to the checkout root, so the marker must be in the dir itself — no walk-up,
// which would mislabel a plain subdir of a repo as its own git workspace.
describe('isGitCheckout', () => {
  it('is true for a checkout root (.git directory)', () => {
    const repo = mk('isgit-main')
    fs.mkdirSync(path.join(repo, '.git'))
    expect(isGitCheckout(repo)).toBe(true)
  })

  it('is true for a .git FILE (linked worktree / submodule root)', () => {
    const wt = mk('isgit-linked')
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nowhere/.git/worktrees/x\n')
    expect(isGitCheckout(wt)).toBe(true)
  })

  it('is false for a plain dir, a repo subdir, and a path that no longer exists', () => {
    expect(isGitCheckout(mk('isgit-plain'))).toBe(false)
    const repo = mk('isgit-sub')
    fs.mkdirSync(path.join(repo, '.git'))
    expect(isGitCheckout(mk('isgit-sub/src'))).toBe(false)
    expect(isGitCheckout(path.join(root, 'isgit-gone'))).toBe(false)
  })
})

// Requirement: a restored tab whose saved cwd vanished (a cleaned-up worktree checkout,
// a deleted subdir) must come back inside its project — at the enclosing checkout root —
// not stranded in $HOME. Home is only the last resort (no dir at all / not in a repo).
describe('resolveSpawnCwd', () => {
  it('an existing dir spawns in place', () => {
    const repo = mk('spawn-live')
    expect(resolveSpawnCwd(repo)).toBe(repo)
  })

  it('a vanished dir under a repo walks up to the enclosing checkout root', () => {
    const repo = mk('spawn-repo')
    fs.mkdirSync(path.join(repo, '.git'))
    const gone = path.join(repo, '.claude', 'worktrees', 'cleaned-up')
    expect(fs.existsSync(gone)).toBe(false)
    expect(resolveSpawnCwd(gone)).toBe(repo)
  })

  it('a vanished dir outside any repo falls back to the user home', () => {
    expect(resolveSpawnCwd(path.join(root, 'no', 'such', 'dir'))).toBe(os.homedir())
  })

  it('no requested dir falls back to the user home', () => {
    expect(resolveSpawnCwd(undefined)).toBe(os.homedir())
  })
})
