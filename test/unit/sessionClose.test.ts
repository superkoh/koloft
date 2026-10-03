import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localGitOut } from '../../src/main/host/localHost'
import { projectInfoFor } from '../../src/main/projectInfo'
import { closingTree, removeTree, whatIsLeft, type ClosingTree } from '../../src/main/sessionClose'

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

  it('names an uncommitted change and a new file, and a commit that is on no remote branch', async () => {
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

  it('a session in the repository itself has no worktree to remove', async () => {
    expect(await closingTree(localGitOut, projectInfoFor(repo))).toBeNull()
  })
})
