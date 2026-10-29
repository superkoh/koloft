import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawn, spawnSync } from 'child_process'
import { machineClaudeArgs, SshHost, type MachineClaudeDeps } from '../../src/main/host/sshHost'
import { killSessionCmd } from '../../src/main/remote/launch'
import { tabPackageDir } from '../../src/main/remote/paths'
import { diffBase as localDiffBase } from '../../src/main/gitStatus'
import { localHost } from '../../src/main/host/localHost'
import { GithubLookup } from '../../src/main/github'
import { utilTerminalGuard } from '../../src/main/shim'
import type { BytesResult } from '../../src/main/remote/ssh'
import { AccountPicker, type LaunchedSession } from '../../src/main/accountPicker'
import { meta, NOW_MS, NOW_S, usage } from './helpers/accounts'
import { NO_USABLE_ACCOUNT } from '../../src/shared/accountUsage'
import { barePath } from '../../src/shared/remoteKey'
import { removeTree } from '../../src/main/sessionClose'

const MACHINE = 'devbox'
let home: string
let repo: string

let loginShell = '/bin/sh'

function runOnMachine(cmd: string, opts?: { input?: Buffer }): Promise<BytesResult> {
  return new Promise((resolve) => {
    const c = spawn(loginShell, ['-c', cmd], {
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    let err = ''
    c.stdout.on('data', (d: Buffer) => out.push(d))
    c.stderr.on('data', (d: Buffer) => (err += String(d)))
    c.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }))
    c.stdin.on('error', () => {})
    c.stdin.end(opts?.input)
  })
}

const machine = (run = runOnMachine, claude: Partial<MachineClaudeDeps> = {}): SshHost =>
  new SshHost(MACHINE, {
    run,
    shell: () => ({ spawnCwd: '/' }),
    watch: () => {},
    unwatch: () => {},
    github: {},
    claude: {
      userData: home,
      controlDir: home,
      machinePackage: () => ({ dir: home, name: 'm-0000000000000000' }),
      alive: () => new Set(),
      firstHeartbeatDone: async () => {},
      realPath: (p) => p,
      settings: () => ({ skipPermissions: false }),
      agentTools: () => true,
      pickAccount: async () => ({ env: {}, banner: '' }),
      hookSettings: () => ({}),
      ...claude
    }
  })

const keyed = (p: string): string => `ssh://${MACHINE}${p}`

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

const putNodeOnMachine = (): void => {
  const node = path.join(home, '.koloft', 'node', 'bin')
  fs.mkdirSync(node, { recursive: true })
  fs.symlinkSync(process.execPath, path.join(node, 'node'))
}

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

