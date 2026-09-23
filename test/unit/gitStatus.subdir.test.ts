import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { gitDiff, gitNumstat, gitStatus } from '../../src/main/gitStatus'

let tmp: string
let repo: string
let sub: string

const git = (...args: string[]): void => {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gitsubdir-')))
  repo = path.join(tmp, 'work')
  sub = path.join(repo, 'sub')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' })
  git('config', 'user.email', 't@t.com')
  git('config', 'user.name', 't')
  fs.mkdirSync(sub)
  fs.writeFileSync(path.join(repo, 'top.txt'), 'top\n')
  fs.writeFileSync(path.join(sub, 'tracked.txt'), 'tracked\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// PLATFORM§30
describe('gitStatus from a session root below the toplevel', () => {
  it('keys an untracked file under the root at its REAL path, not at a toplevel phantom', async () => {
    fs.writeFileSync(path.join(sub, 'inner.txt'), 'new\n')
    const status = await gitStatus(sub)
    expect(status[path.join(sub, 'inner.txt')]).toBe('untracked')
    expect(status[path.join(repo, 'inner.txt')]).toBeUndefined()
  })

  it('lists an untracked file OUTSIDE the root — the scope every other listing already had', async () => {
    fs.writeFileSync(path.join(repo, 'outer.txt'), 'new\n')
    expect((await gitStatus(sub))[path.join(repo, 'outer.txt')]).toBe('untracked')
  })

  it('agrees with the tracked listings on the same shape — the invariant the join relies on', async () => {
    fs.writeFileSync(path.join(sub, 'tracked.txt'), 'edited\n')
    fs.writeFileSync(path.join(repo, 'top.txt'), 'edited\n')
    fs.writeFileSync(path.join(sub, 'inner.txt'), 'new\n')
    fs.writeFileSync(path.join(repo, 'outer.txt'), 'new\n')
    const status = await gitStatus(sub)
    expect(status).toEqual({
      [path.join(sub, 'tracked.txt')]: 'modified',
      [path.join(repo, 'top.txt')]: 'modified',
      [path.join(sub, 'inner.txt')]: 'untracked',
      [path.join(repo, 'outer.txt')]: 'untracked'
    })
    const numstat = await gitNumstat(sub)
    expect(Object.keys(numstat).sort()).toEqual(
      [path.join(repo, 'top.txt'), path.join(sub, 'tracked.txt')].sort()
    )
    for (const key of Object.keys(numstat)) expect(status[key]).toBe('modified')
  })

  it('hands the aggregate diff back with the toplevel its paths are relative to', async () => {
    fs.writeFileSync(path.join(sub, 'tracked.txt'), 'edited\n')
    const diff = await gitDiff(sub)
    expect(diff.toplevel).toBe(repo)
    expect(diff.text).toContain('+++ b/sub/tracked.txt')
  })

  it('holds on the no-base fallback too (a fresh repo, whose HEAD does not resolve)', async () => {
    const fresh = path.join(tmp, 'fresh')
    const freshSub = path.join(fresh, 'sub')
    execFileSync('git', ['init', '-q', '-b', 'main', fresh], { stdio: 'ignore' })
    fs.mkdirSync(freshSub)
    fs.writeFileSync(path.join(freshSub, 'inner.txt'), 'new\n')
    fs.writeFileSync(path.join(fresh, 'outer.txt'), 'new\n')
    const status = await gitStatus(freshSub)
    expect(status[path.join(freshSub, 'inner.txt')]).toBe('untracked')
    expect(status[path.join(fresh, 'outer.txt')]).toBe('untracked')
    expect(status[path.join(fresh, 'inner.txt')]).toBeUndefined()
  })
})
