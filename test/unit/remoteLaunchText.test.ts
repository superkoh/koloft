import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-remote-launch-text-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

afterAll(() => fs.rmSync(app.getPath('userData'), { recursive: true, force: true }))

vi.mock('../../src/main/cliRuntime', () => ({
  resolveCliRuntime: async (spec: {
    command: string
    environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  }) => ({
    binary: `/fixture/${spec.command}`,
    env: spec.environment({ HOME: process.env.HOME, PATH: '/usr/bin:/bin' }),
    version: '999.0.0',
    verified: true
  })
}))

vi.mock('../../src/agents/codex/main/codexTransport', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agents/codex/main/codexTransport')>()
  const { CodexRpcThatListsNoHooks } = await import('./helpers/codexRpcStub')
  return {
    ...real,
    createCodexTransport: async (options: {
      upstream?: (frame: () => void, failure: () => void) => { stop(): Promise<void> }
    }) => {
      const upstream = options.upstream?.(
        () => {},
        () => {}
      )
      return {
        url: 'unix:///test/rpc.sock',
        stop: async () => {
          await upstream?.stop()
        },
        request: async () => ({})
      }
    },
    CodexRpc: CodexRpcThatListsNoHooks
  }
})

import type { CreateTabOptions } from '@shared/types'
import { agySessionKey } from '../../src/agents/kit/main/sessionStore'
import type { MachineAccount } from '../../src/agents/claude/main/claudeLaunch'
import { tabPackageDir } from '../../src/main/remote/paths'
import {
  isStartedBeforeTabPasses,
  markStartedBeforeTabPasses,
  TAB_PASS_ENV
} from '../../src/main/tabPass'
import {
  agySessionsIn,
  claudeBackendIn,
  codexSessionsIn,
  filesUnder,
  LOGIN_PATH_ON_THE_MACHINE,
  MACHINE,
  MACHINE_FOLDER,
  makeWorld,
  ON_THE_MACHINE,
  recordingPty,
  recordingSsh,
  sameOnEveryRun,
  type AgySetup,
  type ClaudeSetup,
  type MachineSetup,
  type RecordedSsh,
  type TabStarted,
  type World
} from './helpers/agentTabs'

const TAB = 'pty-t1'
const RUNNING_THERE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PINNED = './remote-launch-text'
const RULES = 'Docs: sonnet, low.'
const ACCOUNT: MachineAccount = {
  env: { ANT_ACCOUNT: 'work', CLAUDE_CODE_OAUTH_TOKEN: 'token-of-the-koloft-account' },
  banner: 'koloft: account work'
}
const EVERYTHING_A_LAUNCH_CARRIES: Partial<CreateTabOptions> = {
  worktree: 'pinned-wt',
  model: 'pinned-model',
  effort: 'xhigh',
  permission: 'acceptEdits',
  firstPrompt: 'FIRST PROMPT',
  ownerWords: "The owner's own words, with a ' in them",
  name: 'PinnedName',
  ownerText: 'OWNER TEXT',
  trustFolder: true
}
const SSH_COULD_NOT_CONNECT = {
  code: 255,
  stderr: 'ssh: connect to host devbox port 22: Connection refused'
}
const SSH_WANTS_A_PASSWORD = { code: 255, stderr: 'me@devbox: Permission denied (publickey).' }
const HEARTBEAT_WAIT_IS_SEEN_WITHIN_MS = 150

let world: World
let stops: (() => Promise<void>)[]

beforeEach(() => {
  world = makeWorld()
  stops = []
})

afterEach(async () => {
  for (const stop of stops) await stop()
  await world.gone()
})

const part = (title: string, text: string | undefined): string =>
  `=== ${title} ===\n${text ?? '(nothing)'}`

const ranOverSsh = (ran: string[]): string =>
  part('run over ssh, in this order', ran.join('\n--- the next one ---\n') || undefined)

const pin = (text: string, name: string): Promise<void> =>
  expect(sameOnEveryRun(text, world)).toMatchFileSnapshot(`${PINNED}/${name}.txt`)

const tabFiles = (): string =>
  filesUnder(tabPackageDir(world.userData, TAB), {
    name: /\.prompt\.md$/,
    where: 'prompt-text/session/claude-project-prompt-file.txt'
  })

