import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { addPrWorktree, commitAll, pushBranch, type GitRun } from '../../src/main/gitSteps'
import { localGitRun } from '../../src/main/host/localHost'

const ID = ['-c', 'user.email=unit@koloft.test', '-c', 'user.name=koloft-unit']

let origin: string
let repo: string
let run: GitRun

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', [...ID, ...args], { cwd: dir, encoding: 'utf8' }).trim()
}

beforeEach(() => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-steps-')))
  origin = path.join(tmp, 'origin.git')
  repo = path.join(tmp, 'repo')
  git(tmp, 'init', '-q', '--bare', origin)
  git(tmp, 'init', '-q', '-b', 'main', repo)
  git(repo, 'config', 'user.email', 'unit@koloft.test')
  git(repo, 'config', 'user.name', 'koloft-unit')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'switch', '-q', '-c', 'feature/login')
  run = (args, network) => localGitRun(repo, args, network)
})

describe('Commit…', () => {
  it('commits every change in the checkout, new and deleted files included, under the typed message', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n')
    expect(await commitAll(run, '  Fix the login form  ')).toEqual({ ok: true })
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Fix the login form')
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'a.txt',
      'new.txt'
    ])
  })

  it('refuses an empty message without touching git', async () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n')
    expect(await commitAll(run, '   ')).toEqual({
      ok: false,
      reason: 'Write a commit message first.'
    })
    expect(git(repo, 'status', '--porcelain')).toBe('?? new.txt')
  })

  it("says git's own words when there is nothing to commit", async () => {
    expect(await commitAll(run, 'nothing here')).toEqual({
      ok: false,
      reason: 'nothing to commit, working tree clean'
    })
  })
})

describe('a worktree for a pull request', () => {
  const branchOf = (dir: string): string => git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')

  it('checks out a branch this repo already has into .claude/worktrees/pr-<n>, fetching nothing', async () => {
    git(repo, 'branch', 'fix/login-copy')
    git(repo, 'remote', 'set-url', 'origin', path.join(path.dirname(origin), 'missing.git'))
    const r = await addPrWorktree(run, 7, 'fix/login-copy')
    const dir = path.join(repo, '.claude', 'worktrees', 'pr-7')
    expect(r).toEqual({ ok: true, dir })
    expect(branchOf(dir)).toBe('fix/login-copy')
  })

  it("fetches the pull request's head into its branch when this repo does not have the branch", async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'from the pull request\n')
    git(repo, 'commit', '-q', '-am', 'pr work')
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/pull/9/head')
    const prHead = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'reset', '-q', '--hard', 'HEAD~1')
    const r = await addPrWorktree(run, 9, 'someone/feature')
    expect(r.ok).toBe(true)
    const dir = path.join(repo, '.claude', 'worktrees', 'pr-9')
    expect(branchOf(dir)).toBe('someone/feature')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(prHead)
  })

  it("names git's error and makes no worktree when GitHub has no such pull request", async () => {
    const r = await addPrWorktree(run, 404, 'gone/branch')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/pull\/404\/head/)
    expect(fs.existsSync(path.join(repo, '.claude', 'worktrees', 'pr-404'))).toBe(false)
  })
})

describe('Push', () => {
  it('pushes the branch to origin under its own name and sets it as the upstream', async () => {
    expect(await pushBranch(run)).toEqual({ ok: true })
    expect(git(origin, 'rev-parse', 'refs/heads/feature/login')).toBe(
      git(repo, 'rev-parse', 'HEAD')
    )
    expect(git(repo, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feature/login')
    expect(await pushBranch(run)).toEqual({ ok: true })
  })

  it("names git's error when origin refuses", async () => {
    git(repo, 'remote', 'set-url', 'origin', path.join(path.dirname(origin), 'missing.git'))
    const r = await pushBranch(run)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/^fatal: /)
  })
})
