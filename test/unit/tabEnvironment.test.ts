import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance
} from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'

const terminal = vi.hoisted(() => {
  const proc = {
    pid: 4242,
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
    process: 'zsh'
  }
  return { spawn: vi.fn((..._args: unknown[]) => proc) }
})
vi.mock('node-pty', () => ({ spawn: terminal.spawn }))

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-tab-environment-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

afterAll(async () => {
  await BackgroundFile.whenAllWritten()
  fs.rmSync(app.getPath('userData'), { recursive: true, force: true })
})

vi.mock('../../src/main/cliRuntime', () => ({
  resolveCliRuntime: async (spec: {
    command: string
    environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  }) => ({
    binary: `/fixture/${spec.command}`,
    env: spec.environment({ ...process.env }),
    version: '999.0.0',
    verified: true
  })
}))

const codexServer = vi.hoisted(() => ({
  started: [] as { env?: NodeJS.ProcessEnv; sessionEnv?: Record<string, string> }[]
}))
vi.mock('../../src/agents/codex/main/codexTransport', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agents/codex/main/codexTransport')>()
  const { CodexRpcThatListsNoHooks } = await import('./helpers/codexRpcStub')
  return {
    ...real,
    createCodexTransport: async (options: (typeof codexServer.started)[number]) => {
      codexServer.started.push(options)
      return { url: 'unix:///test/rpc.sock', stop: async () => {}, request: async () => ({}) }
    },
    CodexRpc: CodexRpcThatListsNoHooks
  }
})

import { BROWSER_TAB_ENV } from '@shared/browserTabEnv'
import { codexEnvironment } from '../../src/agents/codex/main/codexTransport'
import { PtyManager } from '../../src/main/ptyManager'
import { BackgroundFile } from '../../src/main/backgroundFile'
import {
  agySessionsIn,
  claudeBackendIn,
  codexSessionsIn,
  makeWorld,
  ON_THE_MACHINE,
  recordingSsh,
  sameOnEveryRun,
  type World
} from './helpers/agentTabs'

const TAB = 'pty-t1'
const PINNED = './tab-environment'
const KOLOFT_SHIM = { hookSettings: (): undefined => undefined }

const OF_THE_USERS_OWN_LOGIN = {
  PATH: '/usr/bin:/bin',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  TERM: 'dumb',
  TERM_PROGRAM: 'iTerm.app',
  COLORTERM: '24bit',
  GEMINI_API_KEY: 'the-users-own-gemini-key',
  ANTHROPIC_API_KEY: 'the-users-own-anthropic-key',
  ANTHROPIC_AUTH_TOKEN: 'the-users-own-anthropic-token',
  OPENAI_API_KEY: 'the-users-own-openai-key',
  CODEX_API_KEY: 'the-users-own-codex-key'
}
const OF_A_CLAUDE_CODE_SESSION = {
  CLAUDECODE: '1',
  CLAUDE_EFFORT: 'high',
  CLAUDE_JOB_DIR: '/parent/.claude/jobs/5d5cfc93',
  CLAUDE_PID: '54978',
  AI_AGENT: 'claude-code_2-1-331_agent',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SESSION_ID: 'parent-session',
  CLAUDE_CODE_OAUTH_TOKEN: 'token-of-the-parent-session'
}
const OF_AN_ANTIGRAVITY_SESSION = {
  ANTIGRAVITY_AGENT: '1',
  ANTIGRAVITY_CONVERSATION_ID: 'parent-conversation',
  KOLOFT_AGY_LOG: '/parent-koloft/agy-open/parent/agy.jsonl',
  KOLOFT_AGY_START: '/parent-koloft/agy-open/parent/agy-session-start.json',
  KOLOFT_AGY_COST: '/parent-koloft/agy-open/parent/agy-cost',
  KOLOFT_AGY_OWNER_TITLE: '/parent-koloft/owner-title.sh',
  KOLOFT_NOTICE: '/parent-koloft/hook-sessions/pty-parent-1.notice'
}
const OF_A_CODEX_SESSION = {
  CODEX_THREAD_ID: 'parent-thread',
  CODEX_SESSION_ID: 'parent-codex-session',
  CODEX_SHELL: '1',
  CODEX_CI: '1',
  KOLOFT_CODEX_SAID: '/parent-koloft/codex-open/parent/said',
  KOLOFT_CODEX_DISCORD_SAID: '/parent-koloft/hook-sessions/pty-parent-1.discord-said',
  KOLOFT_CODEX_REPLY_LANGUAGE: '/parent-koloft/codex-reply-language.sh',
  KOLOFT_SHELL_WROTE: '/parent-koloft/hook-sessions/pty-parent-1.shell-wrote.jsonl'
}
const OF_THE_KOLOFT_TAB_IT_WAS_STARTED_IN = {
  KOLOFT_TAB_ID: 'pty-parent-1',
  KOLOFT_TAB_PASS: 'pass-of-the-parent-tab',
  KOLOFT_PID: '1',
  KOLOFT_SESSION_DIR: '/parent-koloft/reg',
  KOLOFT_OPEN_DIR: '/parent-koloft/opens',
  KOLOFT_PICK_DIR: '/parent-koloft/picks',
  KOLOFT_CDP_DIR: '/parent-koloft/cdp',
  KOLOFT_HOOK_SETTINGS: '/parent-koloft/hooks/pty-parent-1.json',
  KOLOFT_AGENT_DIR: '/parent-koloft/agent',
  KOLOFT_AGENT_PLUGIN: '/parent-koloft/agent-plugin',
  KOLOFT_AGENT_PROMPT: '/parent-koloft/agent-plugin/koloft-prompt.md',
  KOLOFT_DOCS_PLUGIN: '/parent-koloft/docs-plugin',
  KOLOFT_FIRST_PROMPT: 'the first prompt of the parent tab',
  KOLOFT_SESSION_NAME: 'ParentName',
  KOLOFT_PICTURE_FOLDER: '/parent-koloft/pictures',
  KOLOFT_OWNER_TEXT: 'the owner text of the parent tab',
  KOLOFT_PORT_OFFSET: '99',
  KOLOFT_UTIL: '1',
  KOLOFT_KEYCHAIN_FILE: '/parent-koloft/keychain.json',
  ANT_ACCOUNT: 'whoever-started-koloft',
  TERM_SESSION_ID: 'w0t1p0:ABC',
  ...Object.fromEntries(BROWSER_TAB_ENV.map((name) => [name, `of-the-parent-tab:${name}`]))
}

