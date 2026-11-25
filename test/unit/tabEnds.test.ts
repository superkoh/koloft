import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-tab-ends-'))
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

import type { SessionEvent } from '@shared/sessionEvent'
import { PLACEHOLDER_SESSION_TITLE } from '@shared/types'
import { ClaudeBackend, type ClaudeBackendDeps } from '../../src/agents/claude/main/backend'
import { SessionTracker } from '../../src/agents/claude/main/sessionTracker'
import { SessionRuntime } from '../../src/core/agent/sessionRuntime'
import { TAB_TORN_DOWN, type Moment, type TabEnded } from '../../src/core/moment'
import { BackgroundFile } from '../../src/main/backgroundFile'
import { TabLifecycle, subscribeTabSubsystems } from '../../src/plugins/sessions/main/tabLifecycle'
import {
  agySessionsIn,
  codexSessionsIn,
  LOGIN_PATH_ON_THE_MACHINE,
  makeWorld,
  ON_THE_MACHINE,
  recordingPty,
  recordingSsh,
  type World
} from './helpers/agentTabs'

const CLAUDE_TAB = 'pty-claude'
const CODEX_TAB = 'pty-codex'
const AGY_TAB = 'pty-agy'
const CLAUDE_SESSION = '3c4ac765-c402-4d6d-88ac-dca81e2a35f1'

type Sent = [string, SessionEvent]

function terminalOf(tabId: string): { pty: unknown; killed: string[] } {
  const killed: string[] = []
  const { pty } = recordingPty(tabId)
  return { killed, pty: { ...(pty as object), kill: (id: string) => void killed.push(id) } }
}

interface ThreeAgents {
  lifecycle: TabLifecycle
  claude: { tracker: SessionTracker; sent: Sent[] }
  codex: { sessions: ReturnType<typeof codexSessionsIn>; sent: Sent[]; killed: string[] }
  agy: {
    sessions: ReturnType<typeof agySessionsIn>
    sent: Sent[]
    killed: string[]
    ranOverSsh: string[]
  }
  whenTornDown: ((exit: TabEnded) => void)[]
}

let world: World
let stops: (() => Promise<void> | void)[]
let toasts: string[]

beforeEach(() => {
  world = makeWorld()
  stops = []
  toasts = []
})

afterEach(async () => {
  for (const stop of stops) await stop()
  await BackgroundFile.whenAllWritten()
  world.gone()
  expect(toasts, 'a tab that ends without a failed stop shows no toast').toEqual([])
})

async function aTabOfEveryAgent(): Promise<ThreeAgents> {
  const claudeSent: Sent[] = []
  const tracker = new SessionTracker(new SessionRuntime())
  const claude = new ClaudeBackend({
    pty: terminalOf(CLAUDE_TAB).pty,
    tracker,
    workspaces: () => null,
    userData: () => world.userData,
    events: (tabId: string, event: SessionEvent) => claudeSent.push([tabId, event])
  } as unknown as ClaudeBackendDeps)
  claude.watchLocalHooks(world.regDir)
  tracker.track(CLAUDE_TAB, world.repo)
  tracker.bindSession(
    CLAUDE_TAB,
    path.join(world.home, 'transcripts', `${CLAUDE_SESSION}.jsonl`),
    CLAUDE_SESSION,
    world.repo
  )
  stops.push(() => tracker.untrack(CLAUDE_TAB))

  const codexSent: Sent[] = []
  const codexTerminal = terminalOf(CODEX_TAB)
  const codex = codexSessionsIn(world, codexTerminal.pty, {
    ranOnTheMachine: [],
    run: () => ({ code: 1, stdout: '', stderr: '' }),
    events: (tabId, event) => codexSent.push([tabId, event])
  })
  stops.push(() => codex.stopAll())
  await codex.launch({ kind: 'codex', cwd: ON_THE_MACHINE, tabId: CODEX_TAB })

  const agySent: Sent[] = []
  const agyTerminal = terminalOf(AGY_TAB)
  const ssh = recordingSsh()
  const agy = agySessionsIn(world, agyTerminal.pty, {
    apiKey: 'api-key-of-the-koloft-account',
    machine: { run: ssh.run, loginPath: async () => LOGIN_PATH_ON_THE_MACHINE },
    events: (tabId, event) => agySent.push([tabId, event])
  })
  stops.push(() => agy.stopAll())
  await agy.launch({ kind: 'agy', cwd: ON_THE_MACHINE, tabId: AGY_TAB })

  const whenTornDown: ((exit: TabEnded) => void)[] = []
  const lifecycle = new TabLifecycle()
  subscribeTabSubsystems(lifecycle, {
    attention: { clear: () => {}, tabStopping: () => {} },
    claude,
    tracker,
    storedOwnerOf: (tabId) => [codex, agy].find((sessions) => sessions.hasTab(tabId)),
    toast: (message) => void toasts.push(message),
    workspaces: () => null,
    announce: <T>(moment: Moment<T>, m: T) => {
      if (moment.name === TAB_TORN_DOWN.name) for (const heard of whenTornDown) heard(m as TabEnded)
    }
  })
  return {
    lifecycle,
    claude: { tracker, sent: claudeSent },
    codex: { sessions: codex, sent: codexSent, killed: codexTerminal.killed },
    agy: { sessions: agy, sent: agySent, killed: agyTerminal.killed, ranOverSsh: ssh.ran },
    whenTornDown
  }
}

