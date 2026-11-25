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
import { ClaudeSessionStore } from '../../src/agents/claude/main/claudeSessionStore'
import { SessionTracker } from '../../src/agents/claude/main/sessionTracker'
import { agyBackend } from '../../src/agents/agy/main/backend'
import { codexBackend } from '../../src/agents/codex/main/backend'
import { agentManifest } from '../../src/core/agent/registry'
import { SessionBackends } from '../../src/core/agent/sessionBackends'
import { SESSION_BACKENDS } from '../../src/shared/sessionBackend'
import { SessionRuntime } from '../../src/core/agent/sessionRuntime'
import { TAB_TORN_DOWN, type Moment, type TabEnded } from '../../src/core/moment'
import { TabLifecycle, subscribeTabSubsystems } from '../../src/plugins/sessions/main/tabLifecycle'
import {
  agySessionsIn,
  codexSessionsIn,
  LOGIN_PATH_ON_THE_MACHINE,
  MACHINE,
  makeWorld,
  ON_THE_MACHINE,
  recordingPty,
  recordingSsh,
  sameOnEveryRun,
  type World
} from './helpers/agentTabs'
import { lifecycle as nothingListensToTheSessions } from './helpers/sessionBackendStub'

const CLAUDE_TAB = 'pty-claude'
const CODEX_TAB = 'pty-codex'
const AGY_TAB = 'pty-agy'
const CLAUDE_TAB_STILL_STARTING = 'pty-claude-starting'
const CLAUDE_SESSION = '3c4ac765-c402-4d6d-88ac-dca81e2a35f1'

type Sent = [string, SessionEvent]

const NO_RESUME_IS_PLANNED_HERE = {} as Parameters<typeof codexBackend>[1]

function terminalOf(tabId: string): {
  pty: unknown
  killed: string[]
  machineNamed: (string | undefined)[]
} {
  const killed: string[] = []
  const machineNamed: (string | undefined)[] = []
  const { pty } = recordingPty(tabId)
  const recorded = pty as { create(args: { remoteHost?: string }): unknown }
  return {
    killed,
    machineNamed,
    pty: {
      ...(pty as object),
      create: (args: { remoteHost?: string }) => {
        machineNamed.push(args.remoteHost)
        return recorded.create(args)
      },
      kill: (id: string) => void killed.push(id)
    }
  }
}

type ThreeAgents = Awaited<ReturnType<typeof aTabOfEveryAgent>>
type StoredAgent = 'codex' | 'agy'

const STORED = [
  ['Codex', 'codex', 'agy'],
  ['Antigravity', 'agy', 'codex']
] as const

const TAB_OF = { codex: CODEX_TAB, agy: AGY_TAB } as const

let world: World
let stops: (() => Promise<void> | void)[]
let toasts: string[]

beforeEach(() => {
  world = makeWorld()
  stops = []
  toasts = []
})

async function theWorldEnds(): Promise<void> {
  try {
    for (const stop of stops) await stop()
  } finally {
    await world.gone()
  }
}

afterEach(async () => {
  await theWorldEnds()
  expect(toasts, 'a tab that ends without a failed stop shows no toast').toEqual([])
})