let world: World
let inherited: Record<string, string>
let stops: (() => Promise<void>)[]
let loginShellOfWhoeverRunsTheTests: MockInstance

beforeEach(() => {
  loginShellOfWhoeverRunsTheTests = vi
    .spyOn(os, 'userInfo')
    .mockReturnValue({ ...os.userInfo(), shell: '/bin/zsh' })
  world = makeWorld()
  fs.mkdirSync(path.join(world.home, 'tmp'))
  inherited = {
    HOME: world.home,
    TMPDIR: path.join(world.home, 'tmp'),
    ...OF_THE_USERS_OWN_LOGIN,
    ...OF_A_CLAUDE_CODE_SESSION,
    ...OF_AN_ANTIGRAVITY_SESSION,
    ...OF_A_CODEX_SESSION,
    ...OF_THE_KOLOFT_TAB_IT_WAS_STARTED_IN
  }
  terminal.spawn.mockClear()
  codexServer.started.length = 0
  stops = []
})

afterEach(async () => {
  for (const stop of stops) await stop()
  loginShellOfWhoeverRunsTheTests.mockRestore()
  await world.gone()
})

function nothingButThis(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(process.env)) delete process.env[name]
  Object.assign(process.env, env)
}

async function whileKoloftsOwnEnvironmentIsOnlyWhatItInherited<T>(
  start: () => T | Promise<T>
): Promise<T> {
  const ofThisTestRun = { ...process.env }
  nothingButThis(inherited)
  try {
    return await start()
  } finally {
    nothingButThis(ofThisTestRun)
  }
}

function koloftsTerminals(): PtyManager {
  const terminals = new PtyManager()
  terminals.shimDir = '/koloft/shim'
  terminals.regDir = world.regDir
  terminals.openDir = '/koloft/opens'
  terminals.pickDir = '/koloft/picks'
  terminals.cdpDir = '/koloft/cdp'
  terminals.agentDir = '/koloft/agent'
  return terminals
}

