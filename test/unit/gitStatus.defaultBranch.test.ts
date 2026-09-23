import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { defaultBranch } from '../../src/main/gitStatus'

// The 5s budget on defaultBranch belongs to the freshness engine, which reaches the
// network on a timer. With no caller timeout the module's own cap (GIT_TIMEOUT_MS, 30s)
// applies instead — still far above that budget, so a cold, huge repo's metadata read is
// not lost, and losing the base would silently drop every tree decoration. So the budget
// is the CALLER's to set, and the case below is what pins the cap well above 5s.

let tmp: string
let repo: string
let realPath: string

/** a `git` shim earlier on PATH that sleeps before delegating, so a caller's timeout
 *  (or absence of one) is the only thing that decides the outcome */
function slowGitOnPath(sleepSecs: string): void {
  const dir = path.join(tmp, 'slowbin')
  fs.mkdirSync(dir, { recursive: true })
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nsleep ${sleepSecs}\nexec '${real}' "$@"\n`, {
    mode: 0o755
  })
  process.env.PATH = `${dir}:${realPath}`
}

beforeEach(() => {
  realPath = process.env.PATH ?? ''
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-defbranch-')))
  const seed = path.join(tmp, 'seed')
  execFileSync('git', ['init', '-q', '-b', 'main', seed])
  execFileSync('git', ['-C', seed, 'config', 'user.email', 't@t.com'])
  execFileSync('git', ['-C', seed, 'config', 'user.name', 't'])
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n')
  execFileSync('git', ['-C', seed, 'add', 'a.txt'])
  execFileSync('git', ['-C', seed, 'commit', '-q', '-m', 'a'])
  const origin = path.join(tmp, 'origin.git')
  execFileSync('git', ['clone', '-q', '--bare', seed, origin])
  repo = path.join(tmp, 'work')
  execFileSync('git', ['clone', '-q', origin, repo])
})

afterEach(() => {
  process.env.PATH = realPath
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('defaultBranch timeout budget', () => {
  it('resolves the ref with no caller timeout even when git is slower than 5s', async () => {
    slowGitOnPath('5.5')
    expect(await defaultBranch(repo)).toBe('origin/main')
  }, 30_000)

  it('fails when the caller sets a timeout git cannot meet, rather than trying the next name', async () => {
    slowGitOnPath('0.4')
    await expect(defaultBranch(repo, { timeoutMs: 100 })).rejects.toThrow()
  }, 30_000)

  it('still resolves under a caller timeout git can meet', async () => {
    expect(await defaultBranch(repo, { timeoutMs: 5_000 })).toBe('origin/main')
  })
})