// PLATFORM§37
describe.each(['/bin/sh', '/bin/tcsh'])(
  'a remote session’s Workbench reads and writes the machine’s files over ssh, when the login shell there is %s',
  (shell) => {
    beforeEach(() => (loginShell = shell))
    afterEach(() => (loginShell = '/bin/sh'))

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
      const byRel = [...byText.hits].sort((x, y) => x.rel.localeCompare(y.rel))
      expect(byRel.map((h) => [h.rel, h.line])).toEqual([
        ['a.txt', 1],
        ['sub/b.txt', 1]
      ])
      expect(byRel[0].path).toBe(keyed(path.join(repo, 'a.txt')))
    })

    it('reports Changes with the machine’s paths, so the renderer can hand them straight back', async () => {
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\nmore\n')
      fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n')
      const changes = await machine().gitChanges(keyed(repo), 'merge-base')
      expect(changes).toEqual({
        base: git('rev-parse', 'HEAD').trim(),
        status: {
          [keyed(path.join(repo, 'a.txt'))]: 'modified',
          [keyed(path.join(repo, 'broken'))]: 'untracked',
          [keyed(path.join(repo, 'new.txt'))]: 'untracked'
        },
        numstat: { [keyed(path.join(repo, 'a.txt'))]: { added: 1, removed: 0 } },
        missing: false
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
      expect((await machine().gitChanges(keyed(repo), 'merge-base')).base).toBe(forkPoint)
      expect(await localDiffBase(repo)).toBe(forkPoint)
    })

    it('lists the same Changes as the local Workbench for one checkout: renamed, deleted, staged, against the fork point or HEAD', async () => {
      git('branch', '-M', 'main')
      git('checkout', '-qb', 'feature')
      fs.writeFileSync(path.join(repo, 'branch.txt'), 'on the branch\n')
      git('add', '-A')
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'branch work')
      git('mv', 'a.txt', 'renamed.txt')
      fs.rmSync(path.join(repo, 'sub', 'b.txt'))
      fs.writeFileSync(path.join(repo, 'staged.txt'), 'one\ntwo\n')
      git('add', 'staged.txt')
      fs.writeFileSync(path.join(repo, 'loose.txt'), 'x\n')
      const local = localHost(new GithubLookup({}), {} as never)
      const bareKeys = <V>(m: Record<string, V>): Record<string, V> =>
        Object.fromEntries(Object.entries(m).map(([k, v]) => [barePath(k), v]))
      for (const choice of ['merge-base', 'head'] as const) {
        const remote = await machine().gitChanges(keyed(repo), choice)
        const here = await local.gitChanges(repo, choice)
        expect({
          ...remote,
          status: bareKeys(remote.status),
          numstat: bareKeys(remote.numstat)
        }).toEqual(here)
      }
      expect(Object.keys((await local.gitChanges(repo, 'merge-base')).status).sort()).toEqual(
        ['branch.txt', 'broken', 'loose.txt', 'renamed.txt', 'staged.txt', 'sub/b.txt'].map((r) =>
          path.join(repo, r)
        )
      )
    })

    it('says the workspace folder is missing when the machine says it is gone, and empty outside a repo', async () => {
      expect(await machine().gitChanges(keyed(path.join(repo, 'gone')), 'merge-base')).toEqual({
        base: null,
        status: {},
        numstat: {},
        missing: true
      })
      fs.rmSync(path.join(repo, '.git'), { recursive: true })
      expect(await machine().gitChanges(keyed(repo), 'merge-base')).toEqual({
        base: null,
        status: {},
        numstat: {},
        missing: false
      })
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

    it('"Keep mine" overwrites a file that changed on the machine since it was opened', async () => {
      const file = keyed(path.join(repo, 'a.txt'))
      const opened = await machine().openForEdit(file)
      fs.writeFileSync(path.join(repo, 'a.txt'), 'theirs, longer\n')

      const kept = await machine().writeText(file, 'mine\n', opened, { force: true })
      expect(kept).toMatchObject({ ok: true, size: 5 })
      expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('mine\n')
    })

    it('a change that lands on the machine between the check and the write is refused, not overwritten', async () => {
      const file = keyed(path.join(repo, 'a.txt'))
      const opened = await machine().openForEdit(file)
      const otherWriterJustBeforeTheWrite = (
        cmd: string,
        opts?: { input?: Buffer }
      ): Promise<BytesResult> => {
        if (opts?.input) fs.writeFileSync(path.join(repo, 'a.txt'), 'theirs, longer\n')
        return runOnMachine(cmd, opts)
      }

      const result = await machine(otherWriterJustBeforeTheWrite).writeText(file, 'mine\n', opened)
      expect(result).toMatchObject({ ok: false, code: 'stale', text: 'theirs, longer\n' })
      expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('theirs, longer\n')
      expect(fs.readdirSync(repo).filter((n) => n.includes('koloft-tmp'))).toEqual([])
    })

    it('a save says why it failed: no permission in the folder, the file gone, or its folder gone', async () => {
      const file = keyed(path.join(repo, 'sub', 'b.txt'))
      const opened = await machine().openForEdit(file)

      fs.chmodSync(path.join(repo, 'sub'), 0o555)
      try {
        await expect(machine().writeText(file, 'mine\n', opened, { force: true })).rejects.toThrow(
          'KOLOFT_NO_PERM'
        )
      } finally {
        fs.chmodSync(path.join(repo, 'sub'), 0o755)
      }

      fs.rmSync(path.join(repo, 'sub', 'b.txt'))
      await expect(machine().writeText(file, 'mine\n', opened)).rejects.toThrow('KOLOFT_GONE')
      fs.rmSync(path.join(repo, 'sub'), { recursive: true })
      await expect(machine().writeText(file, 'mine\n', opened)).rejects.toThrow('KOLOFT_DIR_GONE')
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

    // CC§9 ADR-0026
    it("trusts a folder in the machine's .claude.json under its real path, keeping what the file had, and reads a folder under it back as trusted", async () => {
      putNodeOnMachine()
      fs.writeFileSync(path.join(home, '.claude.json'), '{"numStartups":3}\n')
      expect(await machine().trustsFolder(keyed(repo))).toBe(false)

      await machine().trustFolder(keyed(repo))

      expect(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))).toEqual({
        numStartups: 3,
        projects: { [repo]: { hasTrustDialogAccepted: true } }
      })
      expect(await machine().trustsFolder(keyed(path.join(repo, 'sub')))).toBe(true)
    })

    // CC§9
    it("stops looking up at the top of the machine's git repo: a repo in a trusted folder is not trusted, a worktree of a trusted repo is", async () => {
      putNodeOnMachine()
      fs.mkdirSync(path.join(home, 'plain'))
      const claudeJson = path.join(home, '.claude.json')
      fs.writeFileSync(
        claudeJson,
        JSON.stringify({ projects: { [home]: { hasTrustDialogAccepted: true } } })
      )

      expect(await machine().trustsFolder(keyed(path.join(home, 'plain')))).toBe(true)
      expect(await machine().trustsFolder(keyed(path.join(repo, 'sub')))).toBe(false)
      await machine().trustFolder(keyed(repo))
      expect(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[repo]).toEqual({
        hasTrustDialogAccepted: true
      })

      fs.writeFileSync(
        claudeJson,
        JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } })
      )
      git('worktree', 'add', '-q', '-b', 'worktree-w', path.join(repo, '.claude', 'worktrees', 'w'))
      expect(
        await machine().trustsFolder(keyed(path.join(repo, '.claude', 'worktrees', 'w')))
      ).toBe(true)
    })

    // CC§9
    it('on the machine too, a submodule or a worktree whose main repo is gone, under a trusted repo, is not trusted: a .git file with no readable commondir is its own top', async () => {
      putNodeOnMachine()
      const submodule = path.join(repo, 'sub')
      fs.mkdirSync(path.join(repo, '.git', 'modules', 'sub'), { recursive: true })
      fs.mkdirSync(submodule, { recursive: true })
      fs.writeFileSync(path.join(submodule, '.git'), 'gitdir: ../.git/modules/sub\n')
      const orphan = path.join(repo, 'orphan')
      fs.mkdirSync(orphan)
      fs.writeFileSync(path.join(orphan, '.git'), `gitdir: ${path.join(home, 'gone', '.git')}\n`)
      fs.writeFileSync(
        path.join(home, '.claude.json'),
        JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } })
      )

      expect(await machine().trustsFolder(keyed(submodule))).toBe(false)
      expect(await machine().trustsFolder(keyed(orphan))).toBe(false)
    })

    it("offers the machine's skills to a scheduled task: the workspace's, then the machine home's (BB-M16)", async () => {
      const put = (file: string, text: string): void => {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, text)
      }
      put(
        path.join(repo, '.claude', 'skills', 'ship', 'SKILL.md'),
        '---\ndescription: Ship it\n---'
      )
      put(path.join(repo, '.claude', 'commands', 'build.md'), '# build')
      put(path.join(home, '.claude', 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy-up\n---')
      put(path.join(home, '.claude', 'skills', 'ship', 'SKILL.md'), '---\nname: ship\n---')

      expect(await machine().listSkills(keyed(repo))).toEqual([
        { name: '/ship', description: 'Ship it', source: 'project' },
        { name: '/build', source: 'project' },
        { name: '/tidy-up', source: 'home' }
      ])
    })

    it('answers a koloft request on the machine: the reply lands whole beside it and the request goes, while a request whose command already gave up gets no reply', async () => {
      const hookDir = path.join(home, '.koloft', 'hook-sessions')
      fs.mkdirSync(hookDir, { recursive: true })
      fs.writeFileSync(path.join(hookDir, 'req-r1.json'), '{}')
      const reply = '{"exit":0,"text":"it\'s \\"done\\""}'

      await machine().answerAgent('r1', reply)
      await machine().answerAgent('r2', reply)

      expect(fs.readdirSync(hookDir)).toEqual(['res-r1.json'])
      expect(fs.readFileSync(path.join(hookDir, 'res-r1.json'), 'utf8')).toBe(reply)
    })

    it('measures how far the checkout is behind origin, fetching in the same command only when asked, and fast-forwards it in one command that answers with the checkout as it now stands', async () => {
      const publisher = withOrigin()
      publishTwo(publisher)
      const sent: string[] = []
      const host = machine((cmd, opts) => {
        sent.push(cmd)
        return runOnMachine(cmd, opts)
      })

      const before = await host.freshness.measure(keyed(repo), null)
      expect(before.snapshot).toMatchObject({
        branch: 'main',
        defRef: 'origin/main',
        linked: false,
        hasSubmodules: false,
        tracking: { fetched: null, behind: 0, ahead: 0, dirty: false }
      })
      const after = await host.freshness.measure(keyed(repo), 15_000)
      expect(after.snapshot?.tracking).toMatchObject({ fetched: true, behind: 2, ahead: 0 })
      expect(sent).toHaveLength(2)

      const from = git('rev-parse', 'HEAD').trim()
      const pulled = await host.freshness.pull(keyed(repo), 'main', from, 60_000)
      const to = git('rev-parse', 'HEAD').trim()
      expect(to).toBe(execFileSync('git', ['-C', publisher, 'rev-parse', 'HEAD']).toString().trim())
      expect(pulled).toMatchObject({
        ok: true,
        count: 2,
        after: { head: to, tracking: { fetched: null, behind: 0, ahead: 0 } }
      })
      expect(pulled.stdout).not.toContain('KOLOFT_PULLED')
      expect(sent).toHaveLength(3)
    })
  }
)

