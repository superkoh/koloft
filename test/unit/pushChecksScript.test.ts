import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync, execFileSync, type SpawnSyncReturns } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const script = path.resolve(__dirname, '../../scripts/push-checks.mjs')

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  createdDirs.push(dir)
  return dir
}

function repo({ nodeModules = true } = {}): string {
  const root = tmp('koloft-pushchecks-')
  execFileSync('git', ['init', '-q', root])
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.copyFileSync(script, path.join(root, 'scripts', 'push-checks.mjs'))
  if (nodeModules) fs.mkdirSync(path.join(root, 'node_modules'))
  return root
}

type NpmResult = { exit: number; says?: string }

function fakeNpm(results: Record<string, NpmResult> = {}): { bin: string; calls: string } {
  const bin = tmp('koloft-pushchecks-bin-')
  const calls = path.join(bin, 'calls.txt')
  const cases = Object.entries(results)
    .map(([s, r]) => `  ${s}) echo '${r.says ?? ''}'; exit ${r.exit} ;;`)
    .join('\n')
  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/bin/sh\necho "npm $*" >> "${calls}"\ncase "$3" in\n${cases}\nesac\nexit 0\n`,
    { mode: 0o755 }
  )
  return { bin, calls }
}

function runHook(
  root: string,
  command: string,
  bin: string,
  { cwd = root, PATH = `${bin}:/usr/bin:/bin` } = {}
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'push-checks.mjs')], {
    input: JSON.stringify({ cwd, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, PATH }
  })
}

const callsIn = (file: string): string[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').sort() : []

const ALL_THREE = [
  'npm run --silent check:comments',
  'npm run --silent format:check',
  'npm run --silent typecheck'
]

describe('push-checks PreToolUse hook', () => {
  it.each([
    'git push',
    'git push -u origin HEAD',
    'git add -A && git commit -m "x" && git push',
    'git -C /some/where push',
    'GIT_TRACE=1 git push',
    'gh pr create --fill-first',
    'koloft gh pr create --title t'
  ])('runs format:check, check:comments and typecheck before `%s`', (command) => {
    const root = repo()
    const { bin, calls } = fakeNpm()
    const r = runHook(root, command, bin)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(callsIn(calls)).toEqual(ALL_THREE)
  })

  it.each([
    'git status',
    'grep -n "git push" CLAUDE.md',
    'git commit -m "then git push; done"',
    'gh pr view 12',
    'echo git push'
  ])('lets `%s` through without running anything', (command) => {
    const root = repo()
    const { bin, calls } = fakeNpm()
    expect(runHook(root, command, bin).status).toBe(0)
    expect(callsIn(calls)).toEqual([])
  })

  it('stops the push when format:check finds unformatted files, naming the check and `npm run format`', () => {
    const root = repo()
    const { bin } = fakeNpm({ 'format:check': { exit: 1, says: '[warn] src/a.ts' } })
    const r = runHook(root, 'git push', bin)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('`npm run format:check` failed')
    expect(r.stderr).toContain('npm run format`')
    expect(r.stderr).toContain('[warn] src/a.ts')
  })

  it('stops the push when check:comments or typecheck finds problems', () => {
    const root = repo()
    const { bin } = fakeNpm({ 'check:comments': { exit: 1 }, typecheck: { exit: 2 } })
    const r = runHook(root, 'git push', bin)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('`npm run check:comments` failed')
    expect(r.stderr).toContain('`npm run typecheck` failed')
  })

  it('lets the push through with one line when the checkout has no node_modules yet', () => {
    const root = repo({ nodeModules: false })
    const { bin, calls } = fakeNpm()
    const r = runHook(root, 'git push', bin)
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/no node_modules/)
    expect(callsIn(calls)).toEqual([])
  })

  it('lets the push through when npm cannot be started', () => {
    const root = repo()
    const noNpm = tmp('koloft-pushchecks-nonpm-')
    fs.symlinkSync('/usr/bin/git', path.join(noNpm, 'git'))
    const r = runHook(root, 'git push', noNpm, { PATH: noNpm })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/could not start/)
  })

  it.each([
    ['a check that broke instead of checking', { exit: 2, says: '[error] boom' }],
    ['a half-installed node_modules', { exit: 1, says: "Error: Cannot find module 'prettier'" }]
  ])('lets the push through on %s', (_, result) => {
    const root = repo()
    const { bin } = fakeNpm({ 'format:check': result })
    const r = runHook(root, 'git push', bin)
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/format:check/)
  })

  it('does nothing when the push runs in another checkout', () => {
    const root = repo()
    const other = repo()
    const { bin, calls } = fakeNpm()
    const r = runHook(root, 'git push', bin, { cwd: other })
    expect(r.status).toBe(0)
    expect(callsIn(calls)).toEqual([])
  })
})
