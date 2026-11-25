import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-claude-launch-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

afterAll(async () => {
  await BackgroundFile.whenAllWritten()
  fs.rmSync(app.getPath('userData'), { recursive: true, force: true })
})

import { formatRemoteKey } from '@shared/remoteKey'
import type { CreateTabOptions } from '@shared/types'
import { machineClaudeArgs } from '../../src/agents/claude/main/claudeLaunch'
import { AccountPicker, type LaunchedSession } from '../../src/main/accountPicker'
import { REMOTE_ENV_LINES } from '../../src/main/remote/install'
import { mirrorHookDir, mirrorProjectsRoot, tabPackageDir } from '../../src/main/remote/paths'
import type { BytesResult } from '../../src/main/remote/ssh'
import { meta, NOW_MS, NOW_S, usage } from './helpers/accounts'
import { BackgroundFile } from '../../src/main/backgroundFile'
import {
  claudeBackendIn,
  MACHINE,
  MACHINE_FOLDER,
  makeWorld,
  ON_THE_MACHINE,
  recordingPty,
  recordingSsh,
  shellOnThisMacAsTheMachine,
  type ClaudeSetup,
  type MachineSetup,
  type World
} from './helpers/agentTabs'

const TAB = 'pty-t1'
let world: World
let loginShell = '/bin/sh'

beforeEach(() => {
  world = makeWorld()
})

afterEach(() => world.gone())

const claudeOn = (
  machine: Partial<MachineSetup> = {},
  tracker: ClaudeSetup['tracker'] = {}
): ReturnType<typeof claudeBackendIn> =>
  claudeBackendIn(world, recordingPty(TAB).pty, {
    machine: { run: recordingSsh().run, ...machine },
    tracker
  })

const startedThere = async (
  backend: ReturnType<typeof claudeBackendIn>,
  spec: Partial<CreateTabOptions> = {}
): Promise<string> => {
  const made = await backend.create({ kind: 'claude', cwd: ON_THE_MACHINE, tabId: TAB, ...spec })
  if (!made.ok) throw new Error(`launch refused: ${made.code}`)
  return made.id
}

