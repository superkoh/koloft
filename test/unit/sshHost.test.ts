import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawn, spawnSync } from 'child_process'
import { machineClaudeArgs, SshHost } from '../../src/main/host/sshHost'
import { diffBase as localDiffBase } from '../../src/main/gitStatus'
import { utilClaudeGuard } from '../../src/main/remote/install'
import { UTIL_TERMINAL_REFUSES_INTERACTIVE_CLAUDE } from '../../src/main/shim'
import type { BytesResult } from '../../src/main/remote/ssh'

const MACHINE = 'devbox'
let home: string
let repo: string

function runOnMachine(cmd: string, opts?: { input?: Buffer }): Promise<BytesResult> {
  return new Promise((resolve) => {
    const c = spawn('/bin/sh', ['-c', cmd], {
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    let err = ''
    c.stdout.on('data', (d: Buffer) => out.push(d))
    c.stderr.on('data', (d: Buffer) => (err += String(d)))
    c.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }))
    c.stdin.end(opts?.input)
  })
}

const machine = (): SshHost =>
  new SshHost(MACHINE, {
    run: runOnMachine,
    shell: () => ({ spawnCwd: '/' }),
    github: {},
    claude: {
      userData: home,
      controlDir: home,
      machinePackage: () => ({ dir: home, name: 'm-0000000000000000' }),
      alive: () => new Set(),
      realPath: (p) => p,
      settings: () => ({ multiAccount: false, skipPermissions: false }),
      pickAccount: async () => undefined,
      hookSettings: () => ({})
    }
  })

const keyed = (p: string): string => `ssh://${MACHINE}${p}`

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-sshhost-')))
  repo = path.join(home, 'proj')
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'build'))
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  fs.writeFileSync(path.join(repo, 'sub', 'b.txt'), 'hello again\n')
  fs.writeFileSync(path.join(repo, 'build', 'out.o'), 'x')
  fs.writeFileSync(path.join(repo, '.gitignore'), 'build\n')
  git('init', '-q')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  fs.symlinkSync('nowhere', path.join(repo, 'broken'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('a remote session’s Workbench reads and writes the machine’s files over ssh', () => {
  it('lists a folder with every path keyed by the machine, hiding git-ignored and heavy entries and broken links', async () => {
    const entries = await machine().listDir(keyed(repo))
    expect(entries.map((e) => e.name)).toEqual(['sub', '.gitignore', 'a.txt'])
    expect(entries[0]).toEqual({ name: 'sub', path: keyed(path.join(repo, 'sub')), isDir: true })

    const all = await machine().listDir(keyed(repo), { showIgnored: true })
    expect(all.filter((e) => e.ignored).map((e) => e.name)).toEqual(['.git', 'build'])
  })

  it('finds files by name and text on the machine, keyed by the machine', async () => {
    const byName = await machine().search(keyed(repo), 'b.txt')
    expect(byName.hits.map((h) => h.path)).toEqual([keyed(path.join(repo, 'sub', 'b.txt'))])

    const byText = await machine().searchContent(keyed(repo), 'hello')
    expect(byText.hits.map((h) => [h.rel, h.line])).toEqual([
      ['a.txt', 1],
      ['sub/b.txt', 1]
    ])
    expect(byText.hits[0].path).toBe(keyed(path.join(repo, 'a.txt')))
  })

  it('reports Changes with the machine’s paths, so the renderer can hand them straight back', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\nmore\n')
    fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n')
    const status = await machine().gitStatus(keyed(repo))
    expect(status).toEqual({
      [keyed(path.join(repo, 'a.txt'))]: 'modified',
      [keyed(path.join(repo, 'broken'))]: 'untracked',
      [keyed(path.join(repo, 'new.txt'))]: 'untracked'
    })
    const diff = await machine().gitFileDiff(keyed(path.join(repo, 'a.txt')))
    expect(diff.text).toContain('+more')
    expect((await machine().gitDiff(keyed(repo))).toplevel).toBe(keyed(repo))
  })

  it('diffs a branch against where it left main, the same base the local Workbench picks', async () => {
    git('branch', '-M', 'main')
    const forkPoint = git('rev-parse', 'HEAD').trim()
    git('checkout', '-qb', 'feature')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'more', '--allow-empty')
    expect(await machine().diffBase(keyed(repo))).toBe(forkPoint)
    expect(await localDiffBase(repo)).toBe(forkPoint)
  })

  it('refuses a save when the file changed on the machine since it was opened, and saves when it did not', async () => {
    const file = keyed(path.join(repo, 'a.txt'))
    const opened = await machine().openForEdit(file)
    expect(opened.text).toBe('hello\n')
    expect(opened.readOnly).toBeNull()

    const stale = await machine().writeText(file, 'mine\n', { mtimeMs: 1, size: opened.size })
    expect(stale).toMatchObject({ ok: false, code: 'stale', text: 'hello\n' })
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('hello\n')

    const saved = await machine().writeText(file, 'mine\n', opened)
    expect(saved).toMatchObject({ ok: true, size: 5 })
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('mine\n')
    expect(fs.readdirSync(repo).filter((n) => n.includes('koloft-tmp'))).toEqual([])
  })

  it('creates a new file on the machine but never over one that is there', async () => {
    const created = await machine().createFile(keyed(repo), 'fresh.md')
    expect(created.path).toBe(keyed(path.join(repo, 'fresh.md')))
    expect(fs.existsSync(path.join(repo, 'fresh.md'))).toBe(true)
    await expect(machine().createFile(keyed(repo), 'a.txt')).rejects.toThrow('KOLOFT_EXISTS')
    await expect(machine().openForEdit(keyed(path.join(repo, 'gone')))).rejects.toThrow(
      'KOLOFT_GONE'
    )
  })
})