const ended = (tabId: string, over: Partial<TabEnded> = {}): TabEnded => ({
  tabId,
  exitCode: 0,
  asleep: false,
  crashed: false,
  sessionGoesOn: false,
  ...over
})

const crashed = (tabId: string): TabEnded => ended(tabId, { exitCode: 1, crashed: true })

const claudeTabNow = (a: ThreeAgents): unknown => ({
  alive: a.claude.tracker.infoOf(CLAUDE_TAB)?.alive,
  session: a.claude.tracker.infoOf(CLAUDE_TAB)?.sessionId,
  sent: [...a.claude.sent]
})

const storedTabNow = (of: ThreeAgents['codex'] | ThreeAgents['agy'], tabId: string): unknown => ({
  open: of.sessions.hasTab(tabId),
  countsOnItsAccount: of.sessions.launchedSessions().some((s) => s.tabId === tabId),
  sent: [...of.sent],
  killed: [...of.killed]
})

const OPEN_AND_LEFT_ALONE = { open: true, countsOnItsAccount: true, killed: [] }

const A_STOP_STARTED_BY_MISTAKE_SHOWS_WITHIN_MS = 50

const pastAnyStopStartedByMistake = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, A_STOP_STARTED_BY_MISTAKE_SHOWS_WITHIN_MS))

const REPORTED_AS_EXITED_UNCLEANLY: Sent = [
  CLAUDE_TAB,
  { type: 'exited', clean: false, title: PLACEHOLDER_SESSION_TITLE, sessionId: CLAUDE_SESSION }
]

describe('a session tab whose terminal ended, told to the three agents as the app tells them', () => {
  it('Claude Code: a tab on this Mac whose claude died without an end report is reported as exited with its session and its title, and its row is no longer alive', async () => {
    const a = await aTabOfEveryAgent()
    a.lifecycle.emit('teardown', crashed(CLAUDE_TAB))
    expect(a.claude.sent).toEqual([REPORTED_AS_EXITED_UNCLEANLY])
    expect(a.claude.tracker.infoOf(CLAUDE_TAB)?.alive).toBe(false)
  })

  it('Codex: a tab whose terminal ended is stopped, its terminal is let go and it is reported as ended cleanly', async () => {
    const a = await aTabOfEveryAgent()
    a.lifecycle.emit('teardown', ended(CODEX_TAB))
    await vi.waitFor(() => expect(a.codex.sessions.hasTab(CODEX_TAB)).toBe(false))
    expect(a.codex.killed).toEqual([CODEX_TAB])
    expect(a.codex.sent).toEqual([
      [CODEX_TAB, { type: 'exited', clean: true, title: undefined, sessionId: undefined }]
    ])
  })

  it('Antigravity: a tab whose terminal ended is stopped, its tmux session on the machine is ended, its terminal is let go and it is reported as ended cleanly', async () => {
    const a = await aTabOfEveryAgent()
    const ranBefore = a.agy.ranOverSsh.length
    a.lifecycle.emit('teardown', ended(AGY_TAB))
    await vi.waitFor(() => expect(a.agy.sessions.hasTab(AGY_TAB)).toBe(false))
    expect(a.agy.ranOverSsh.slice(ranBefore).join('\n')).toContain('kill-session')
    expect(a.agy.killed).toEqual([AGY_TAB])
    expect(a.agy.sent).toEqual([
      [AGY_TAB, { type: 'exited', clean: true, title: undefined, sessionId: undefined }]
    ])
  })
})