function withOrigin(): string {
  const origin = path.join(home, 'origin.git')
  const publisher = path.join(home, 'publisher')
  git('branch', '-M', 'main')
  execFileSync('git', ['clone', '-q', '--bare', repo, origin])
  git('remote', 'add', 'origin', origin)
  git('fetch', '-q', 'origin')
  execFileSync('git', ['clone', '-q', origin, publisher])
  return publisher
}

function publishTwo(publisher: string): void {
  for (const n of ['1', '2']) {
    fs.writeFileSync(path.join(publisher, `up${n}.txt`), n)
    execFileSync('git', ['-C', publisher, 'add', '-A'])
    execFileSync('git', [
      '-C',
      publisher,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-qm',
      n
    ])
  }
  execFileSync('git', ['-C', publisher, 'push', '-q', 'origin', 'main'])
}

// PLATFORM§30
describe('freshness of a checkout on the machine', () => {
  it('a fetch the machine cannot do says so, and keeps the time of the last fetch from before it', async () => {
    withOrigin()
    const fetchHead = path.join(repo, '.git', 'FETCH_HEAD')
    const lastFetchS = 1_700_000_000
    fs.utimesSync(fetchHead, lastFetchS, lastFetchS)
    git('remote', 'set-url', 'origin', path.join(home, 'gone.git'))

    const got = await machine().freshness.measure(keyed(repo), 15_000)

    expect(got.snapshot?.tracking).toMatchObject({ fetched: false, fetchHeadAt: lastFetchS * 1000 })
    expect(fs.statSync(fetchHead).mtimeMs).toBeGreaterThan(lastFetchS * 1000)
  })

  it('answers nothing, and pulls nothing, when the machine cannot be reached', async () => {
    withOrigin()
    const host = machine(unreachable)
    expect((await host.freshness.measure(keyed(repo), 15_000)).snapshot).toBeNull()
    const from = git('rev-parse', 'HEAD').trim()
    expect(await host.freshness.pull(keyed(repo), 'main', from, 60_000)).toMatchObject({
      ok: false,
      count: 0,
      after: null
    })
  })
})