async function aTabOfEveryAgent() {
  const sentInOrder: [string, ...Sent][] = []
  const whenRowsReread: (() => void)[] = []
  const claudeSent: Sent[] = []
  const tracker = new SessionTracker(new SessionRuntime())
  const keptInLayout: string[] = []
  let rowsReread = 0
  const store = new ClaudeSessionStore({
    projectsRoot: path.join(world.home, '.claude', 'projects'),
    remoteProjectsRoot: (host) => path.join(world.home, 'mirror', host),
    pinnedPaths: () => [world.repo],
    remoteTargets: () => [],
    kept: {
      list: () => keptInLayout,
      add: (ids) => void keptInLayout.push(...ids),
      remove: (id) =>
        void keptInLayout.splice(0, keptInLayout.length, ...without(keptInLayout, id)),
      keepOnly: (ids) => void keptInLayout.splice(0, keptInLayout.length, ...ids)
    },
    rereadRows: () => {
      rowsReread++
      for (const reread of whenRowsReread) reread()
    },
    rereadGrownRows: () => {},
    runningBindings: () => new Map()
  })
  stops.push(() => store.dispose())
  const claude = new ClaudeBackend({
    pty: terminalOf(CLAUDE_TAB).pty,
    tracker,
    store: () => store,
    userData: () => world.userData,
    events: (tabId: string, event: SessionEvent) => {
      claudeSent.push([tabId, event])
      sentInOrder.push(['claude', tabId, event])
    }
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
    events: (tabId, event) => {
      codexSent.push([tabId, event])
      sentInOrder.push(['codex', tabId, event])
    }
  })
  stops.push(() => codex.stopAll())
  await codex.launch({ kind: 'codex', cwd: ON_THE_MACHINE, tabId: CODEX_TAB })

  const agySent: Sent[] = []
  const agyTerminal = terminalOf(AGY_TAB)
  const ssh = recordingSsh()
  const agy = agySessionsIn(world, agyTerminal.pty, {
    apiKey: 'api-key-of-the-koloft-account',
    machine: { run: ssh.run, loginPath: async () => LOGIN_PATH_ON_THE_MACHINE },
    events: (tabId, event) => {
      agySent.push([tabId, event])
      sentInOrder.push(['agy', tabId, event])
    }
  })
  stops.push(() => agy.stopAll())
  await agy.launch({ kind: 'agy', cwd: ON_THE_MACHINE, tabId: AGY_TAB })

  const whenTornDown: ((exit: TabEnded) => void)[] = []
  const lifecycle = new TabLifecycle()
  const backends = new SessionBackends(nothingListensToTheSessions())
  const agyAsABackend = agyBackend(agy, NO_RESUME_IS_PLANNED_HERE, () => NO_RESUME_IS_PLANNED_HERE)
  const codexAsABackend = codexBackend(
    codex,
    NO_RESUME_IS_PLANNED_HERE,
    () => NO_RESUME_IS_PLANNED_HERE,
    async () => {},
    async () => undefined
  )
  for (const backend of [claude, agyAsABackend, codexAsABackend]) backends.register(backend)
  subscribeTabSubsystems(lifecycle, {
    attention: { clear: () => {}, tabStopping: () => {} },
    backends,
    toast: (message) => void toasts.push(message),
    workspaces: () => null,
    announce: <T>(moment: Moment<T>, m: T) => {
      if (moment.name === TAB_TORN_DOWN.name) for (const heard of whenTornDown) heard(m as TabEnded)
    }
  })
  return {
    lifecycle,
    claude: { backend: claude, tracker, store, sent: claudeSent, rowsReread: () => rowsReread },
    codex: {
      backend: codexAsABackend,
      sessions: codex,
      sent: codexSent,
      killed: codexTerminal.killed
    },
    agy: {
      backend: agyAsABackend,
      sessions: agy,
      sent: agySent,
      killed: agyTerminal.killed,
      machineNamed: agyTerminal.machineNamed,
      ranOverSsh: ssh.ran
    },
    whenTornDown,
    whenRowsReread,
    sentInOrder
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
  sent: [...a.claude.sent],
  rowsReread: a.claude.rowsReread()
})

const without = (ids: string[], gone: string): string[] => ids.filter((id) => id !== gone)

const storedTabNow = (a: ThreeAgents, agent: StoredAgent): unknown => ({
  open: a[agent].sessions.hasTab(TAB_OF[agent]),
  countsOnItsAccount: a[agent].sessions.launchedSessions().some((s) => s.tabId === TAB_OF[agent]),
  sent: [...a[agent].sent],
  killed: [...a[agent].killed]
})

const A_STOP_IS_LOOKED_FOR_EVERY_MS = 5
const A_STOP_ON_A_BUSY_MACHINE_ENDS_WITHIN_MS = 10_000

