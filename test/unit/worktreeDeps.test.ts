import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const repoRoot = path.resolve(__dirname, '../..')
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}
const FOUR_STEPS = [
  'npm ci',
  'npm run rebuild',
  'node node_modules/electron/install.js',
  'node scripts/fetch-vendor.cjs'
]

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  createdDirs.push(dir)
  return dir
}

function worktree({ nodeModules = false } = {}): { main: string; wt: string; gitDir: string } {
  const main = tmp('koloft-deps-')
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', main], { env: GIT_ENV })
  fs.mkdirSync(path.join(main, 'scripts'))
  for (const name of ['worktree-deps.mjs', 'worktree-deps-state.mjs'])
    fs.copyFileSync(path.join(repoRoot, 'scripts', name), path.join(main, 'scripts', name))
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules\n')
  execFileSync('git', ['-C', main, 'add', '-A'], { env: GIT_ENV })
  execFileSync('git', ['-C', main, 'commit', '-q', '-m', 'fixture'], { env: GIT_ENV })
  const wt = path.join(main, 'wt')
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'wt', wt], { env: GIT_ENV })
  if (nodeModules) fs.mkdirSync(path.join(wt, 'node_modules', 'old'), { recursive: true })
  return { main, wt, gitDir: path.join(main, '.git', 'worktrees', 'wt') }
}

function fakeTools(failing?: string): { bin: string; calls: string } {
  const bin = tmp('koloft-deps-bin-')
  const calls = path.join(bin, 'calls.txt')
  for (const tool of ['npm', 'node'])
    fs.writeFileSync(
      path.join(bin, tool),
      `#!/bin/sh\necho "${tool} $*" >> "${calls}"\n[ "${tool} $*" = "${failing ?? ''}" ] && exit 1\n[ "$1" = ci ] && mkdir -p node_modules/fresh\nexit 0\n`,
      { mode: 0o755 }
    )
  return { bin, calls }
}

function install(cwd: string, bin: string, { here = false } = {}): SpawnSyncReturns<string> {
  const args = [path.join(cwd, 'scripts', 'worktree-deps.mjs'), ...(here ? ['--here'] : [])]
  return spawnSync(process.execPath, args, {
    cwd,
    input: here ? '' : JSON.stringify({ cwd }),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
  })
}

const callsIn = (file: string): string[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []

const deadPid = (): number => spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid

describe('worktree-deps.mjs', () => {
  it.each([false, true])(
    'installs a fresh worktree with the four setup steps and leaves no lock or failure behind (--here: %s)',
    (here) => {
      const { wt, gitDir } = worktree()
      const { bin, calls } = fakeTools()
      expect(install(wt, bin, { here }).status).toBe(0)
      expect(callsIn(calls)).toEqual(FOUR_STEPS)
      expect(fs.existsSync(path.join(gitDir, 'worktree-deps.lock'))).toBe(false)
      expect(fs.existsSync(path.join(gitDir, 'worktree-deps.failed'))).toBe(false)
    }
  )

  it('does nothing in the main checkout, or in a worktree that already has node_modules', () => {
    const { main, wt } = worktree({ nodeModules: true })
    const { bin, calls } = fakeTools()
    expect(install(main, bin).status).toBe(0)
    expect(install(wt, bin).status).toBe(0)
    expect(callsIn(calls)).toEqual([])
  })

  it('stops at a failed step, removes node_modules and writes down the failure', () => {
    const { wt, gitDir } = worktree()
    const { bin } = fakeTools('npm run rebuild')
    const r = install(wt, bin)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('failed at `npm run rebuild`')
    expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false)
    expect(fs.readFileSync(path.join(gitDir, 'worktree-deps.failed'), 'utf8')).toContain(
      '`npm run rebuild`'
    )
    expect(fs.existsSync(path.join(gitDir, 'worktree-deps.lock'))).toBe(false)
  })

  it.each([
    [
      'whose last install failed',
      (gitDir: string) => fs.writeFileSync(path.join(gitDir, 'worktree-deps.failed'), 'x')
    ],
    [
      'whose install process died',
      (gitDir: string) =>
        fs.writeFileSync(path.join(gitDir, 'worktree-deps.lock'), String(deadPid()))
    ]
  ])('reinstalls from scratch a worktree %s, though node_modules is there', (_, leave) => {
    const { wt, gitDir } = worktree({ nodeModules: true })
    leave(gitDir)
    const { bin, calls } = fakeTools()
    expect(install(wt, bin).status).toBe(0)
    expect(callsIn(calls)).toEqual(FOUR_STEPS)
    expect(fs.existsSync(path.join(wt, 'node_modules', 'old'))).toBe(false)
    expect(fs.existsSync(path.join(gitDir, 'worktree-deps.failed'))).toBe(false)
  })

  it('leaves the worktree alone while a live install holds the lock', () => {
    const { wt, gitDir } = worktree()
    fs.writeFileSync(path.join(gitDir, 'worktree-deps.lock'), String(process.pid))
    const { bin, calls } = fakeTools()
    expect(install(wt, bin).status).toBe(0)
    expect(callsIn(calls)).toEqual([])
  })
})