function asATable(env: NodeJS.ProcessEnv): string {
  const set = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${name === 'KOLOFT_PID' ? '<pid of this Koloft>' : value}`)
  const cleared = Object.keys(inherited)
    .filter((name) => env[name] === undefined)
    .sort()
  return sameOnEveryRun(
    [
      '=== everything the process gets ===',
      ...set,
      '=== cleared: inherited, and not handed on ===',
      ...cleared
    ].join('\n'),
    world
  )
}

function ofTheLastTerminalStarted(): string {
  const [, , opts] = terminal.spawn.mock.calls.at(-1) as [
    string,
    string[],
    { env: NodeJS.ProcessEnv }
  ]
  return asATable(opts.env)
}

const pin = (table: string, name: string): Promise<void> =>
  expect(table).toMatchFileSnapshot(`${PINNED}/${name}.txt`)

const claudeTab = (cwd: string): Promise<string> =>
  whileKoloftsOwnEnvironmentIsOnlyWhatItInherited(async () => {
    const backend = claudeBackendIn(world, koloftsTerminals(), {
      machine: { run: recordingSsh().run }
    })
    const made = await backend.create({ kind: 'claude', cwd, tabId: TAB })
    if (!made.ok) throw new Error(`launch refused: ${made.code}`)
    return ofTheLastTerminalStarted()
  })

const agyTab = (cwd: string): Promise<string> =>
  whileKoloftsOwnEnvironmentIsOnlyWhatItInherited(async () => {
    const sessions = agySessionsIn(world, koloftsTerminals(), {
      machine: { run: recordingSsh().run },
      apiKey: 'api-key-of-the-koloft-account'
    })
    stops.push(() => sessions.stopAll())
    await sessions.launch({ kind: 'agy', cwd, tabId: TAB, trustFolder: true })
    return ofTheLastTerminalStarted()
  })

const codexTab = (cwd: string): Promise<{ tab: string; server: string }> =>
  whileKoloftsOwnEnvironmentIsOnlyWhatItInherited(async () => {
    const sessions = codexSessionsIn(world, koloftsTerminals(), {
      ranOnTheMachine: [],
      run: () => ({ code: 1, stdout: '', stderr: '' })
    })
    stops.push(() => sessions.stopAll())
    await sessions.launch({ kind: 'codex', cwd, tabId: TAB })
    const server = codexServer.started.at(-1)!
    return {
      tab: ofTheLastTerminalStarted(),
      server: asATable({ ...codexEnvironment(server.env), ...server.sessionEnv })
    }
  })

describe('the environment each kind of tab hands its process when Koloft itself was started from inside a session of every agent, with the user’s own keys set too — pinned so that moving the rules changes no cell', () => {
  it('a Claude Code tab on this Mac', async () =>
    pin(await claudeTab(world.repo), 'claude-on-this-mac'))

  it('a Claude Code tab over SSH (the shell on this Mac that runs ssh)', async () =>
    pin(await claudeTab(ON_THE_MACHINE), 'claude-over-ssh'))

  it('a Codex tab on this Mac, and the server behind it', async () => {
    const { tab, server } = await codexTab(world.repo)
    await pin(tab, 'codex-on-this-mac')
    await pin(server, 'codex-on-this-mac-its-server')
  })

  it('a Codex tab over SSH (the screen on this Mac), and what its relay on this Mac is started with', async () => {
    const { tab, server } = await codexTab(ON_THE_MACHINE)
    await pin(tab, 'codex-over-ssh')
    await pin(server, 'codex-over-ssh-its-relay')
  })

  it('an Antigravity tab on this Mac', async () => pin(await agyTab(world.repo), 'agy-on-this-mac'))

  it('an Antigravity tab over SSH (the shell on this Mac that runs ssh)', async () =>
    pin(await agyTab(ON_THE_MACHINE), 'agy-over-ssh'))

  it('a plain terminal tab, and a Workbench terminal of a session', async () => {
    const { plain, workbench } = await whileKoloftsOwnEnvironmentIsOnlyWhatItInherited(() => {
      const terminals = koloftsTerminals()
      const session = terminals.create({ kind: 'shell', koloftShim: KOLOFT_SHIM, cwd: world.repo })
      const ofThePlainOne = ofTheLastTerminalStarted()
      terminals.create({
        kind: 'shell',
        koloftShim: KOLOFT_SHIM,
        cwd: world.repo,
        util: true,
        ownerTabId: session.id,
        id: 'pty-workbench-1'
      })
      return {
        plain: ofThePlainOne.replaceAll(session.id, '<tab id>'),
        workbench: ofTheLastTerminalStarted().replaceAll(session.id, '<tab id of its session>')
      }
    })
    await pin(plain, 'plain-terminal')
    await pin(workbench, 'workbench-terminal')
  })

  it("what Codex's version probe runs with", async () =>
    pin(
      await whileKoloftsOwnEnvironmentIsOnlyWhatItInherited(() =>
        asATable(codexEnvironment({ ...process.env }))
      ),
      'codex-version-probe'
    ))
})