const stoppedAndGone = (a: ThreeAgents, agent: StoredAgent): Promise<void> =>
  vi.waitFor(() => expect(a[agent].sessions.hasTab(TAB_OF[agent])).toBe(false), {
    interval: A_STOP_IS_LOOKED_FOR_EVERY_MS,
    timeout: A_STOP_ON_A_BUSY_MACHINE_ENDS_WITHIN_MS
  })

const OPEN_AND_LEFT_ALONE = { open: true, countsOnItsAccount: true, killed: [] }

const A_STOP_STARTED_BY_MISTAKE_SHOWS_WITHIN_MS = 50

const pastAnyStopStartedByMistake = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, A_STOP_STARTED_BY_MISTAKE_SHOWS_WITHIN_MS))

const REPORTED_AS_EXITED_UNCLEANLY: Sent = [
  CLAUDE_TAB,
  { type: 'exited', clean: false, title: PLACEHOLDER_SESSION_TITLE, sessionId: CLAUDE_SESSION }
]

describe('a session tab whose terminal ended, told to the three real backends through the teardown wiring', () => {
  it('Claude Code: a tab on this Mac whose claude died without an end report is reported as exited with its session and its title, and its row is no longer alive', async () => {
    const a = await aTabOfEveryAgent()
    a.lifecycle.emit('teardown', crashed(CLAUDE_TAB))
    expect(a.claude.sent).toEqual([REPORTED_AS_EXITED_UNCLEANLY])
    expect(a.claude.tracker.infoOf(CLAUDE_TAB)?.alive).toBe(false)
  })

  it('Claude Code: a tab on this Mac whose terminal ended without a crash and without an end report sends no event, and its row is no longer alive', async () => {
    const a = await aTabOfEveryAgent()
    a.lifecycle.emit('teardown', ended(CLAUDE_TAB))
    expect(claudeTabNow(a)).toEqual({
      alive: false,
      session: CLAUDE_SESSION,
      sent: [],
      rowsReread: 0
    })
  })

  it('Claude Code: a tab on this Mac whose claude wrote its end report and then exited with a failure is not reported as exited a second time, and its row is no longer alive', async () => {
    const a = await aTabOfEveryAgent()
    fs.writeFileSync(
      path.join(world.regDir, `${CLAUDE_TAB}.json`),
      JSON.stringify({
        event: 'end',
        reason: 'other',
        tabId: CLAUDE_TAB,
        sessionId: CLAUDE_SESSION
      })
    )
    a.lifecycle.emit('teardown', crashed(CLAUDE_TAB))
    expect(claudeTabNow(a)).toEqual({
      alive: false,
      session: CLAUDE_SESSION,
      sent: [],
      rowsReread: 0
    })
  })

  it.each(STORED)(
    '%s: a tab whose program ended with exit code 0 is stopped, its terminal is let go and it is reported as ended cleanly',
    async (_name, agent) => {
      const a = await aTabOfEveryAgent()
      a.lifecycle.emit('teardown', ended(TAB_OF[agent]))
      await stoppedAndGone(a, agent)
      expect(a[agent].killed).toEqual([TAB_OF[agent]])
      expect(a[agent].sent).toEqual([
        [TAB_OF[agent], { type: 'exited', clean: true, title: undefined, sessionId: undefined }]
      ])
    }
  )

  it.each([
    ['Codex', 'was killed by a signal', 'codex', { exitCode: 0, signal: 15 }],
    ['Codex', 'ended with a failure', 'codex', { exitCode: 1 }],
    ['Antigravity', 'was killed by a signal', 'agy', { exitCode: 0, signal: 15 }],
    ['Antigravity', 'ended with a failure', 'agy', { exitCode: 1 }]
  ] as const)(
    '%s: a tab whose program %s before any session was bound is stopped and its terminal is let go, with no word that it ended cleanly',
    async (_name, _how, agent, exit) => {
      const a = await aTabOfEveryAgent()
      a.lifecycle.emit('teardown', ended(TAB_OF[agent], exit))
      await stoppedAndGone(a, agent)
      expect(a[agent].killed).toEqual([TAB_OF[agent]])
      expect(a[agent].sent).toEqual([])
    }
  )

  it('Antigravity: a tab whose terminal ended has its tmux session on the machine ended', async () => {
    const a = await aTabOfEveryAgent()
    const ranBefore = a.agy.ranOverSsh.length
    a.lifecycle.emit('teardown', ended(AGY_TAB))
    await stoppedAndGone(a, 'agy')
    expect(a.agy.ranOverSsh.slice(ranBefore).join('\n')).toContain('kill-session')
  })
})

