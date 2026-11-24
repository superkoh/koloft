import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const repoRoot = path.resolve(__dirname, '../..')
const SCRIPTS = [
  'agent-hook.mjs',
  'check-comments.mjs',
  'ledgers.mjs',
  'push-checks.mjs',
  'worktree-deps.mjs',
  'worktree-deps-state.mjs'
]
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

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
}

function fixtureRepo(): string {
  const dir = tmp('koloft-agenthook-')
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', dir], { env: GIT_ENV })
  for (const name of SCRIPTS)
    write(dir, {
      [`scripts/${name}`]: fs.readFileSync(path.join(repoRoot, 'scripts', name), 'utf8')
    })
  write(dir, {
    '.gitignore': 'node_modules\n',
    'docs/adr/README.md': '# ADRs\n',
    'docs/antigravity-cli-contract.md': '# Antigravity\n',
    'docs/claude-code-contract.md': '# CC\n',
    'docs/codex-cli-contract.md': '# Codex\n',
    'docs/platform-contract.md': '# Platform\n'
  })
  execFileSync('git', ['-C', dir, 'add', '-A'], { env: GIT_ENV })
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'fixture'], { env: GIT_ENV })
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'))
  return dir
}

function linkedWorktree(main: string): string {
  const wt = path.join(main, '.claude', 'worktrees', 'w1')
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'w1', wt], { env: GIT_ENV })
  return wt
}

function fakeTools(results: Record<string, number> = {}): { bin: string; calls: string } {
  const bin = tmp('koloft-agenthook-bin-')
  const calls = path.join(bin, 'calls.txt')
  const cases = Object.entries(results)
    .map(([script, exit]) => `  ${script}) echo '${script} broke'; exit ${exit} ;;`)
    .join('\n')
  for (const tool of ['npm', 'node'])
    fs.writeFileSync(
      path.join(bin, tool),
      `#!/bin/sh\necho "${tool} $*" >> "${calls}"\ncase "$3" in\n${cases}\nesac\nexit 0\n`,
      { mode: 0o755 }
    )
  return { bin, calls }
}

function hook(
  root: string,
  agent: 'codex' | 'agy',
  check: string,
  input: object,
  bin: string
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'agent-hook.mjs'), agent, check], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
  })
}