const typedIntoTheTab = (tab: TabStarted): string =>
  [
    part('the shell the line is typed into', tab.shell),
    part('the line typed into the tab on this Mac', tab.typedLine)
  ].join('\n')

interface ClaudeTab {
  ssh: RecordedSsh
  started: TabStarted[]
  backend: ReturnType<typeof claudeBackendIn>
}

function claudeWith(
  machine: Partial<MachineSetup> = {},
  setup: Partial<ClaudeSetup> = {},
  ssh = recordingSsh()
): ClaudeTab {
  const { started, pty } = recordingPty(TAB)
  const backend = claudeBackendIn(world, pty, {
    ...setup,
    machine: {
      run: ssh.run,
      loginPath: async () => LOGIN_PATH_ON_THE_MACHINE,
      pickAccount: async () => ACCOUNT,
      ...machine
    }
  })
  return { ssh, started, backend }
}

async function claudeOverSsh(
  spec: Partial<CreateTabOptions>,
  machine: Partial<MachineSetup> = {},
  setup: Partial<ClaudeSetup> = {}
): Promise<string> {
  const { ssh, started, backend } = claudeWith(machine, setup)
  const made = await backend.create({ kind: 'claude', cwd: ON_THE_MACHINE, tabId: TAB, ...spec })
  if (!made.ok) throw new Error(`launch refused: ${made.code}`)
  return [typedIntoTheTab(started[0]), tabFiles(), ranOverSsh(ssh.ran)].join('\n')
}

async function claudeOnThisMac(
  spec: Partial<CreateTabOptions>,
  setup: Partial<ClaudeSetup> = {}
): Promise<string> {
  const { started, backend } = claudeWith({}, setup)
  const made = await backend.create({ kind: 'claude', cwd: world.repo, tabId: TAB, ...spec })
  if (!made.ok) throw new Error(`launch refused: ${made.code}`)
  const [tab] = started
  const given = Object.entries({ ...tab.extraEnv, ...tab.envSetForThisTab })
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
  const trustFile = path.join(world.home, '.claude.json')
  return [
    part('the line typed into the tab on this Mac', tab.typedLine),
    part('the environment the launch adds to the tab', given.join('\n')),
    filesUnder(world.regDir),
    part(
      "Claude Code's own file in the home folder",
      fs.existsSync(trustFile) ? fs.readFileSync(trustFile, 'utf8') : undefined
    )
  ].join('\n')
}

interface AgyTab {
  ssh: RecordedSsh
  started: TabStarted[]
  sessions: ReturnType<typeof agySessionsIn>
}

function agyWith(
  machine: Partial<MachineSetup> = {},
  setup: Partial<AgySetup> = {},
  ssh = recordingSsh()
): AgyTab {
  const { started, pty } = recordingPty(TAB)
  const sessions = agySessionsIn(world, pty, {
    apiKey: 'api-key-of-the-koloft-account',
    ...setup,
    machine: { run: ssh.run, loginPath: async () => LOGIN_PATH_ON_THE_MACHINE, ...machine }
  })
  stops.push(() => sessions.stopAll())
  return { ssh, started, sessions }
}

async function agyOverSsh(
  spec: Partial<CreateTabOptions>,
  machine: Partial<MachineSetup> = {},
  setup: Partial<AgySetup> = {}
): Promise<string> {
  const { ssh, started, sessions } = agyWith(machine, setup)
  await sessions.launch({ kind: 'agy', cwd: ON_THE_MACHINE, tabId: TAB, ...spec })
  return [typedIntoTheTab(started[0]), tabFiles(), ranOverSsh(ssh.ran)].join('\n')
}

interface CodexTab {
  ran: string[]
  started: TabStarted[]
  sessions: ReturnType<typeof codexSessionsIn>
}

function codexWith(agentTools = true): CodexTab {
  const { started, pty } = recordingPty(TAB)
  const ran: string[] = []
  const sessions = codexSessionsIn(world, pty, {
    ranOnTheMachine: ran,
    run: () => ({ code: 1, stdout: '', stderr: '' }),
    agentTools
  })
  stops.push(() => sessions.stopAll())
  return { ran, started, sessions }
}