describe('a Claude Code tab that was still starting when its terminal ended', () => {
  it('is no longer held as starting, so the rows are read again once, and the Codex tab and the Antigravity tab are untouched', async () => {
    const a = await aTabOfEveryAgent()
    a.claude.store.launchStarted(CLAUDE_TAB_STILL_STARTING, world.repo)
    const rereadForTheStart = a.claude.rowsReread()
    const codexBefore = storedTabNow(a, 'codex')
    const agyBefore = storedTabNow(a, 'agy')
    a.lifecycle.emit('teardown', ended(CLAUDE_TAB_STILL_STARTING))
    expect(a.claude.rowsReread()).toBe(rereadForTheStart + 1)
    a.lifecycle.emit('teardown', ended(CLAUDE_TAB_STILL_STARTING))
    expect(a.claude.rowsReread()).toBe(rereadForTheStart + 1)
    await pastAnyStopStartedByMistake()
    expect(storedTabNow(a, 'codex')).toEqual(codexBefore)
    expect(storedTabNow(a, 'agy')).toEqual(agyBefore)
  })
})

describe('a tab of one agent that ends is nothing to the other two', () => {
  it("Claude Code's tab crashes: the Codex tab and the Antigravity tab stay open, still count on their accounts, send no event, and their terminals are not let go", async () => {
    const a = await aTabOfEveryAgent()
    const codexBefore = storedTabNow(a, 'codex')
    const agyBefore = storedTabNow(a, 'agy')
    a.lifecycle.emit('teardown', crashed(CLAUDE_TAB))
    expect(a.claude.sent).toEqual([REPORTED_AS_EXITED_UNCLEANLY])
    await pastAnyStopStartedByMistake()
    expect(storedTabNow(a, 'codex')).toEqual(codexBefore)
    expect(storedTabNow(a, 'agy')).toEqual(agyBefore)
    expect(codexBefore).toMatchObject(OPEN_AND_LEFT_ALONE)
    expect(agyBefore).toMatchObject(OPEN_AND_LEFT_ALONE)
  })

  it.each(STORED)(
    "%s's tab crashes: Claude Code's row stays alive on its session and Claude Code sends no event, and the tab of the third agent is untouched",
    async (_name, agent, third) => {
      const a = await aTabOfEveryAgent()
      const thirdBefore = storedTabNow(a, third)
      a.lifecycle.emit('teardown', crashed(TAB_OF[agent]))
      await stoppedAndGone(a, agent)
      await pastAnyStopStartedByMistake()
      expect(claudeTabNow(a)).toEqual({
        alive: true,
        session: CLAUDE_SESSION,
        sent: [],
        rowsReread: 0
      })
      expect(storedTabNow(a, third)).toEqual(thirdBefore)
      expect(thirdBefore).toMatchObject(OPEN_AND_LEFT_ALONE)
    }
  )
})