const callsIn = (file: string): string[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []

const codexRun = (root: string, command: string) => ({
  cwd: root,
  tool_name: 'Bash',
  tool_input: { command }
})

const agyRun = (root: string, command: string) => ({
  cwd: root,
  hookEventName: 'PreToolUse',
  toolCall: { name: 'run_command', args: { CommandLine: command, WaitMsBeforeAsync: 5000 } }
})

describe('agent-hook.mjs: Codex and Antigravity hooks run the repo checks', () => {
  it('runs no check for a shell command that cannot push', () => {
    const root = fixtureRepo()
    const { bin, calls } = fakeTools()
    const codex = hook(root, 'codex', 'before-shell-command', codexRun(root, 'ls -la'), bin)
    const agy = hook(root, 'agy', 'before-shell-command', agyRun(root, 'ls -la'), bin)
    expect([codex.status, codex.stdout, agy.status, agy.stdout]).toEqual([0, '', 0, ''])
    expect(callsIn(calls)).toEqual([])
  })

  it('lets the command through, printing nothing, when its own input cannot be read', () => {
    const root = fixtureRepo()
    const r = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'agent-hook.mjs'), 'agy', 'before-shell-command'],
      { input: 'not json', encoding: 'utf8' }
    )
    expect([r.status, r.stdout]).toEqual([0, ''])
  })

  it('stops a Codex push that fails a check, with the reason on stderr', () => {
    const root = fixtureRepo()
    const { bin } = fakeTools({ 'format:check': 1 })
    const r = hook(
      root,
      'codex',
      'before-shell-command',
      codexRun(root, 'git push -u origin HEAD'),
      bin
    )
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('`npm run format:check` failed')
  })

  it('denies an Antigravity push that fails a check with the reason, and lets a passing one through by printing nothing', () => {
    const root = fixtureRepo()
    const failing = hook(
      root,
      'agy',
      'before-shell-command',
      agyRun(root, 'gh pr create --fill'),
      fakeTools({ typecheck: 2 }).bin
    )
    expect(failing.status).toBe(0)
    const denied = JSON.parse(failing.stdout)
    expect(denied.decision).toBe('deny')
    expect(denied.reason).toContain('`npm run typecheck` failed')
    const passing = hook(
      root,
      'agy',
      'before-shell-command',
      agyRun(root, 'git push'),
      fakeTools().bin
    )
    expect([passing.status, passing.stdout]).toEqual([0, ''])
  })

  it('tells Codex about every patched code file that has a comment, a moved one included', () => {
    const root = fixtureRepo()
    write(root, {
      'src/a.ts': '// why this is here\nexport const a = 1\n',
      'src/b.ts': 'export const b = 2\n',
      'src/moved.ts': 'export const c = 3 /* moved here */\n'
    })
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/a.ts',
      '+// why this is here',
      `*** Update File: ${path.join(root, 'src/b.ts')}`,
      '*** Update File: src/old.ts',
      '*** Move to: src/moved.ts',
      '*** End Patch',
      ''
    ].join('\n')
    const r = hook(
      root,
      'codex',
      'after-file-edit',
      {
        cwd: root,
        tool_name: 'apply_patch',
        tool_input: { command: patch }
      },
      fakeTools().bin
    )
    expect(r.status).toBe(0)
    const told = JSON.parse(r.stdout).hookSpecificOutput
    expect(told.hookEventName).toBe('PostToolUse')
    expect(told.additionalContext).toContain('src/a.ts:1')
    expect(told.additionalContext).toContain('src/moved.ts:1')
    expect(told.additionalContext).not.toContain('src/b.ts')
  })

  it('holds an Antigravity edit with a comment until its next model call, and tells it once', () => {
    const root = fixtureRepo()
    const artifacts = tmp('koloft-agenthook-brain-')
    write(root, { 'src/a.ts': 'export const a = 1 // why\n' })
    const { bin } = fakeTools()
    const edit = hook(
      root,
      'agy',
      'after-file-edit',
      {
        cwd: root,
        artifactDirectoryPath: artifacts,
        toolCall: { name: 'write_file', args: { Path: path.join(root, 'src/a.ts'), Content: '' } }
      },
      bin
    )
    expect([edit.status, edit.stdout]).toEqual([0, ''])
    const next = hook(
      root,
      'agy',
      'before-model-call',
      { cwd: root, artifactDirectoryPath: artifacts },
      bin
    )
    const [step] = JSON.parse(next.stdout).injectSteps
    expect(step.ephemeralMessage).toContain('src/a.ts:1')
    const after = hook(
      root,
      'agy',
      'before-model-call',
      { cwd: root, artifactDirectoryPath: artifacts },
      bin
    )
    expect(after.stdout).toBe('')
  })

  it.each([
    ['codex', (said: string) => JSON.parse(said).hookSpecificOutput.additionalContext],
    ['agy', (said: string) => JSON.parse(said).injectSteps[0].systemMessage.systemMessage]
  ] as const)(
    'starts the install of a fresh worktree in the background at a %s session start, and says so',
    async (agent, toldOf) => {
      const root = fixtureRepo()
      const wt = linkedWorktree(root)
      const { bin, calls } = fakeTools()
      const inMain = hook(root, agent, 'session-start', { cwd: root }, bin)
      expect(inMain.stdout).toBe('')
      const r = hook(wt, agent, 'session-start', { cwd: wt }, bin)
      expect(r.status).toBe(0)
      expect(toldOf(r.stdout)).toMatch(/started installing in the background/)
      await expect
        .poll(() => callsIn(calls), { timeout: 10_000 })
        .toContain('node scripts/fetch-vendor.cjs')
      expect(callsIn(calls)[0]).toBe('npm ci')
    }
  )
})