describe("Claude's folder trust on the machine", () => {
  // CC§9 ADR-0026
  it("trusts a folder in the machine's .claude.json under its real path, keeping what the file had, and reads a folder under it back as trusted", async () => {
    const node = path.join(home, '.koloft', 'node', 'bin')
    fs.mkdirSync(node, { recursive: true })
    fs.symlinkSync(process.execPath, path.join(node, 'node'))
    fs.writeFileSync(path.join(home, '.claude.json'), '{"numStartups":3}\n')
    expect(await machine().trustsFolder(keyed(repo))).toBe(false)

    await machine().trustFolder(keyed(repo))

    expect(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))).toEqual({
      numStartups: 3,
      projects: { [repo]: { hasTrustDialogAccepted: true } }
    })
    expect(await machine().trustsFolder(keyed(path.join(repo, 'sub')))).toBe(true)
  })
})

describe('what a remote launch hands claude', () => {
  const root = keyed('/w')

  // CC§9
  it('carries the model, effort, permission, name and first prompt a local launch carries', () => {
    expect(
      machineClaudeArgs(
        {
          root,
          worktree: 'nightly-1',
          model: 'sonnet',
          effort: 'high',
          permission: 'acceptEdits',
          name: 'Nightly report',
          firstPrompt: '/daily-report'
        },
        'sid1',
        true
      )
    ).toEqual({
      ok: true,
      args: [
        '--session-id',
        'sid1',
        '-w',
        'nightly-1',
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--permission-mode',
        'acceptEdits',
        '--name',
        'Nightly report',
        '--',
        '/daily-report'
      ]
    })
  })

  it('asks as a session you start does when the job keeps the usual permission, and a resume carries no name or prompt', () => {
    expect(machineClaudeArgs({ root, permission: 'default' }, 'sid1', true)).toEqual({
      ok: true,
      args: ['--session-id', 'sid1', '--dangerously-skip-permissions']
    })
    expect(machineClaudeArgs({ root, permission: 'default' }, 'sid1', false)).toEqual({
      ok: true,
      args: ['--session-id', 'sid1']
    })
    expect(
      machineClaudeArgs(
        { root, resumeSessionId: 'old1', name: 'n', firstPrompt: 'x' },
        'sid1',
        false
      )
    ).toEqual({ ok: true, args: ['--resume', 'old1'] })
  })
})

describe('the utility terminal on the machine', () => {
  function guardOnPath(): { bin: string; realLog: string } {
    const guardDir = path.join(home, 'util-bin')
    const realDir = path.join(home, 'real-bin')
    fs.mkdirSync(guardDir)
    fs.mkdirSync(realDir)
    fs.writeFileSync(
      path.join(guardDir, 'claude'),
      utilClaudeGuard(UTIL_TERMINAL_REFUSES_INTERACTIVE_CLAUDE),
      { mode: 0o755 }
    )
    const realLog = path.join(home, 'real.log')
    fs.writeFileSync(
      path.join(realDir, 'claude'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(realLog)}\n`,
      { mode: 0o755 }
    )
    return { bin: `${guardDir}:${realDir}:/usr/bin:/bin`, realLog }
  }

  it('refuses an interactive claude, and hands -p through to the real claude', () => {
    const { bin, realLog } = guardOnPath()
    const env = { HOME: home, PATH: bin, KOLOFT_UTIL: '1' }
    const interactive = spawnSync('claude', [], { env, encoding: 'utf8' })
    expect(interactive.status).toBe(1)
    expect(interactive.stderr).toContain('not an agent surface')
    expect(fs.existsSync(realLog)).toBe(false)

    const printed = spawnSync('claude', ['-p', 'hi there'], { env, encoding: 'utf8' })
    expect(printed.status).toBe(0)
    expect(fs.readFileSync(realLog, 'utf8')).toBe('-p hi there\n')
  })
})