describe('an agent told of the end of a tab that is not its own, as each will be once every agent is told of every tab', () => {
  it.each(STORED)(
    '%s stops nothing: its own tab stays open, still counts on its account, sends no event and keeps its terminal',
    async (_name, agent, third) => {
      const a = await aTabOfEveryAgent()
      const before = storedTabNow(a, agent)
      await a[agent].backend.tabExited(crashed(CLAUDE_TAB))
      await a[agent].backend.tabExited(ended(TAB_OF[third]))
      await pastAnyStopStartedByMistake()
      expect(storedTabNow(a, agent)).toEqual(before)
      expect(before).toMatchObject(OPEN_AND_LEFT_ALONE)
    }
  )

  it('Antigravity runs nothing on the machine for a tab that is not its own', async () => {
    const a = await aTabOfEveryAgent()
    const ranBefore = a.agy.ranOverSsh.length
    await a.agy.backend.tabExited(crashed(CLAUDE_TAB))
    await a.agy.backend.tabExited(ended(CODEX_TAB))
    await pastAnyStopStartedByMistake()
    expect(a.agy.ranOverSsh.slice(ranBefore)).toEqual([])
  })
})

describe('whether a tab that has no session yet already shows its prompt', () => {
  it('is no, for a tab of its own with no session yet too, from every agent whose manifest says its conversation does not start at the first prompt', async () => {
    const a = await aTabOfEveryAgent()
    const CLAUDE_TAB_WITH_NO_SESSION = 'pty-claude-with-no-session'
    a.claude.tracker.track(CLAUDE_TAB_WITH_NO_SESSION, world.repo)
    stops.push(() => a.claude.tracker.untrack(CLAUDE_TAB_WITH_NO_SESSION))
    const itsTabWithNoSession = {
      claude: CLAUDE_TAB_WITH_NO_SESSION,
      codex: CODEX_TAB,
      agy: AGY_TAB
    }
    for (const id of SESSION_BACKENDS) {
      const { backend } = a[id]
      expect(backend.hasTab(itsTabWithNoSession[id]), id).toBe(true)
      const itsSession = backend.list().find((s) => s.tabId === itsTabWithNoSession[id])?.sessionId
      expect(itsSession || 'none yet', id).toBe('none yet')
    }
    const neverShowItThatEarly = SESSION_BACKENDS.filter(
      (id) => !agentManifest(id).flags.conversationStartsAtFirstPrompt
    )
    expect(neverShowItThatEarly).not.toEqual([])
    for (const id of neverShowItThatEarly)
      expect(a[id].backend.showsPromptBeforeBind(itsTabWithNoSession[id]), id).toBe(false)
  })
})

describe('the tmux session a tab runs in on a machine, as each of the three real backends names it', () => {
  it('Claude Code names the one it tracks for its tab on a machine and none for its tab on this Mac, Antigravity names the one its tab runs in, Codex names none as its tab runs in no tmux session there; and none of them names one for a tab that is not its own', async () => {
    const a = await aTabOfEveryAgent()
    const CLAUDE_TAB_ON_THE_MACHINE = 'pty-claude-on-the-machine'
    a.claude.tracker.track(CLAUDE_TAB_ON_THE_MACHINE, ON_THE_MACHINE, {
      host: MACHINE,
      projectsRoot: path.join(world.home, 'mirror', MACHINE),
      tmuxName: 'k-a-claude-session'
    })
    stops.push(() => a.claude.tracker.untrack(CLAUDE_TAB_ON_THE_MACHINE))
    const tabs = [CLAUDE_TAB, CLAUDE_TAB_ON_THE_MACHINE, CODEX_TAB, AGY_TAB]
    const named = Object.fromEntries(
      SESSION_BACKENDS.map((id) => [id, tabs.map((tab) => a[id].backend.tmuxOfTab(tab))])
    )
    expect(named).toEqual({
      claude: [undefined, 'k-a-claude-session', undefined, undefined],
      codex: [undefined, undefined, undefined, undefined],
      agy: [undefined, undefined, undefined, expect.stringContaining(AGY_TAB)]
    })
  })

  it('Antigravity names its tab on a machine as the one running that tmux session there, or as the tab asked about when it runs there, and none on another machine or for a tmux session and tab not its own; that tab’s terminal names the same machine, so its tab id alone already finds it there', async () => {
    const a = await aTabOfEveryAgent()
    const tmux = a.agy.backend.tmuxOfTab(AGY_TAB)!
    expect([
      a.agy.sessions.tabOnMachine(MACHINE, tmux, 'pty-not-its-own'),
      a.agy.sessions.tabOnMachine(MACHINE, '', AGY_TAB),
      a.agy.sessions.tabOnMachine('otherbox', tmux, AGY_TAB),
      a.agy.sessions.tabOnMachine(MACHINE, 'k-not-its-own', 'pty-not-its-own')
    ]).toEqual([AGY_TAB, AGY_TAB, undefined, undefined])
    expect(a.agy.machineNamed).toEqual([MACHINE])
  })
})