async function codexOverSsh(spec: Partial<CreateTabOptions>, agentTools = true): Promise<string> {
  const { ran, started, sessions } = codexWith(agentTools)
  await sessions.launch({ kind: 'codex', cwd: ON_THE_MACHINE, tabId: TAB, ...spec })
  const [tab] = started
  return [
    part('the program the tab runs on this Mac', tab.executable),
    part('its arguments', tab.argv?.join('\n')),
    tabFiles(),
    ranOverSsh(ran)
  ].join('\n')
}

describe('what Koloft sends to another machine for a tab of each agent and types on this Mac to start it, and what it hands a Claude Code tab on this Mac, pinned so that moving the code changes no character', () => {
  describe('Claude Code over SSH', () => {
    it('a new session', async () => pin(await claudeOverSsh({}), 'claude-over-ssh/new-session'))

    it('a new session with everything a launch can carry, in a project with its own rules', async () =>
      pin(
        await claudeOverSsh(EVERYTHING_A_LAUNCH_CARRIES, {}, { projectRules: RULES }),
        'claude-over-ssh/new-session-with-everything'
      ))

    it('a new session with agent tools off', async () =>
      pin(
        await claudeOverSsh({}, { agentTools: false }),
        'claude-over-ssh/new-session-agent-tools-off'
      ))

    it('a session still running there, attached to again', async () =>
      pin(
        await claudeOverSsh(
          { resumeSessionId: RUNNING_THERE },
          { alive: () => new Set([RUNNING_THERE]) }
        ),
        'claude-over-ssh/attached'
      ))

    it('asking whether a folder there is trusted, and closing a tab', async () => {
      const { ssh, backend } = claudeWith(
        {},
        {
          remoteTab: {
            host: MACHINE,
            projectsRoot: path.join(world.userData, 'projects'),
            tmuxName: `k-${RUNNING_THERE}`
          }
        }
      )
      await backend.trustsFolder(ON_THE_MACHINE)
      backend.stop(TAB)
      await vi.waitFor(() => expect(ssh.ran).toHaveLength(2))
      await pin(ranOverSsh(ssh.ran), 'claude-over-ssh/trust-asked-and-tab-closed')
    })
  })

  describe('Claude Code on this Mac', () => {
    it('a new session', async () =>
      pin(await claudeOnThisMac({}), 'claude-on-this-mac/new-session'))

    it('a new session with everything a launch can carry, in a project with its own rules', async () =>
      pin(
        await claudeOnThisMac(
          { ...EVERYTHING_A_LAUNCH_CARRIES, worktree: undefined },
          { projectRules: RULES }
        ),
        'claude-on-this-mac/new-session-with-everything'
      ))
  })

  describe('Antigravity over SSH', () => {
    it('a new session on an API key', async () =>
      pin(await agyOverSsh({}), 'agy-over-ssh/new-session-api-key'))

    it('a new session signed in on the web, with agent tools on and everything a launch can carry', async () =>
      pin(
        await agyOverSsh(
          {
            model: 'pinned-model',
            effort: 'high',
            permission: 'acceptEdits',
            firstPrompt: 'FIRST PROMPT',
            name: 'PinnedName',
            ownerText: 'OWNER TEXT',
            trustFolder: true
          },
          {},
          { apiKey: undefined, signedInOnTheWeb: true, agentTools: true }
        ),
        'agy-over-ssh/new-session-web-sign-in-with-everything'
      ))

    it('a session still running there, attached to again', async () =>
      pin(
        await agyOverSsh(
          { resumeSessionId: agySessionKey(RUNNING_THERE, MACHINE) },
          { alive: () => new Set([RUNNING_THERE]) }
        ),
        'agy-over-ssh/attached'
      ))

    it('asking whether a folder there is trusted, and closing a tab', async () => {
      const { ssh, sessions } = agyWith()
      await sessions.trustsFolder(ON_THE_MACHINE)
      await sessions.launch({ kind: 'agy', cwd: ON_THE_MACHINE, tabId: TAB })
      await sessions.stop(TAB)
      const readTheTmuxName = ssh.ran.filter((cmd) => cmd.includes('.tmux" 2>/dev/null'))
      expect(readTheTmuxName).toHaveLength(2)
      await pin(
        [part('asking about trust', ssh.ran[0]), ranOverSsh(readTheTmuxName)].join('\n'),
        'agy-over-ssh/trust-asked-and-tab-closed'
      )
    })
  })

  describe('Codex over SSH', () => {
    it('a new session', async () => pin(await codexOverSsh({}), 'codex-over-ssh/new-session'))

    it('a new session with everything a launch can carry, agent tools off', async () =>
      pin(
        await codexOverSsh(
          {
            model: 'pinned-model',
            effort: 'xhigh',
            permission: 'acceptEdits',
            firstPrompt: 'FIRST PROMPT',
            ownerWords: "The owner's own words, with a ' in them",
            ownerText: 'OWNER TEXT',
            trustFolder: true
          },
          false
        ),
        'codex-over-ssh/new-session-with-everything'
      ))

    it('closing a tab', async () => {
      const { ran, sessions } = codexWith()
      await sessions.launch({ kind: 'codex', cwd: ON_THE_MACHINE, tabId: TAB })
      await sessions.stop(TAB)
      const stoppedTheServer = ran.filter((cmd) => cmd.endsWith('stop_one "$1"\nexit 0'))
      expect(stoppedTheServer).toHaveLength(1)
      await pin(ranOverSsh(stoppedTheServer), 'codex-over-ssh/tab-closed')
    })
  })
})

