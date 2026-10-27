import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localGitOut } from '../../src/main/host/localHost'
import { projectInfoFor } from '../../src/main/projectInfo'
import {
  closingTree,
  removeTree,
  tidyTree,
  whatIsLeft,
  type ClosingTree
} from '../../src/main/sessionClose'
import type { GitOut } from '../../src/main/resumePlan'

let directory: string
let repo: string
let tree: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function commit(cwd: string, file: string, text: string): void {
  fs.writeFileSync(path.join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-m', file)
}

async function treeOf(dir: string): Promise<ClosingTree> {
  const found = await closingTree(localGitOut, projectInfoFor(dir))
  if (!found) throw new Error(`${dir} is not a worktree`)
  return found
}

function branches(): string[] {
  return git(repo, 'branch', '--format=%(refname:short)').split('\n').sort()
}

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-session-close-')))
  const origin = path.join(directory, 'origin.git')
  repo = path.join(directory, 'repo')
  git(directory, 'init', '--bare', '--initial-branch=main', origin)
  fs.mkdirSync(repo)
  git(repo, 'init', '--initial-branch=main')
  git(repo, 'config', 'user.name', 'Close test')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  commit(repo, '.gitignore', 'node_modules/\n.claude/\n')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')
  tree = path.join(repo, '.claude', 'worktrees', 'run-1')
  git(repo, 'worktree', 'add', '-q', '-b', 'worktree-run-1', tree)
  git(repo, 'worktree', 'lock', tree)
  fs.mkdirSync(path.join(tree, 'node_modules'))
  fs.writeFileSync(path.join(tree, 'node_modules', 'dep.js'), 'ignored')
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('closing a session that runs in its own worktree', () => {
  it('a locked worktree holding only ignored files, with every commit pushed, loses nothing and is removed with its branches', async () => {
    git(tree, 'switch', '-q', '-c', 'fix/1-thing')
    commit(tree, 'fix.txt', 'fixed')
    git(tree, 'push', '-q', 'origin', 'fix/1-thing')
    const closing = await treeOf(tree)
    expect(closing.branches.sort()).toEqual(['fix/1-thing', 'worktree-run-1'])
    expect(await whatIsLeft(localGitOut, closing)).toEqual([])
    expect(await removeTree(localGitOut, closing)).toBeNull()
    expect(fs.existsSync(tree)).toBe(false)
    expect(branches()).toEqual(['main'])
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('run-1')
  })

  it('a worktree git cannot delete is reported in git’s own words with the commands that finish it by hand, after which the session closes', async () => {
    const readOnly = path.join(tree, 'node_modules', 'read-only')
    fs.mkdirSync(readOnly)
    fs.writeFileSync(path.join(readOnly, 'pkg.js'), 'ignored')
    fs.chmodSync(readOnly, 0o555)
    const problem = await removeTree(localGitOut, await treeOf(tree))
    expect(problem).toContain(`failed to delete '${tree}': Permission denied`)

    expect(await closingTree(localGitOut, projectInfoFor(tree))).not.toBeNull()
    const byHand = problem?.match(/run: (.*)/)?.[1] ?? ''
    execFileSync('/bin/sh', ['-c', byHand])
    expect(fs.existsSync(tree)).toBe(false)
    expect(branches()).toEqual(['main'])
    expect(await closingTree(localGitOut, projectInfoFor(tree))).toBeNull()
  })

  it('a worktree git refuses to remove to keep a new file is reported in git’s words with no command that would delete it', async () => {
    fs.writeFileSync(path.join(tree, 'new.txt'), 'written after the check')
    const problem = await removeTree(localGitOut, await treeOf(tree))
    expect(problem).toContain('contains modified or untracked files')
    expect(problem).not.toContain('rm -rf')
    expect(fs.existsSync(path.join(tree, 'new.txt'))).toBe(true)
  })

  it('a commit another local branch also holds loses nothing, though no remote has it', async () => {
    commit(tree, 'merged.txt', 'merged into main, never pushed')
    git(repo, 'merge', '-q', '--ff-only', 'worktree-run-1')
    expect(await whatIsLeft(localGitOut, await treeOf(tree))).toEqual([])
  })

  it('names an uncommitted change and a new file, and a commit that is on no other branch and no remote branch', async () => {
    commit(tree, 'local.txt', 'never pushed')
    fs.writeFileSync(path.join(tree, '.gitignore'), 'changed\n')
    fs.writeFileSync(path.join(tree, 'new.txt'), 'untracked')
    const left = await whatIsLeft(localGitOut, await treeOf(tree))
    expect(left).toHaveLength(2)
    expect(left[0]).toContain('.gitignore')
    expect(left[0]).toContain('new.txt')
    expect(left[1]).toContain('local.txt')
  })

  it('counts a commit left on the worktree branch after switching to another branch', async () => {
    commit(tree, 'stray.txt', 'on worktree-run-1 only')
    git(tree, 'switch', '-q', '--detach', 'main')
    const left = await whatIsLeft(localGitOut, await treeOf(tree))
    expect(left.join('\n')).toContain('stray.txt')
  })

  describe('after its pull request was squash-merged and the pruned fetch dropped the deleted remote branch', () => {
    function squashMergedAndPruned(): string {
      commit(tree, 'feat.txt', 'one')
      commit(tree, 'feat.txt', 'two')
      git(tree, 'push', '-q', 'origin', 'worktree-run-1')
      const tip = git(tree, 'rev-parse', 'HEAD')
      git(repo, 'merge', '-q', '--squash', 'worktree-run-1')
      git(repo, 'commit', '-q', '-m', 'feat (#1)')
      git(repo, 'push', '-q', 'origin', 'main')
      git(repo, 'push', '-q', 'origin', '--delete', 'worktree-run-1')
      git(tree, 'fetch', '-q', '--prune')
      return tip
    }

    it('loses nothing when GitHub has a merged pull request whose head is the branch tip, whatever other heads this repo never saw', async () => {
      const tip = squashMergedAndPruned()
      const asked: string[] = []
      const merged = async (_dir: string, branch: string): Promise<string[]> => {
        asked.push(branch)
        return branch === 'worktree-run-1' ? ['f'.repeat(40), tip] : []
      }
      expect(await whatIsLeft(localGitOut, await treeOf(tree), merged)).toEqual([])
      expect(asked).toEqual(['worktree-run-1'])
    })

    it('still names a commit made after the merge, which no pull request holds', async () => {
      const tip = squashMergedAndPruned()
      commit(tree, 'after.txt', 'after the merge')
      const left = await whatIsLeft(localGitOut, await treeOf(tree), async () => [tip])
      expect(left).toHaveLength(1)
      expect(left[0]).toContain('after.txt')
      expect(left[0]).not.toContain('feat.txt')
    })

    it('keeps the worktree when GitHub cannot be asked, and says pushing would only bring the deleted branch back', async () => {
      squashMergedAndPruned()
      const left = await whatIsLeft(localGitOut, await treeOf(tree), async () => null)
      expect(left).toHaveLength(1)
      expect(left[0]).toContain('feat.txt')
      expect(left[0]).toContain('pushing would only bring back the branch GitHub deleted')
    })
  })

  it('a session in the repository itself has no worktree to remove', async () => {
    expect(await closingTree(localGitOut, projectInfoFor(repo))).toBeNull()
  })
})

describe('tidying a scheduled run’s folder (#22)', () => {
  const run = (): { root: string; treeRoot: string; worktreeName: string } => ({
    root: repo,
    treeRoot: tree,
    worktreeName: 'run-1'
  })
  const onDisk = async (dir: string): Promise<boolean> => fs.existsSync(dir)

  function removeFolderKeepingBranch(): void {
    git(repo, 'worktree', 'unlock', tree)
    git(repo, 'worktree', 'remove', '--force', tree)
  }

  it('removes a clean, locked folder and its branch', async () => {
    expect(await tidyTree(localGitOut, run(), onDisk)).toEqual({ removed: true, kept: [] })
    expect(fs.existsSync(tree)).toBe(false)
    expect(branches()).toEqual(['main'])
  })

  it('keeps a folder with an uncommitted file, and says so', async () => {
    fs.writeFileSync(path.join(tree, 'report.md'), 'draft')
    const r = await tidyTree(localGitOut, run(), onDisk)
    expect(r.removed).toBe(false)
    expect(r.kept[0]).toMatch(/^Changes not committed:\n.*report\.md/)
    expect(fs.existsSync(tree)).toBe(true)
  })

  function removalCutOffHalfWay(): void {
    fs.rmSync(path.join(tree, 'node_modules'), { recursive: true })
    fs.rmSync(path.join(tree, '.gitignore'))
  }

  it('removes a folder whose removal was cut off half way, as its only changes are deleted files and HEAD still holds them (#696)', async () => {
    removalCutOffHalfWay()
    expect(await tidyTree(localGitOut, run(), onDisk)).toEqual({ removed: true, kept: [] })
    expect(fs.existsSync(tree)).toBe(false)
    expect(branches()).toEqual(['main'])
  })

  it('keeps a half-deleted folder that also holds a new file, and names both', async () => {
    removalCutOffHalfWay()
    fs.writeFileSync(path.join(tree, 'report.md'), 'draft')
    const r = await tidyTree(localGitOut, run(), onDisk)
    expect(r.removed).toBe(false)
    expect(r.kept).toEqual(['Changes not committed:\n D .gitignore\n?? report.md'])
    expect(fs.existsSync(tree)).toBe(true)
  })

  it('still names a deleted file when a session is closed, outside the tidy', async () => {
    removalCutOffHalfWay()
    const left = await whatIsLeft(localGitOut, await treeOf(tree))
    expect(left).toEqual(['Changes not committed:\n D .gitignore'])
  })

  it('deletes the branch a folder removed by hand left behind', async () => {
    removeFolderKeepingBranch()
    expect(await tidyTree(localGitOut, run(), onDisk)).toEqual({ removed: true, kept: [] })
    expect(branches()).toEqual(['main'])
  })

  it('keeps the branch a folder removed by hand left behind when it holds a commit no other branch has, so the row can still rebuild the run', async () => {
    commit(tree, 'only-here.txt', 'never pushed')
    removeFolderKeepingBranch()
    const r = await tidyTree(localGitOut, run(), onDisk)
    expect(r.removed).toBe(false)
    expect(r.kept[0]).toContain('only-here.txt')
    expect(branches()).toEqual(['main', 'worktree-run-1'])
  })

  it('deletes the branch a folder removed by hand left behind when a merged pull request holds its commits', async () => {
    commit(tree, 'squashed.txt', 'merged on GitHub as one commit')
    const tip = git(tree, 'rev-parse', 'HEAD')
    removeFolderKeepingBranch()
    const merged = async (): Promise<string[]> => [tip]
    expect(await tidyTree(localGitOut, run(), onDisk, merged)).toEqual({
      removed: true,
      kept: []
    })
    expect(branches()).toEqual(['main'])
  })

  it('keeps everything and names the problem when the machine cannot be asked', async () => {
    const unreachable = async (): Promise<boolean> => {
      throw new Error('ssh: connect to host devbox port 22: Connection refused')
    }
    expect(await tidyTree(localGitOut, run(), unreachable)).toEqual({
      removed: false,
      kept: ['machine unreachable: ssh: connect to host devbox port 22: Connection refused'],
      unreachable: true
    })
    expect(fs.existsSync(tree)).toBe(true)
  })

  it('reads "removed" when git fails because another remover took the folder first', async () => {
    const anotherRemoverWins: GitOut = async (dir, args, timeoutMs) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        fs.rmSync(tree, { recursive: true, force: true })
        return null
      }
      return localGitOut(dir, args, timeoutMs)
    }
    expect(await tidyTree(anotherRemoverWins, run(), onDisk)).toEqual({ removed: true, kept: [] })
  })
})