describe('what the plugins find when they hear that a tab was torn down', () => {
  it.each(STORED)(
    '%s: its tab is already being stopped, so it no longer counts on its account, though its stop has not finished and the tab is still there',
    async (_name, agent) => {
      const a = await aTabOfEveryAgent()
      const heard: unknown[] = []
      a.whenTornDown.push(() => heard.push(storedTabNow(a, agent)))
      a.lifecycle.emit('teardown', ended(TAB_OF[agent]))
      expect(heard).toEqual([{ open: true, countsOnItsAccount: false, sent: [], killed: [] }])
      await stoppedAndGone(a, agent)
    }
  )

  it("Claude Code's crashed tab has already been reported as exited and its row is no longer alive", async () => {
    const a = await aTabOfEveryAgent()
    const heard: unknown[] = []
    a.whenTornDown.push(() => heard.push(claudeTabNow(a)))
    a.lifecycle.emit('teardown', crashed(CLAUDE_TAB))
    expect(heard).toEqual([
      {
        alive: false,
        session: CLAUDE_SESSION,
        sent: [REPORTED_AS_EXITED_UNCLEANLY],
        rowsReread: 0
      }
    ])
  })
})

const AS_KOLOFT_DOES_IT = 'the teardown wiring, as Koloft runs it'
const LETS_GO_LAST =
  'by hand: Claude Code lets go of a starting tab after the agent that has the tab was stopped'
const LETS_GO_FIRST =
  'by hand: Claude Code lets go of a starting tab before Codex and Antigravity are told'

type Order = typeof AS_KOLOFT_DOES_IT | typeof LETS_GO_LAST | typeof LETS_GO_FIRST

const storedRowsNow = (a: ThreeAgents, agent: StoredAgent): unknown =>
  a[agent].sessions
    .rows(ON_THE_MACHINE)
    .map((r) => ({ id: r.id, running: r.running, pending: !!r.pending }))

const everyTabNow = (a: ThreeAgents): unknown => ({
  claude: {
    tabs: a.claude.tracker
      .list()
      .map((s) => ({ tabId: s.tabId, alive: s.alive, session: s.sessionId })),
    rowsReread: a.claude.rowsReread()
  },
  codex: { tab: storedTabNow(a, 'codex'), rows: storedRowsNow(a, 'codex') },
  agy: { tab: storedTabNow(a, 'agy'), rows: storedRowsNow(a, 'agy') },
  sentByEveryAgentInOrder: [...a.sentInOrder]
})

async function startingRowsOfClaudeCode(a: ThreeAgents): Promise<string[]> {
  const pass = a.claude.store.rowsPass({
    everywhere: true,
    bindings: new Map(),
    keptByAnother: () => false
  })
  const there = await pass.in(
    { path: world.repo, realPath: world.repo, worktreeDirs: async () => [] },
    () => ({ bindings: new Map(), running: new Set(), hidden: () => false })
  )
  return there.starting.map((r) => r.id)
}