describe('the order a launch on another machine keeps', () => {
  const scriptOfTheTab = (): string =>
    fs.readFileSync(path.join(tabPackageDir(world.userData, TAB), `${TAB}.sh`), 'utf8')
  const filesOfTheTab = (): string[] => fs.readdirSync(tabPackageDir(world.userData, TAB)).sort()
  const claudeTabOn = (
    tab: ClaudeTab,
    spec: Partial<CreateTabOptions> = {}
  ): ReturnType<ClaudeTab['backend']['create']> =>
    tab.backend.create({ kind: 'claude', cwd: ON_THE_MACHINE, tabId: TAB, ...spec })
  const agyTabOn = (
    tab: AgyTab,
    spec: Partial<CreateTabOptions> = {}
  ): ReturnType<AgyTab['sessions']['launch']> =>
    tab.sessions.launch({ kind: 'agy', cwd: ON_THE_MACHINE, tabId: TAB, ...spec })

  it("closing a tab of any agent there whose launch line never ran removes the folder of that tab's files on this Mac, account file and all", async () => {
    const folder = tabPackageDir(world.userData, TAB)
    const claude = claudeWith(
      {},
      {
        remoteTab: {
          host: MACHINE,
          projectsRoot: path.join(world.userData, 'projects'),
          tmuxName: `k-${RUNNING_THERE}`
        }
      }
    )
    await claudeTabOn(claude)
    expect(fs.readdirSync(folder)).toContain(`${TAB}.env`)
    claude.backend.stop(TAB)
    expect(fs.existsSync(folder)).toBe(false)
    const agy = agyWith()
    await agyTabOn(agy)
    expect(fs.readdirSync(folder)).toContain(`${TAB}.env`)
    await agy.sessions.stop(TAB)
    expect(fs.existsSync(folder)).toBe(false)
    const codex = codexWith()
    await codex.sessions.launch({ kind: 'codex', cwd: ON_THE_MACHINE, tabId: TAB })
    expect(fs.existsSync(folder)).toBe(true)
    await codex.sessions.stop(TAB)
    expect(fs.existsSync(folder)).toBe(false)
  })

  it("a launch there that fails while writing the tab's files on this Mac, after the account file, leaves no folder of them behind", async () => {
    const folder = tabPackageDir(world.userData, TAB)
    const aFolderWhereThePassGoes = path.join(folder, `${TAB}.pass`)
    fs.mkdirSync(aFolderWhereThePassGoes, { recursive: true })
    await expect(agyTabOn(agyWith())).rejects.toThrow('EISDIR')
    expect(fs.existsSync(folder)).toBe(false)
  })

  // ADR-0030
  it('a Claude Code session with no usable account is refused in the words that say what is wrong, and opens no tab; attaching to one still running there asks for no account', async () => {
    const why = '"me" is not signed in — sign in again in Settings ▸ Accounts.'
    const pickAccount = vi.fn(async () => undefined)
    const tab = claudeWith({
      pickAccount,
      noAccountMessage: () => why,
      alive: () => new Set([RUNNING_THERE])
    })
    await expect(claudeTabOn(tab)).rejects.toThrow(why)
    expect(tab.started).toHaveLength(0)
    pickAccount.mockClear()
    expect((await claudeTabOn(tab, { resumeSessionId: RUNNING_THERE })).ok).toBe(true)
    expect(pickAccount).not.toHaveBeenCalled()
  })

  // ADR-0044
  it("a Claude Code session Koloft just ended on the machine, resumed while the machine's last heartbeat still lists it, starts anew and so asks for an account; refused for having none, that resume has already used up the note that Koloft ended the session, so the next one attaches to what the heartbeat lists and asks for no account", async () => {
    const why = '"me" is not signed in — sign in again in Settings ▸ Accounts.'
    const pickAccount = vi.fn(async () => undefined)
    const tab = claudeWith(
      { pickAccount, noAccountMessage: () => why, alive: () => new Set([RUNNING_THERE]) },
      {
        remoteTab: {
          host: MACHINE,
          projectsRoot: path.join(world.userData, 'projects'),
          tmuxName: `k-${RUNNING_THERE}`
        }
      }
    )
    tab.backend.stop(TAB)
    await expect(claudeTabOn(tab, { resumeSessionId: RUNNING_THERE })).rejects.toThrow(why)
    expect(pickAccount).toHaveBeenCalledTimes(1)
    expect((await claudeTabOn(tab, { resumeSessionId: RUNNING_THERE })).ok).toBe(true)
    expect(pickAccount).toHaveBeenCalledTimes(1)
    expect(tab.started[0].typedLine).toContain('a=attach')
  })

  it("a Claude Code session on a machine that cannot be reached is refused with ssh's own reason before anything else is decided: no account is picked, and a launch whose arguments are wrong gets that reason too", async () => {
    const pickAccount = vi.fn(async () => ACCOUNT)
    const outOfReach = claudeWith(
      { pickAccount },
      {},
      recordingSsh(() => SSH_COULD_NOT_CONNECT)
    )
    await expect(claudeTabOn(outOfReach)).rejects.toThrow('Connection refused')
    await expect(claudeTabOn(outOfReach, { model: 'not a model name' })).rejects.toThrow(
      'Connection refused'
    )
    expect(pickAccount).not.toHaveBeenCalled()
    expect(outOfReach.started).toHaveLength(0)
    expect(await claudeTabOn(claudeWith(), { model: 'not a model name' })).toEqual({
      ok: false,
      code: 'invalid-args'
    })
  })

  // PLATFORM§33
  it("the machine's login-shell PATH is written into the script of a Claude Code or Antigravity session that starts there, and not into the script of one attached to again", async () => {
    const handed = `PATH="$PATH":'${LOGIN_PATH_ON_THE_MACHINE}'`
    const stillRunning = { alive: () => new Set([RUNNING_THERE]) }
    await claudeTabOn(claudeWith())
    expect(scriptOfTheTab()).toContain(handed)
    await claudeTabOn(claudeWith(stillRunning), { resumeSessionId: RUNNING_THERE })
    expect(scriptOfTheTab()).not.toContain(handed)
    await agyTabOn(agyWith())
    expect(scriptOfTheTab()).toContain(handed)
    fs.rmSync(tabPackageDir(world.userData, TAB), { recursive: true })
    await agyTabOn(agyWith(stillRunning), {
      resumeSessionId: agySessionKey(RUNNING_THERE, MACHINE)
    })
    expect(scriptOfTheTab()).not.toContain(handed)
  })

  it('a Claude Code launch asks for no account and reads no login PATH result until the machine has said whether the session still runs there, which waits for the first heartbeat of this run — for a new session too, and a resumed one that heartbeat lists is then attached to, not started again; a new Antigravity session does not wait for it, a resumed one does', async () => {
    const heartbeat = (): {
      machine: Partial<MachineSetup>
      asked: () => boolean
      answer: () => void
    } => {
      let asked = false
      let answer = (): void => {}
      const done = new Promise<void>((resolve) => (answer = resolve))
      return {
        machine: {
          firstHeartbeatDone: () => {
            asked = true
            return done
          }
        },
        asked: () => asked,
        answer
      }
    }
    const settled = async (launching: Promise<unknown>): Promise<boolean> => {
      let done = false
      void launching.then(
        () => (done = true),
        () => (done = true)
      )
      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_WAIT_IS_SEEN_WITHIN_MS))
      return done
    }

    const newClaude = heartbeat()
    const pickAccount = vi.fn(async () => ACCOUNT)
    const claudeLaunching = claudeTabOn(claudeWith({ ...newClaude.machine, pickAccount }))
    await vi.waitFor(() => expect(newClaude.asked()).toBe(true))
    expect(await settled(claudeLaunching)).toBe(false)
    expect(pickAccount).not.toHaveBeenCalled()
    newClaude.answer()
    expect((await claudeLaunching).ok).toBe(true)

    const newAgy = heartbeat()
    await agyTabOn(agyWith(newAgy.machine))
    expect(newAgy.asked()).toBe(false)

    const resumedAgy = heartbeat()
    const alive = new Set<string>()
    const agy = agyWith({ ...resumedAgy.machine, alive: () => alive })
    fs.rmSync(tabPackageDir(world.userData, TAB), { recursive: true })
    const agyLaunching = agyTabOn(agy, { resumeSessionId: agySessionKey(RUNNING_THERE, MACHINE) })
    await vi.waitFor(() => expect(resumedAgy.asked()).toBe(true))
    expect(await settled(agyLaunching)).toBe(false)
    alive.add(RUNNING_THERE)
    resumedAgy.answer()
    await agyLaunching
    expect(agy.started[0].typedLine).toContain('a=attach')

    const resumedClaude = heartbeat()
    const aliveForClaude = new Set<string>()
    const claude = claudeWith({ ...resumedClaude.machine, alive: () => aliveForClaude })
    const claudeResuming = claudeTabOn(claude, { resumeSessionId: RUNNING_THERE })
    await vi.waitFor(() => expect(resumedClaude.asked()).toBe(true))
    expect(await settled(claudeResuming)).toBe(false)
    aliveForClaude.add(RUNNING_THERE)
    resumedClaude.answer()
    await claudeResuming
    expect(claude.started[0].typedLine).toContain('a=attach')
  })

  it('attaching to a session still running there, Claude Code sends its settings file again and Antigravity sends none of its own files, only the script and the pass, and neither sends the account', async () => {
    const stillRunning = { alive: () => new Set([RUNNING_THERE]) }
    await claudeTabOn(claudeWith(stillRunning), { resumeSessionId: RUNNING_THERE })
    expect(filesOfTheTab()).toContain(`${TAB}.json`)
    expect(filesOfTheTab()).not.toContain(`${TAB}.env`)
    fs.rmSync(tabPackageDir(world.userData, TAB), { recursive: true })
    await agyTabOn(agyWith(stillRunning), {
      resumeSessionId: agySessionKey(RUNNING_THERE, MACHINE)
    })
    expect(filesOfTheTab()).toEqual([`${TAB}.pass`, `${TAB}.sh`])
  })

  // ADR-0052
  it('a Claude Code or Antigravity tab that attaches to a session started there before tabs had passes is known as such once its line is typed, and one that attaches to a session holding a pass is not', async () => {
    const stillRunning = { alive: () => new Set([RUNNING_THERE]) }
    let holdsAPass = false
    const ssh = recordingSsh((cmd) =>
      cmd.includes(`show-environment -t "$1" ${TAB_PASS_ENV}`) && !holdsAPass ? { code: 1 } : {}
    )
    const attached = async (): Promise<boolean[]> => {
      const marked: boolean[] = []
      await claudeTabOn(claudeWith(stillRunning, {}, ssh), { resumeSessionId: RUNNING_THERE })
      marked.push(isStartedBeforeTabPasses(TAB))
      markStartedBeforeTabPasses(TAB, !marked[0])
      await agyTabOn(agyWith(stillRunning, {}, ssh), {
        resumeSessionId: agySessionKey(RUNNING_THERE, MACHINE)
      })
      marked.push(isStartedBeforeTabPasses(TAB))
      return marked
    }
    expect(await attached()).toEqual([true, true])
    holdsAPass = true
    expect(await attached()).toEqual([false, false])
  })

  // ADR-0044 AGY§9
  it("an Antigravity session Koloft just ended on the machine, resumed while the machine's last heartbeat still lists it, is first checked for another agy holding its conversation and only then decided start or attach: held, the resume is refused and opens no tab; free again, it starts the session anew instead of attaching to the one that was ended", async () => {
    let heldElsewhere = true
    const ssh = recordingSsh((cmd) =>
      cmd.includes('/presence/$1.lock') && heldElsewhere ? { code: 1 } : {}
    )
    const tab = agyWith({ alive: () => new Set([RUNNING_THERE]) }, {}, ssh)
    const resume = { resumeSessionId: agySessionKey(RUNNING_THERE, MACHINE) }
    await agyTabOn(tab, resume)
    expect(tab.started[0].typedLine).toContain('a=attach')
    await tab.sessions.stop(TAB)
    await expect(agyTabOn(tab, resume)).rejects.toThrow('open in another agy window')
    expect(tab.started).toHaveLength(1)
    heldElsewhere = false
    await agyTabOn(tab, resume)
    expect(tab.started[1].typedLine).toContain('a=start')
  })

  it('a Claude Code session resumed in a folder of the machine that is not its workspace folder, as a worktree is, starts there, or in the workspace folder when that folder is gone; one resumed in the workspace folder itself is handed no second folder', async () => {
    const worktree = `${MACHINE_FOLDER}/.claude/worktrees/wt`
    const inItsWorkspace = { workspaceOfEverySession: ON_THE_MACHINE }
    await claudeTabOn(claudeWith({}, inItsWorkspace), {
      cwd: `ssh://${MACHINE}${worktree}`,
      resumeSessionId: RUNNING_THERE
    })
    expect(scriptOfTheTab()).toContain(`\ncd '${worktree}' || cd '${MACHINE_FOLDER}' || exit 3\n`)
    await claudeTabOn(claudeWith({}, inItsWorkspace), { resumeSessionId: RUNNING_THERE })
    expect(scriptOfTheTab()).toContain(`\ncd '${MACHINE_FOLDER}' || exit 3\n`)
  })

  it("one Claude Code launch names one machine package everywhere — its script, its hook settings and the line that pushes it — though Koloft's package is rebuilt under a new name while it launches", async () => {
    let built = 0
    const hookSettingsDirs: string[] = []
    const tab = claudeWith({
      machinePackageName: () => `m-rebuilt-${++built}`,
      hookSettings: (_tabId, machineDir) => {
        hookSettingsDirs.push(machineDir)
        return {}
      }
    })
    await claudeTabOn(tab)
    const packagesNamedIn = (text: string): string[] => [
      ...new Set(text.match(/m-rebuilt-\d+/g) ?? [])
    ]
    const inTheScript = packagesNamedIn(scriptOfTheTab())
    expect(inTheScript).toHaveLength(1)
    expect(hookSettingsDirs.flatMap(packagesNamedIn)).toEqual(inTheScript)
    expect(packagesNamedIn(tab.started[0].typedLine ?? '')).toEqual(inTheScript)
  })

  it('an Antigravity session on a machine that wants a password first is refused while its settings there are read, in the words that say where to sign in, and opens no tab', async () => {
    const tab = agyWith(
      {},
      {},
      recordingSsh(() => SSH_WANTS_A_PASSWORD)
    )
    await expect(agyTabOn(tab)).rejects.toThrow(
      'sign in through a Claude Code or Codex session there first'
    )
    expect(tab.started).toHaveLength(0)
    expect(tab.ssh.ran).toHaveLength(1)
    expect(tab.ssh.ran[0]).toContain('antigravity-cli/settings.json')
  })
})