describe.each(['/bin/sh', '/bin/tcsh'])(
  "whether Claude Code trusts a folder on another machine, read from Claude Code's own file there, when the login shell there is %s",
  (shell) => {
    let repo: string
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    const asTheMachine = shellOnThisMacAsTheMachine(
      () => world.home,
      () => loginShell
    )
    const onAMachineWithNoNodeOnItsPath = (
      cmd: string,
      opts?: { input?: Buffer }
    ): Promise<BytesResult> => {
      const at = cmd.lastIndexOf(' ') + 1
      const body = Buffer.from(cmd.slice(at), 'base64').toString('utf8')
      expect(body).toContain(REMOTE_ENV_LINES)
      const noNode = body.replace(
        REMOTE_ENV_LINES,
        `${REMOTE_ENV_LINES}\nexport PATH=/usr/bin:/bin`
      )
      return asTheMachine(cmd.slice(0, at) + Buffer.from(noNode).toString('base64'), opts)
    }
    const putNodeOnMachine = (): void => {
      const node = path.join(world.home, '.koloft', 'node', 'bin')
      fs.mkdirSync(node, { recursive: true })
      fs.symlinkSync(process.execPath, path.join(node, 'node'))
    }
    const trusts = (dir: string, run = asTheMachine): Promise<boolean> =>
      claudeOn({ run }).trustsFolder(formatRemoteKey(MACHINE, dir))
    const trustedInClaudeJson = (dir: string): void =>
      fs.writeFileSync(
        path.join(world.home, '.claude.json'),
        JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }, null, 2)
      )

    beforeEach(() => {
      loginShell = shell
      repo = world.repo
      fs.mkdirSync(path.join(repo, 'sub'))
      git('init', '-q')
      git(
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init'
      )
    })
    afterEach(() => (loginShell = '/bin/sh'))

    // CC§9
    it("reads a folder in the machine's .claude.json, and one under it, as trusted", async () => {
      putNodeOnMachine()
      fs.writeFileSync(path.join(world.home, '.claude.json'), '{"numStartups":3}\n')
      expect(await trusts(repo)).toBe(false)
      trustedInClaudeJson(repo)
      expect(await trusts(path.join(repo, 'sub'))).toBe(true)
    })

    // CC§9
    it('on a machine with no node, where Koloft cannot read the trust, a folder reads as not trusted, so a scheduled run is never let through on a guess', async () => {
      trustedInClaudeJson(repo)
      expect(await trusts(repo, onAMachineWithNoNodeOnItsPath)).toBe(false)
    })

    // CC§9
    it("stops looking up at the top of the machine's git repo: a repo in a trusted folder is not trusted, a worktree of a trusted repo is", async () => {
      putNodeOnMachine()
      fs.mkdirSync(path.join(world.home, 'plain'))
      trustedInClaudeJson(world.home)

      expect(await trusts(path.join(world.home, 'plain'))).toBe(true)
      expect(await trusts(path.join(repo, 'sub'))).toBe(false)

      trustedInClaudeJson(repo)
      git('worktree', 'add', '-q', '-b', 'worktree-w', path.join(repo, '.claude', 'worktrees', 'w'))
      expect(await trusts(path.join(repo, '.claude', 'worktrees', 'w'))).toBe(true)
    })

    // CC§9
    it('on the machine too, a submodule or a worktree whose main repo is gone, under a trusted repo, is not trusted: a .git file with no readable commondir is its own top', async () => {
      putNodeOnMachine()
      const submodule = path.join(repo, 'sub')
      fs.mkdirSync(path.join(repo, '.git', 'modules', 'sub'), { recursive: true })
      fs.writeFileSync(path.join(submodule, '.git'), 'gitdir: ../.git/modules/sub\n')
      const orphan = path.join(repo, 'orphan')
      fs.mkdirSync(orphan)
      fs.writeFileSync(
        path.join(orphan, '.git'),
        `gitdir: ${path.join(world.home, 'gone', '.git')}\n`
      )
      trustedInClaudeJson(repo)

      expect(await trusts(submodule)).toBe(false)
      expect(await trusts(orphan)).toBe(false)
    })
  }
)

it('a folder on another machine is not called untrusted by Claude Code when that machine cannot be reached', async () => {
  const unreachable = async (): Promise<BytesResult> => ({
    code: 255,
    stdout: Buffer.alloc(0),
    stderr: 'ssh: connect to host devbox port 22: Operation timed out'
  })
  expect(await claudeOn({ run: unreachable }).trustsFolder(ON_THE_MACHINE)).toBe(true)
})

