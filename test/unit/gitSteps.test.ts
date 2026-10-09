import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { commitAll, pushBranch, type GitRun } from '../../src/main/gitSteps'
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