describe('a tab of one agent that ends is nothing to the other two', () => {
  it("Claude Code's tab crashes: the Codex tab and the Antigravity tab stay open, still count on their accounts, send no event, and their terminals are not let go", async () => {
    const a = await aTabOfEveryAgent()
    const codexBefore = storedTabNow(a.codex, CODEX_TAB)
    const agyBefore = storedTabNow(a.agy, AGY_TAB)
    a.lifecycle.emit('teardown', crashed(CLAUDE_TAB))
    expect(a.claude.sent).toEqual([REPORTED_AS_EXITED_UNCLEANLY])
    await pastAnyStopStartedByMistake()
    expect(storedTabNow(a.codex, CODEX_TAB)).toEqual(codexBefore)
    expect(storedTabNow(a.agy, AGY_TAB)).toEqual(agyBefore)
    expect(codexBefore).toMatchObject(OPEN_AND_LEFT_ALONE)
    expect(agyBefore).toMatchObject(OPEN_AND_LEFT_ALONE)
  })

  it("Codex's tab crashes: Claude Code's row stays alive on its session and Claude Code sends no event, and the Antigravity tab is untouched", async () => {
    const a = await aTabOfEveryAgent()
    const claudeBefore = claudeTabNow(a)
    const agyBefore = storedTabNow(a.agy, AGY_TAB)
    a.lifecycle.emit('teardown', crashed(CODEX_TAB))
    await vi.waitFor(() => expect(a.codex.sessions.hasTab(CODEX_TAB)).toBe(false))
    await pastAnyStopStartedByMistake()
    expect(claudeTabNow(a)).toEqual(claudeBefore)
    expect(claudeBefore).toEqual({ alive: true, session: CLAUDE_SESSION, sent: [] })
    expect(storedTabNow(a.agy, AGY_TAB)).toEqual(agyBefore)
    expect(agyBefore).toMatchObject(OPEN_AND_LEFT_ALONE)
  })

  it("Antigravity's tab crashes: Claude Code's row stays alive on its session and Claude Code sends no event, and the Codex tab is untouched", async () => {
    const a = await aTabOfEveryAgent()
    const claudeBefore = claudeTabNow(a)
    const codexBefore = storedTabNow(a.codex, CODEX_TAB)
    a.lifecycle.emit('teardown', crashed(AGY_TAB))
    await vi.waitFor(() => expect(a.agy.sessions.hasTab(AGY_TAB)).toBe(false))
    await pastAnyStopStartedByMistake()
    expect(claudeTabNow(a)).toEqual(claudeBefore)
    expect(claudeBefore).toEqual({ alive: true, session: CLAUDE_SESSION, sent: [] })
    expect(storedTabNow(a.codex, CODEX_TAB)).toEqual(codexBefore)
    expect(codexBefore).toMatchObject(OPEN_AND_LEFT_ALONE)
  })
})

describe('an agent told of the end of a tab that is not its own, as each will be once every agent is told of every tab', () => {
  it('Codex stops nothing: its own tab stays open, still counts on its account, sends no event and keeps its terminal', async () => {
    const a = await aTabOfEveryAgent()
    const before = storedTabNow(a.codex, CODEX_TAB)
    await a.codex.sessions.stop(CLAUDE_TAB, 1)
    await a.codex.sessions.stop(AGY_TAB, 0)
    await pastAnyStopStartedByMistake()
    expect(storedTabNow(a.codex, CODEX_TAB)).toEqual(before)
    expect(before).toMatchObject(OPEN_AND_LEFT_ALONE)
  })

  it('Antigravity stops nothing: its own tab stays open, still counts on its account, sends no event, keeps its terminal and runs nothing on the machine', async () => {
    const a = await aTabOfEveryAgent()
    const before = storedTabNow(a.agy, AGY_TAB)
    const ranBefore = a.agy.ranOverSsh.length
    await a.agy.sessions.stop(CLAUDE_TAB, 1)
    await a.agy.sessions.stop(CODEX_TAB, 0)
    await pastAnyStopStartedByMistake()
    expect(storedTabNow(a.agy, AGY_TAB)).toEqual(before)
    expect(before).toMatchObject(OPEN_AND_LEFT_ALONE)
    expect(a.agy.ranOverSsh.slice(ranBefore)).toEqual([])
  })
})

describe('what the plugins find when they hear that a tab was torn down', () => {
  it('a Codex or Antigravity tab is already being stopped, so it no longer counts on its account, though its stop has not finished and the tab is still there', async () => {
    const a = await aTabOfEveryAgent()
    const heard: unknown[] = []
    a.whenTornDown.push(({ tabId }) => {
      const of = tabId === CODEX_TAB ? a.codex : a.agy
      heard.push({
        tabId,
        open: of.sessions.hasTab(tabId),
        countsOnItsAccount: of.sessions.launchedSessions().some((s) => s.tabId === tabId)
      })
    })
    a.lifecycle.emit('teardown', ended(CODEX_TAB))
    a.lifecycle.emit('teardown', ended(AGY_TAB))
    expect(heard).toEqual([
      { tabId: CODEX_TAB, open: true, countsOnItsAccount: false },
      { tabId: AGY_TAB, open: true, countsOnItsAccount: false }
    ])
    await vi.waitFor(() => {
      expect(a.codex.sessions.hasTab(CODEX_TAB)).toBe(false)
      expect(a.agy.sessions.hasTab(AGY_TAB)).toBe(false)
    })
  })

  it("Claude Code's crashed tab has already been reported as exited and its row is no longer alive", async () => {
    const a = await aTabOfEveryAgent()
    const heard: unknown[] = []
    a.whenTornDown.push(() => heard.push(claudeTabNow(a)))
    a.lifecycle.emit('teardown', crashed(CLAUDE_TAB))
    expect(heard).toEqual([
      { alive: false, session: CLAUDE_SESSION, sent: [REPORTED_AS_EXITED_UNCLEANLY] }
    ])
  })
})