function endTheTab(a: ThreeAgents, order: Order, exit: TabEnded): void {
  if (order === AS_KOLOFT_DOES_IT) return void a.lifecycle.emit('teardown', exit)
  const { tabId } = exit
  const code = exit.signal ? -1 : exit.exitCode
  const failed = (error: unknown): void => void toasts.push(String(error))
  const stored = [a.codex.sessions, a.agy.sessions]
  a.claude.backend.onPtyExit(tabId, exit.crashed)
  a.claude.tracker.setAlive(tabId, false)
  if (order === LETS_GO_LAST) {
    void stored
      .find((sessions) => sessions.hasTab(tabId))
      ?.stop(tabId, code)
      .catch(failed)
    a.claude.store.launchEnded(tabId)
  } else {
    a.claude.store.launchEnded(tabId)
    for (const sessions of stored) void sessions.stop(tabId, code).catch(failed)
  }
  for (const heard of a.whenTornDown) heard(exit)
}

async function seenFromOutside(order: Order, exit: TabEnded): Promise<unknown> {
  const around = { world, stops }
  world = makeWorld()
  stops = []
  try {
    const a = await aTabOfEveryAgent()
    a.claude.store.launchStarted(CLAUDE_TAB, world.repo)
    const sshRanBefore = a.agy.ranOverSsh.length
    const seen: unknown[] = [{ at: 'before the tab ends', everyTab: everyTabNow(a) }]
    a.whenRowsReread.push(() =>
      seen.push({ at: 'Claude Code asks for its rows to be read again', everyTab: everyTabNow(a) })
    )
    a.whenTornDown.push(() =>
      seen.push({ at: 'the plugins hear the tab was torn down', everyTab: everyTabNow(a) })
    )
    endTheTab(a, order, exit)
    if (exit.tabId === CODEX_TAB) await stoppedAndGone(a, 'codex')
    if (exit.tabId === AGY_TAB) await stoppedAndGone(a, 'agy')
    await pastAnyStopStartedByMistake()
    seen.push({
      at: 'once everything settled',
      everyTab: everyTabNow(a),
      startingRowsOfClaudeCode: await startingRowsOfClaudeCode(a),
      ranOnTheMachineOfAntigravity: a.agy.ranOverSsh.slice(sshRanBefore)
    })
    return JSON.parse(sameOnEveryRun(JSON.stringify(seen), world))
  } finally {
    try {
      await theWorldEnds()
    } finally {
      world = around.world
      stops = around.stops
    }
  }
}

const momentsSeen = (seen: unknown): string[] => (seen as { at: string }[]).map((m) => m.at)

describe('whether Claude Code lets go of a starting tab before or after the other two agents are told that a tab ended', () => {
  it.each([
    ['Claude Code', 'died', crashed(CLAUDE_TAB), 1],
    ['Claude Code', 'ended without a failure', ended(CLAUDE_TAB), 1],
    ['Codex', 'died', crashed(CODEX_TAB), 0],
    ['Codex', 'ended without a failure', ended(CODEX_TAB), 0],
    ['Codex', 'was killed by a signal', ended(CODEX_TAB, { signal: 15 }), 0],
    ['Antigravity', 'died', crashed(AGY_TAB), 0],
    ['Antigravity', 'ended without a failure', ended(AGY_TAB), 0],
    ['Antigravity', 'was killed by a signal', ended(AGY_TAB, { signal: 15 }), 0]
  ] as const)(
    'cannot be seen from outside when a tab of %s %s, while a Claude Code tab is still starting: every agent’s tabs and rows, the events and their order, the rereads of Claude Code’s rows and what each of them and the plugins find are the same in both orders, and the same as Koloft’s own teardown',
    async (_agent, _how, exit, rereads) => {
      const lettingGoLast = await seenFromOutside(LETS_GO_LAST, exit)
      const lettingGoFirst = await seenFromOutside(LETS_GO_FIRST, exit)
      const asKoloftDoesIt = await seenFromOutside(AS_KOLOFT_DOES_IT, exit)

      expect(lettingGoFirst).toEqual(lettingGoLast)
      expect(asKoloftDoesIt).toEqual(lettingGoLast)
      expect(momentsSeen(lettingGoLast)).toEqual([
        'before the tab ends',
        ...Array<string>(rereads).fill('Claude Code asks for its rows to be read again'),
        'the plugins hear the tab was torn down',
        'once everything settled'
      ])
    }
  )
})