describe('what a remote launch hands claude', () => {
  const root = ON_THE_MACHINE

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

  // CC§18
  it('a first prompt whose picture sits in any other folder than Koloft’s own on the machine hands claude no --add-dir, as claude would stop on its question about that folder', () => {
    const firstPrompt =
      'fix it\n\nPicture: /Users/me/Library/Application Support/Koloft/palette-pictures/a.png'
    expect(machineClaudeArgs({ root, firstPrompt }, 'sid1', false)).toEqual({
      ok: true,
      args: ['--session-id', 'sid1', '--', firstPrompt]
    })
  })

  it('a first prompt that names a pasted picture also hands claude the picture’s folder on the machine with --add-dir, just before the prompt', () => {
    const firstPrompt = 'fix it\n\nPicture: /home/me/.koloft/element-picks/a.png'
    expect(machineClaudeArgs({ root, firstPrompt }, 'sid1', false)).toEqual({
      ok: true,
      pictures: '/home/me/.koloft/element-picks',
      args: [
        '--session-id',
        'sid1',
        '--add-dir',
        '/home/me/.koloft/element-picks',
        '--',
        firstPrompt
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

describe('a Claude Code session started on another machine', () => {
  const scriptOf = (tabId: string): string =>
    fs.readFileSync(path.join(tabPackageDir(world.userData, tabId), `${tabId}.sh`), 'utf8')

  it('two started at once land on two accounts, as two on this Mac do', async () => {
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
    const backend = claudeOn({
      pickAccount: async (launchKey) => {
        const res = await picker.pick(launchKey)
        if (!res.account) return undefined
        handed.push(res.account)
        return { env: {}, banner: '' }
      }
    })
    await Promise.all([
      startedThere(backend, { tabId: 'pty-a' }),
      startedThere(backend, { tabId: 'pty-b' })
    ])
    expect(handed.sort()).toEqual(['a', 'b'])
  })

  it('a --model asked of it yields to a custom endpoint account that pins its own model, and stays on any other account', async () => {
    const scriptOnAnAccountWith = async (env: Record<string, string>): Promise<string> => {
      const backend = claudeOn({ pickAccount: async () => ({ env, banner: '' }) })
      return scriptOf(await startedThere(backend, { model: 'opus' }))
    }
    expect(await scriptOnAnAccountWith({ ANTHROPIC_MODEL: 'glm-5.2' })).not.toContain('--model')
    expect(await scriptOnAnAccountWith({})).toMatch(/'--model' 'opus'|--model opus/)
  })

  // ADR-0028
  it('is known to skip permission checks from its own permission or else from Settings, so a message the owner sends it can claim its real class', async () => {
    const classOf = async (
      skipPermissions: boolean,
      permission?: 'bypass' | 'default'
    ): Promise<string> => {
      const backend = claudeOn({ skipPermissions })
      return backend.permissionClass(await startedThere(backend, { permission }))
    }
    expect(await classOf(true)).toBe('bypass')
    expect(await classOf(true, 'default')).toBe('bypass')
    expect(await classOf(false)).toBe('prompting')
    expect(await classOf(false, 'bypass')).toBe('bypass')
  })

  it('resumed after its tmux ended, its account is picked with its own id, so it can stay on the account it ran on', async () => {
    const ended = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const pickAccount = vi.fn(async () => ({ env: {}, banner: '' }))
    await startedThere(claudeOn({ pickAccount }), { resumeSessionId: ended })
    expect(pickAccount).toHaveBeenCalledWith(`launch-${ended}`, ended)
  })

  it("a new one is followed as a tab of that machine: in its folder there, under the tmux session named for its session, its transcripts looked for in this Mac's copy of that machine's; the account picked for the launch becomes the tab's, and what an earlier tab of the same id reported from that machine is forgotten", async () => {
    const track = vi.fn()
    const movePick = vi.fn()
    const reportOfAnEarlierTab = path.join(mirrorHookDir(world.userData, MACHINE), `${TAB}.json`)
    fs.mkdirSync(path.dirname(reportOfAnEarlierTab), { recursive: true })
    fs.writeFileSync(reportOfAnEarlierTab, '{}')
    const tabId = await startedThere(claudeOn({}, { track, movePick }))
    expect(track).toHaveBeenCalledWith(tabId, MACHINE_FOLDER, {
      host: MACHINE,
      projectsRoot: mirrorProjectsRoot(world.userData, MACHINE),
      tmuxName: expect.stringMatching(/^k-[0-9a-f-]{36}$/)
    })
    const sessionId = (track.mock.calls[0][2] as { tmuxName: string }).tmuxName.slice('k-'.length)
    expect(movePick).toHaveBeenCalledWith(`launch-${sessionId}`, tabId)
    expect(fs.existsSync(reportOfAnEarlierTab)).toBe(false)
  })

  it('one still running there, attached to again, is bound to its session at once, in its folder there, and no account is moved to the tab', async () => {
    const stillRunning = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const bindSession = vi.fn()
    const movePick = vi.fn()
    const backend = claudeOn({ alive: () => new Set([stillRunning]) }, { bindSession, movePick })
    const tabId = await startedThere(backend, { resumeSessionId: stillRunning })
    expect(bindSession).toHaveBeenCalledWith(tabId, '', stillRunning, MACHINE_FOLDER)
    expect(movePick).not.toHaveBeenCalled()
  })
})
