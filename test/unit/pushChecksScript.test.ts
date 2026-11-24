import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync, execFileSync, type SpawnSyncReturns } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const script = path.resolve(__dirname, '../../scripts/push-checks.mjs')
const depsStateScript = path.resolve(__dirname, '../../scripts/worktree-deps-state.mjs')
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

function repo({ nodeModules = true } = {}): string {
  const root = tmp('koloft-pushchecks-')
  execFileSync('git', ['init', '-q', root])
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.copyFileSync(script, path.join(root, 'scripts', 'push-checks.mjs'))
  fs.copyFileSync(depsStateScript, path.join(root, 'scripts', 'worktree-deps-state.mjs'))
  if (nodeModules) fs.mkdirSync(path.join(root, 'node_modules'))
  return root
}

function worktreeOf(main: string, { nodeModules = true } = {}): { wt: string; gitDir: string } {
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules\n')
  execFileSync('git', ['-C', main, 'add', '-A'], { env: GIT_ENV })
  execFileSync('git', ['-C', main, 'commit', '-q', '-m', 'fixture'], { env: GIT_ENV })
  const wt = path.join(main, 'wt')
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'wt', wt], { env: GIT_ENV })
  if (nodeModules) fs.mkdirSync(path.join(wt, 'node_modules'))
  return { wt, gitDir: path.join(main, '.git', 'worktrees', 'wt') }
}

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid
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
    `#!/bin/sh\necho "npm $*" >> "${calls}"\npwd -P >> "${calls}.cwd"\ncase "$3" in\n${cases}\nesac\nexit 0\n`,
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

const ALL_CHECKS = [
  'npm run --silent check:agent-imports',
  'npm run --silent check:agent-words',
  'npm run --silent check:comments',
  'npm run --silent format:check',
  'npm run --silent typecheck'
]

describe('push-checks PreToolUse hook', () => {
  it.each([
    'git push',
    'git push -u origin HEAD',
    'git add -A && git commit -m "x" && git push',
    'GIT_TRACE=1 git push',
    'gh pr create --fill-first',
    'gh -R owner/repo pr create',
    'gh pr new --fill',
    'koloft gh pr create --title t'
  ])(
    'runs format:check, check:comments, check:agent-words, check:agent-imports and typecheck before `%s`',
    (command) => {
      const root = repo()
      const { bin, calls } = fakeNpm()
      const r = runHook(root, command, bin)
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(callsIn(calls)).toEqual(ALL_CHECKS)
    }
  )

  it.each([
    'git status',
    'grep -n "git push" AGENTS.md',
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

  it('stops the push when check:comments, check:agent-words, check:agent-imports or typecheck finds problems, a missing import included', () => {
    const root = repo()
    const { bin } = fakeNpm({
      'check:comments': { exit: 1 },
      'check:agent-words': { exit: 1, says: 'check-agent-words: 1 new lines name an agent.' },
      'check:agent-imports': {
        exit: 1,
        says: 'check-agent-imports: 1 new imports cross a boundary around src/agents.'
      },
      typecheck: {
        exit: 2,
        says: "src/a.ts(1,1): error TS2307: Cannot find module './gone' or its corresponding type declarations."
      }
    })
    const r = runHook(root, 'git push', bin)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('`npm run check:comments` failed')
    expect(r.stderr).toContain('`npm run check:agent-words` failed')
    expect(r.stderr).toContain('1 new lines name an agent')
    expect(r.stderr).toContain('`npm run check:agent-imports` failed')
    expect(r.stderr).toContain('1 new imports cross a boundary')
    expect(r.stderr).toContain('`npm run typecheck` failed')
  })

  it('stops the push when Prettier cannot parse a file, as CI would', () => {
    const root = repo()
    const { bin } = fakeNpm({
      'format:check': { exit: 2, says: '[error] a.json: SyntaxError: Unexpected token (1:9)' }
    })
    expect(runHook(root, 'git push', bin).status).toBe(2)
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
    [
      'a check whose tool is not installed yet',
      { exit: 127, says: 'sh: prettier: command not found' }
    ],
    ['a half-installed node_modules', { exit: 1, says: "Error: Cannot find module 'prettier'" }]
  ])('lets the push through on %s', (_, result) => {
    const root = repo()
    const { bin } = fakeNpm({ 'format:check': result })
    const r = runHook(root, 'git push', bin)
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).systemMessage).toMatch(/format:check/)
  })

  it('stops a push while the worktree is still installing its node_modules', () => {
    const { wt, gitDir } = worktreeOf(repo())
    fs.writeFileSync(path.join(gitDir, 'worktree-deps.lock'), String(process.pid))
    const { bin, calls } = fakeNpm()
    const r = runHook(wt, 'git push', bin)
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/still being installed/)
    expect(callsIn(calls)).toEqual([])
  })

  it.each([
    [
      'a failed install',
      (gitDir: string) =>
        fs.writeFileSync(path.join(gitDir, 'worktree-deps.failed'), 'It failed at `npm ci`.')
    ],
    [
      'an install whose process died',
      (gitDir: string) =>
        fs.writeFileSync(path.join(gitDir, 'worktree-deps.lock'), String(deadPid()))
    ],
    [
      'a lock its install stopped refreshing long ago, its pid now another process',
      (gitDir: string) => {
        const lock = path.join(gitDir, 'worktree-deps.lock')
        fs.writeFileSync(lock, String(process.pid))
        const longAgo = new Date(Date.now() - 31 * 60_000)
        fs.utimesSync(lock, longAgo, longAgo)
      }
    ]
  ])(
    'stops every push after %s, node_modules there or not, until the worktree is reinstalled',
    (_, leave) => {
      for (const nodeModules of [false, true]) {
        const { wt, gitDir } = worktreeOf(repo(), { nodeModules })
        leave(gitDir)
        const { bin, calls } = fakeNpm()
        const r = runHook(wt, 'git push', bin)
        expect(r.status).toBe(2)
        expect(r.stderr).toContain('node scripts/worktree-deps.mjs --here')
        expect(r.stderr).not.toContain('CI would fail')
        expect(callsIn(calls)).toEqual([])
      }
    }
  )

  it('runs the checks in the checkout the push runs in, even when the hook came from another one', () => {
    const root = repo()
    const other = repo()
    fs.mkdirSync(path.join(other, 'src'))
    const { bin, calls } = fakeNpm()
    runHook(root, 'git push', bin, { cwd: path.join(other, 'src') })
    expect(new Set(fs.readFileSync(`${calls}.cwd`, 'utf8').trim().split('\n'))).toEqual(
      new Set([other])
    )
  })

  it('does nothing when the push runs in a repository without these checks', () => {
    const root = repo()
    const elsewhere = tmp('koloft-pushchecks-elsewhere-')
    execFileSync('git', ['init', '-q', elsewhere])
    const { bin, calls } = fakeNpm()
    const r = runHook(root, 'git push', bin, { cwd: elsewhere })
    expect(r.status).toBe(0)
    expect(callsIn(calls)).toEqual([])
  })
})
