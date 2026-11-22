import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync, execFileSync, type SpawnSyncReturns } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const script = path.resolve(__dirname, '../../scripts/worktree-deps.mjs')

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  createdDirs.push(dir)
  return dir
}

function repoWithWorktree(): { main: string; worktree: string } {
  const main = tmp('koloft-wtdeps-')
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', main], { env: GIT_ENV })
  execFileSync('git', ['-C', main, 'commit', '-q', '--allow-empty', '-m', 'init'], { env: GIT_ENV })
  const worktree = path.join(main, 'wt')
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'wt', worktree], { env: GIT_ENV })
  return { main, worktree }
}

function fakeBins(failingNpmArg?: string): { bin: string; calls: string } {
  const bin = tmp('koloft-wtdeps-bin-')
  const calls = path.join(bin, 'calls.txt')
  const npmFails = failingNpmArg ? `[ "$1" = "${failingNpmArg}" ] && exit 1\n` : ''
  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/bin/sh\necho "npm $*" >> "${calls}"\n[ "$1" = ci ] && mkdir node_modules\n${npmFails}exit 0\n`,
    { mode: 0o755 }
  )
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "node $*" >> "${calls}"\nexit 0\n`, {
    mode: 0o755
  })
  return { bin, calls }
}

function runHook(cwd: string, bin: string, { here = false } = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script, ...(here ? ['--here'] : [])], {
    cwd,
    input: here ? '' : JSON.stringify({ cwd }),
    encoding: 'utf8',
    env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` }
  })
}

const gitDirOf = (main: string): string => path.join(main, '.git', 'worktrees', 'wt')
const deadPid = (): number => spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid

const callsIn = (file: string): string[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []

describe('worktree-deps SessionStart hook', () => {
  it('installs, rebuilds, fetches Electron and then the shipped git and gh, in that order, in a linked worktree with no node_modules', () => {
    const { worktree } = repoWithWorktree()
    const { bin, calls } = fakeBins()
    const r = runHook(worktree, bin)
    expect(r.status).toBe(0)
    expect(callsIn(calls)).toEqual([
      'npm ci',
      'npm run rebuild',
      'node node_modules/electron/install.js',
      'node scripts/fetch-vendor.cjs'
    ])
  })

  it('does nothing in the main checkout', () => {
    const { main } = repoWithWorktree()
    const { bin, calls } = fakeBins()
    expect(runHook(main, bin).status).toBe(0)
    expect(callsIn(calls)).toEqual([])
  })

  it('does nothing in a worktree that already has node_modules', () => {
    const { worktree } = repoWithWorktree()
    fs.mkdirSync(path.join(worktree, 'node_modules'))
    const { bin, calls } = fakeBins()
    expect(runHook(worktree, bin).status).toBe(0)
    expect(callsIn(calls)).toEqual([])
  })

  it('a failed step exits 2 naming that step, so Claude is woken, and runs nothing after it', () => {
    const { worktree } = repoWithWorktree()
    const { bin, calls } = fakeBins('run')
    const r = runHook(worktree, bin)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('`npm run rebuild`')
    expect(callsIn(calls)).toEqual(['npm ci', 'npm run rebuild'])
  })

  it('a failed step leaves no half-installed node_modules, so the next session start retries', () => {
    const { worktree } = repoWithWorktree()
    const { bin, calls } = fakeBins('run')
    runHook(worktree, bin)
    expect(fs.existsSync(path.join(worktree, 'node_modules'))).toBe(false)
    runHook(worktree, bin)
    expect(callsIn(calls).filter((c) => c === 'npm ci')).toHaveLength(2)
  })

  it('installs the folder it is run in with --here, and leaves no lock behind', () => {
    const { main, worktree } = repoWithWorktree()
    const { bin, calls } = fakeBins()
    expect(runHook(worktree, bin, { here: true }).status).toBe(0)
    expect(callsIn(calls)[0]).toBe('npm ci')
    expect(fs.existsSync(path.join(gitDirOf(main), 'worktree-deps.lock'))).toBe(false)
  })

  it('writes a failed step down, so every agent learns of it at its next push', () => {
    const { main, worktree } = repoWithWorktree()
    runHook(worktree, fakeBins('run').bin)
    expect(fs.readFileSync(path.join(gitDirOf(main), 'worktree-deps.failed'), 'utf8')).toContain(
      '`npm run rebuild`'
    )
    expect(fs.existsSync(path.join(gitDirOf(main), 'worktree-deps.lock'))).toBe(false)
    runHook(worktree, fakeBins().bin)
    expect(fs.existsSync(path.join(gitDirOf(main), 'worktree-deps.failed'))).toBe(false)
  })

  it.each([
    ['whose last install failed', 'worktree-deps.failed', () => 'It failed.'],
    ['whose install process died', 'worktree-deps.lock', () => String(deadPid())]
  ])('reinstalls from scratch a worktree %s, though node_modules is there', (_, file, text) => {
    const { main, worktree } = repoWithWorktree()
    fs.mkdirSync(path.join(worktree, 'node_modules', 'old'), { recursive: true })
    fs.writeFileSync(path.join(gitDirOf(main), file), text())
    const { bin, calls } = fakeBins()
    expect(runHook(worktree, bin).status).toBe(0)
    expect(callsIn(calls)[0]).toBe('npm ci')
    expect(fs.existsSync(path.join(worktree, 'node_modules', 'old'))).toBe(false)
  })

  it('leaves the worktree alone while a live install holds the lock', () => {
    const { main, worktree } = repoWithWorktree()
    fs.writeFileSync(path.join(gitDirOf(main), 'worktree-deps.lock'), String(process.pid))
    const { bin, calls } = fakeBins()
    expect(runHook(worktree, bin).status).toBe(0)
    expect(callsIn(calls)).toEqual([])
  })
})