const sshFails = (code: number | null, stderr: string) => async (): Promise<BytesResult> => ({
  code,
  stdout: Buffer.alloc(0),
  stderr
})
const unreachable = sshFails(255, 'ssh: connect to host devbox port 22: Operation timed out')

describe("Claude's folder trust on the machine", () => {
  it('does not call a folder untrusted when the machine cannot be reached', async () => {
    expect(await machine(unreachable).trustsFolder(keyed(repo))).toBe(true)
  })
})

describe('a remote Workbench while the ssh link is down', () => {
  it('Changes and diff fail when ssh cannot connect, instead of answering "empty, not a repo" or "folder gone"', async () => {
    let linkDown = false
    const host = machine((cmd, opts) => (linkDown ? unreachable() : runOnMachine(cmd, opts)))
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\nmore\n')
    expect((await host.gitChanges(keyed(repo), 'merge-base')).status).toEqual({
      [keyed(path.join(repo, 'a.txt'))]: 'modified',
      [keyed(path.join(repo, 'broken'))]: 'untracked'
    })

    linkDown = true

    await expect(host.gitChanges(keyed(repo), 'merge-base')).rejects.toThrow('Operation timed out')
    await expect(host.gitDiff(keyed(repo))).rejects.toThrow()
  })

  it('never calls the workspace folder missing when ssh cannot connect, only when the machine says it is gone', async () => {
    let linkDown = false
    const host = machine((cmd, opts) => (linkDown ? unreachable() : runOnMachine(cmd, opts)))
    expect(await host.dirExistsOrThrow(keyed(repo))).toBe(true)
    expect(await host.dirExistsOrThrow(keyed(path.join(repo, 'gone')))).toBe(false)

    linkDown = true

    await expect(host.dirExistsOrThrow(keyed(repo))).rejects.toThrow('Operation timed out')
  })

  it('refuses a session start with ssh’s reason when the machine is out of reach, but not when it only needs someone to sign in, which the session tab is for, nor when ssh is merely slow', async () => {
    await expect(machine(unreachable).reachOrThrow()).rejects.toThrow('Operation timed out')
    const needsPassword = sshFails(255, 'puser@devbox: Permission denied (publickey,password).')
    await expect(machine(needsPassword).reachOrThrow()).resolves.toBeUndefined()
    await expect(machine(sshFails(null, '')).reachOrThrow()).resolves.toBeUndefined()
    await expect(machine().reachOrThrow()).resolves.toBeUndefined()
  })
})

describe('each remote Workbench step is one ssh round trip', () => {
  const counted = (): { host: SshHost; trips: () => number } => {
    let n = 0
    const host = machine((cmd, opts) => {
      n++
      return runOnMachine(cmd, opts)
    })
    return { host, trips: () => n }
  }

  it('a Changes refresh asks the machine once', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\nmore\n')
    const { host, trips } = counted()
    await host.gitChanges(keyed(repo), 'merge-base')
    expect(trips()).toBe(1)
  })

  it('a save asks the machine once, whether it lands or finds the file changed', async () => {
    const file = keyed(path.join(repo, 'a.txt'))
    const opened = await machine().openForEdit(file)
    const { host, trips } = counted()
    expect(await host.writeText(file, 'mine\n', opened)).toMatchObject({ ok: true })
    expect(trips()).toBe(1)
    expect(await host.writeText(file, 'again\n', opened)).toMatchObject({
      ok: false,
      code: 'stale'
    })
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('mine\n')
  })

  it('searches typed one after another reuse one file list for 30 s, then list the files again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const { host, trips } = counted()
      await host.search(keyed(repo), 'a')
      fs.writeFileSync(path.join(repo, 'abc.txt'), 'x')
      expect((await host.search(keyed(repo), 'ab')).hits).toEqual([])
      expect(trips()).toBe(1)

      await vi.advanceTimersByTimeAsync(30_000)

      expect((await host.search(keyed(repo), 'ab')).hits.map((h) => h.rel)).toEqual(['abc.txt'])
      expect(trips()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a file created from the Workbench shows in the very next search', async () => {
    const host = machine()
    expect((await host.search(keyed(repo), 'fresh')).hits).toEqual([])
    await host.createFile(keyed(repo), 'fresh.md')
    expect((await host.search(keyed(repo), 'fresh')).hits.map((h) => h.rel)).toEqual(['fresh.md'])
  })

  it('a file list the machine could not send is asked for again on the next search', async () => {
    let linkDown = true
    const host = machine((cmd, opts) => (linkDown ? unreachable() : runOnMachine(cmd, opts)))
    expect((await host.search(keyed(repo), 'b.txt')).hits).toEqual([])
    linkDown = false
    expect((await host.search(keyed(repo), 'b.txt')).hits).toHaveLength(1)
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

describe('accounts for remote launches started together', () => {
  it('two remote launches started at once land on two accounts, as two local ones do', async () => {
    const accounts = ['a', 'b'].map((name) => meta({ name }))
    const sessions: LaunchedSession[] = []
    const picker = new AccountPicker({
      listAccounts: () => accounts,
      fablePriority: () => false,
      readSecret: async () => null,
      probe: async () => ({ ok: false, error: 'network' }),
      onProbeOutcome: () => {},
      launchedSessions: () => sessions,
      recordPick: (tabId, account) => sessions.push({ tabId, account }),
      now: () => NOW_MS
    })
    accounts.forEach((a, i) =>
      picker.cacheUsage(
        'oauth',
        a.name,
        usage({ u5: 0.3, u7: 0.4, r5: NOW_S + 36_000, r7: NOW_S + (i + 1) * 86_400 })
      )
    )
    const handed: string[] = []
    const host = new SshHost(MACHINE, {
      run: runOnMachine,
      shell: () => ({ spawnCwd: '/' }),
      watch: () => {},
      unwatch: () => {},
      github: {},
      claude: {
        userData: home,
        controlDir: home,
        machinePackage: () => ({ dir: home, name: 'm-0000000000000000' }),
        alive: () => new Set(),
        firstHeartbeatDone: async () => {},
        realPath: (p) => p,
        settings: () => ({ skipPermissions: false }),
        agentTools: () => true,
        pickAccount: async (launchKey) => {
          const res = await picker.pick(launchKey)
          if (!res.account) return undefined
          handed.push(res.account)
          return { env: {}, banner: '' }
        },
        hookSettings: () => ({})
      }
    })
    await Promise.all([host.launch({ root: keyed('/w') }), host.launch({ root: keyed('/w') })])
    expect(handed.sort()).toEqual(['a', 'b'])
  })

  it('a --model asked of a remote launch yields to a custom endpoint account that pins its own model, and stays on any other account', async () => {
    const tabScript = async (env: Record<string, string>, tabId: string): Promise<string> => {
      const plan = await machine(runOnMachine, {
        pickAccount: async () => ({ env, banner: '' })
      }).launch({ root: keyed('/w'), model: 'opus' })
      if (!plan.ok) throw new Error('launch refused')
      plan.launchCommand(tabId)
      return fs.readFileSync(path.join(tabPackageDir(home, tabId), `${tabId}.sh`), 'utf8')
    }
    expect(await tabScript({ ANTHROPIC_MODEL: 'glm-5.2' }, 'tab-pinned')).not.toContain('--model')
    expect(await tabScript({}, 'tab-plain')).toMatch(/'--model' 'opus'|--model opus/)
  })

  it('a remote session resumed after its tmux ended is picked with its own id, so it can stay on the account it ran on', async () => {
    const ended = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const pickAccount = vi.fn(async () => ({ env: {}, banner: '' }))
    await machine(runOnMachine, { pickAccount }).launch({
      root: keyed('/w'),
      resumeSessionId: ended
    })
    expect(pickAccount).toHaveBeenCalledWith(`launch-${ended}`, ended)
  })

  // ADR-0030
  it("refuses a remote launch with no usable account instead of using the machine's own login, but re-attaching a live session needs none", async () => {
    const pickAccount = vi.fn(async () => undefined)
    const live = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const host = new SshHost(MACHINE, {
      run: runOnMachine,
      shell: () => ({ spawnCwd: '/' }),
      watch: () => {},
      unwatch: () => {},
      github: {},
      claude: {
        userData: home,
        controlDir: home,
        machinePackage: () => ({ dir: home, name: 'm-0000000000000000' }),
        alive: () => new Set([live]),
        firstHeartbeatDone: async () => {},
        realPath: (p) => p,
        settings: () => ({ skipPermissions: false }),
        agentTools: () => true,
        pickAccount,
        hookSettings: () => ({})
      }
    })
    await expect(host.launch({ root: keyed('/w') })).rejects.toThrow(NO_USABLE_ACCOUNT.claude)
    pickAccount.mockClear()
    expect((await host.launch({ root: keyed('/w'), resumeSessionId: live })).ok).toBe(true)
    expect(pickAccount).not.toHaveBeenCalled()
  })
})

it("a launch decided before the machine's first heartbeat this run waits for it, so a session still running there is attached, not started again", async () => {
  const live = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  let askForHeartbeat!: (answer: () => void) => void
  const heartbeatAsked = new Promise<() => void>((asked) => (askForHeartbeat = asked))
  const alive = new Set<string>()
  const host = machine(runOnMachine, {
    alive: () => alive,
    firstHeartbeatDone: () => new Promise((done) => askForHeartbeat(done))
  })
  const launching = host.launch({ root: keyed('/w'), resumeSessionId: live })
  const answer = await Promise.race([heartbeatAsked, launching.then(() => undefined)])
  if (!answer) throw new Error('launch finished without asking for the first heartbeat')
  alive.add(live)
  answer()
  const plan = await launching
  if (!plan.ok) throw new Error('launch refused')
  expect(plan.machine?.attachTo).toBe(live)
})

describe('ending a session that runs on the machine', () => {
  const live = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const tmux = `k-${live}`
  const killAnswering = (code: number | null, stderr = '') => {
    const pickAccount = vi.fn(async () => ({ env: {}, banner: '' }))
    const host = machine(
      (cmd, opts) =>
        cmd === killSessionCmd(tmux)
          ? Promise.resolve({ code, stdout: Buffer.alloc(0), stderr })
          : runOnMachine(cmd, opts),
      { alive: () => new Set([live]), pickAccount }
    )
    return { host, pickAccount }
  }

  it('a kill ssh could not deliver says why, and the next launch attaches to the session still running there', async () => {
    const { host, pickAccount } = killAnswering(
      255,
      'ssh: connect to host devbox: Connection refused\n'
    )
    expect(await host.endTmuxSession(tmux)).toBe('ssh: connect to host devbox: Connection refused')
    await host.launch({ root: keyed('/w'), resumeSessionId: live })
    expect(pickAccount).not.toHaveBeenCalled()
  })

  it('a kill that timed out says so, and the next launch attaches', async () => {
    const { host, pickAccount } = killAnswering(null)
    expect(await host.endTmuxSession(tmux)).toBe('ssh timed out')
    await host.launch({ root: keyed('/w'), resumeSessionId: live })
    expect(pickAccount).not.toHaveBeenCalled()
  })

  it('a kill of a session already gone (tmux exits 1) is no failure, and the next launch starts afresh', async () => {
    const { host, pickAccount } = killAnswering(1, "can't find session: " + tmux + '\n')
    expect(await host.endTmuxSession(tmux)).toBeUndefined()
    await host.launch({ root: keyed('/w'), resumeSessionId: live })
    expect(pickAccount).toHaveBeenCalled()
  })
})

describe("resizing a remote tab's stand-in terminal", () => {
  it('sends the last size once the resizing settles, and only for a tab that has a stand-in terminal', async () => {
    const bin = path.join(home, '.local', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    const log = path.join(home, 'stty.log')
    fs.writeFileSync(
      path.join(bin, 'stty'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`,
      {
        mode: 0o755
      }
    )
    const tabs = path.join(home, '.koloft', 'tabs')
    fs.mkdirSync(tabs, { recursive: true })
    fs.writeFileSync(path.join(tabs, 'pty-1.pts'), '/dev/pts/9\n')
    const resized = machine().shell(keyed(repo)).resized!

    resized('pty-1', 100, 30)
    resized('pty-1', 110, 35)
    resized('pty-1', 120, 40)
    resized('pty-2', 80, 24)
    await new Promise((r) => setTimeout(r, 1500))

    expect(fs.readFileSync(log, 'utf8')).toBe('-F /dev/pts/9 cols 120 rows 40\n')
  })
})

describe('the utility terminal on the machine', () => {
  function guardOnPath(): { bin: string; realLog: string } {
    const guardDir = path.join(home, 'util-bin')
    const realDir = path.join(home, 'real-bin')
    fs.mkdirSync(guardDir)
    fs.mkdirSync(realDir)
    fs.writeFileSync(path.join(guardDir, 'claude'), utilTerminalGuard('claude'), { mode: 0o755 })
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

it('a worktree git cannot delete on the machine is reported in git’s words, with the commands to run on that machine', async () => {
  const tree = path.join(repo, '.claude', 'worktrees', 'w')
  git('worktree', 'add', '-q', '-b', 'worktree-w', tree)
  const readOnly = path.join(tree, 'build', 'ro')
  fs.mkdirSync(readOnly, { recursive: true })
  fs.writeFileSync(path.join(readOnly, 'out.o'), 'x')
  fs.chmodSync(readOnly, 0o555)
  const problem = await removeTree(machine().gitOut, {
    root: keyed(repo),
    treeRoot: keyed(tree),
    worktreeName: 'w',
    branches: ['worktree-w']
  })
  fs.chmodSync(readOnly, 0o755)
  expect(problem).toContain(`failed to delete '${tree}': Permission denied`)
  expect(problem).toContain(`run on ${MACHINE}: chmod -R u+w '${tree}' && rm -rf '${tree}'`)
})
