import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-sessions-signal-'))
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

type CodexFrameIn = (direction: 'client' | 'server', frame: unknown) => void

const codexConnections = vi.hoisted(() => ({ frameIn: [] as CodexFrameIn[] }))

vi.mock('../../src/agents/codex/main/codexTransport', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/agents/codex/main/codexTransport')>()
  const { CodexRpcThatListsNoHooks } = await import('./helpers/codexRpcStub')
  return {
    ...real,
    createCodexTransport: async (options: {
      onFrame: CodexFrameIn
      upstream?: (frame: () => void, failure: () => void) => { stop(): Promise<void> }
    }) => {
      codexConnections.frameIn.push(options.onFrame)
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

import type { BackgroundItem, LayoutV6, WorkspaceRows } from '@shared/types'
import type { AgySessions } from '../../src/agents/agy/main/agySessions'
import {
  ClaudeSessionStore,
  liveSessionsOf,
  type LiveSession
} from '../../src/agents/claude/main/claudeSessionStore'
import { SessionTracker } from '../../src/agents/claude/main/sessionTracker'
import type { CodexSessions } from '../../src/agents/codex/main/codexSessions'
import { rowsKeptInMemory } from '../../src/agents/kit/main/rowsKeptInMemory'
import { agySessionKey, codexSessionKey } from '../../src/agents/kit/main/sessionStore'
import { rowsOfEveryAgent } from '../../src/core/agent/sessionRows'
import { SessionRuntime } from '../../src/core/agent/sessionRuntime'
import { BackgroundFile } from '../../src/main/backgroundFile'
import { wireRunState } from '../../src/plugins/sessions/main/runState'
import { sessionsChangedIn } from '../../src/plugins/sessions/main/sessionsChanged'
import { WorkspaceManager } from '../../src/plugins/sessions/main/workspaces'
import { agySessionsIn, codexSessionsIn, makeWorld, type World } from './helpers/agentTabs'

const CLAUDE_TAB = 'pty-claude'
const CLAUDE_SESSION = '3c4ac765-c402-4d6d-88ac-dca81e2a35f1'
const FIRST_SESSION = '11111111-1111-4111-8111-111111111111'
const SECOND_SESSION = '22222222-2222-4222-8222-222222222222'
const SAVED_SESSION = '33333333-3333-4333-8333-333333333333'

const A_THROTTLED_SIGNAL_AND_THE_RESCAN_IT_ASKS_FOR_ARE_OVER_AFTER_MS = 1000
const QUIET_IS_LOOKED_FOR_EVERY_MS = 50

const STILL_RUNNING: BackgroundItem[] = [
  { id: 'bg-1', kind: 'command', label: 'npm run dev', state: 'working' }
]

type Stored = 'codex' | 'agy'
type Agent = 'claude' | Stored
type StoredSessions = CodexSessions | AgySessions

const EVERY_AGENT = [
  ['Claude Code', 'claude'],
  ['Codex', 'codex'],
  ['Antigravity', 'agy']
] as const

const STORED = [
  ['Codex', 'codex', 'agy'],
  ['Antigravity', 'agy', 'codex']
] as const

const keyOf = { codex: codexSessionKey, agy: agySessionKey }

let world: World
let stops: (() => Promise<void> | void)[]

beforeEach(() => {
  world = makeWorld()
  stops = []
  codexConnections.frameIn.length = 0
})

afterEach(async () => {
  try {
    for (const stop of stops.reverse()) await stop()
    await BackgroundFile.whenAllWritten()
  } finally {
    world.gone()
  }
})

function terminals(prefix: string) {
  const envOf = new Map<string, NodeJS.ProcessEnv>()
  let made = 0
  const pty = Object.assign(new EventEmitter(), {
    nextId: () => `${prefix}-${++made}`,
    create: (args: {
      id?: string
      processEnv?: NodeJS.ProcessEnv
      envSetForThisTab?: Record<string, string>
    }) => {
      const id = args.id ?? `${prefix}-${++made}`
      envOf.set(id, { ...args.processEnv, ...args.envSetForThisTab })
      return { id, startedAt: Date.now() }
    },
    get: () => undefined,
    pidOf: () => process.pid,
    write: () => {},
    type: async () => true,
    wakeReady: () => {},
    kill: () => {},
    clearResumeIntent: () => {}
  })
  return { pty, envOf }
}

type Seen = Partial<Record<'books' | 'list' | 'manager' | 'answerable' | 'rows' | 'rescan', number>>

async function theSessionsOfTheApp() {
  const butlers = path.join(world.home, 'butler')
  const notPinned = path.join(world.home, 'not-pinned')
  for (const dir of [butlers, notPinned]) fs.mkdirSync(dir)
  const rootOf = (dir: string): string =>
    [butlers, notPinned].find((root) => dir === root || dir.startsWith(root + path.sep)) ??
    world.repo

  const seen: (keyof Seen)[] = []
  let lastSeenAt = Date.now()
  const said = (what: keyof Seen): void => {
    seen.push(what)
    lastSeenAt = Date.now()
  }
  const quiet = async (): Promise<void> => {
    lastSeenAt = Date.now()
    while (
      Date.now() - lastSeenAt <
      A_THROTTLED_SIGNAL_AND_THE_RESCAN_IT_ASKS_FOR_ARE_OVER_AFTER_MS
    )
      await new Promise((resolve) => setTimeout(resolve, QUIET_IS_LOOKED_FOR_EVERY_MS))
  }
  const during = async (act: () => Promise<unknown> | unknown): Promise<Seen> => {
    await quiet()
    seen.length = 0
    await act()
    await quiet()
    const counts: Seen = {}
    for (const what of seen) counts[what] = (counts[what] ?? 0) + 1
    return counts
  }

  const runtime = new SessionRuntime()
  const tracker = new SessionTracker(runtime)
  let manager: WorkspaceManager | undefined
  const stored: StoredSessions[] = []

  const sessionsChanged = sessionsChangedIn({
    noteSessions: () => {
      said('books')
      return []
    },
    sendSessions: () => said('list'),
    workspaces: () =>
      manager
        ? {
            sessionsChanged: () => {
              said('manager')
              manager!.sessionsChanged()
            }
          }
        : null,
    syncAnswerable: () => said('answerable')
  })
  wireRunState(runtime, { workStillRunning: async () => false })
  tracker.on('update', sessionsChanged)
  const wiredAsTheEntryFileWiresThem = {
    runtime,
    changed: sessionsChanged,
    pinnedWorkspaces: () => manager?.pinnedPathList() ?? [],
    rereadRows: () => manager?.refresh()
  }

  const codexTerminals = terminals('pty-codex')
  const codex = codexSessionsIn(world, codexTerminals.pty, {
    ranOnTheMachine: [],
    run: () => ({ code: 1, stdout: '', stderr: '' }),
    events: (tabId, event) => codex.observe(tabId, event),
    rootOf,
    ...wiredAsTheEntryFileWiresThem
  })
  const agyTerminals = terminals('pty-agy')
  const agy = agySessionsIn(world, agyTerminals.pty, {
    machine: { run: async () => ({ code: 1, stdout: Buffer.from(''), stderr: '' }) },
    rootOf,
    ...wiredAsTheEntryFileWiresThem
  })
  stored.push(codex, agy)
  stops.push(
    () => codex.stopAll(),
    () => agy.stopAll()
  )

  const bindCodex = (session: string, cwd: string): void => {
    const frameIn = codexConnections.frameIn[codexConnections.frameIn.length - 1]
    frameIn('client', { id: 1, method: 'thread/start', params: { threadId: session } })
    frameIn('server', {
      id: 1,
      result: {
        thread: { id: session, cwd, name: 'A session', createdAt: 1, status: { type: 'idle' } }
      }
    })
  }
  const bindAgy = (tabId: string, session: string): void => {
    const settings = JSON.parse(
      fs.readFileSync(
        path.join(world.home, 'agy-homes', 'work', 'antigravity-cli', 'settings.json'),
        'utf8'
      )
    )
    execFileSync('/bin/sh', ['-c', settings.title.command], {
      input: JSON.stringify({
        agent_state: 'idle',
        conversation_id: session,
        model: { id: 'gemini-3.1-pro-low' },
        context_window: { used_percentage: 12 }
      }),
      env: agyTerminals.envOf.get(tabId),
      encoding: 'utf8'
    })
    agyTerminals.pty.emit('data', {
      id: tabId,
      data: '\x1b]7501;state=idle:app=antigravity\x1b\\'
    })
  }
  const sessionsOf = { codex, agy } as const
  const aBoundTab = async (agent: Stored, session: string, cwd: string): Promise<string> => {
    const { id } = await sessionsOf[agent].launch({ kind: agent, cwd })
    if (agent === 'codex') bindCodex(session, cwd)
    else bindAgy(id, session)
    expect(sessionsOf[agent].sessionIdOf(id)).toBe(keyOf[agent](session))
    return id
  }
  const tabOf = {
    claude: CLAUDE_TAB,
    codex: await aBoundTab('codex', FIRST_SESSION, world.repo),
    agy: await aBoundTab('agy', FIRST_SESSION, world.repo)
  }
  for (const s of stored) await s.refreshHistory()

  tracker.track(CLAUDE_TAB, world.repo)
  tracker.bindSession(
    CLAUDE_TAB,
    path.join(world.home, 'transcripts', `${CLAUDE_SESSION}.jsonl`),
    CLAUDE_SESSION,
    world.repo
  )
  stops.push(() => tracker.untrack(CLAUDE_TAB))

  let layout: LayoutV6 = {
    version: 6,
    workspaces: [{ path: world.repo }],
    workbench: { defaultOpen: false },
    members: [],
    panels: {}
  }
  let claudeSessionMovedTo: string | undefined
  let rowsShown: WorkspaceRows[] = []
  const runningBindings = (): Map<string, string> => {
    const bound = new Map<string, string>()
    for (const s of tracker.list()) if (s.alive && s.sessionId) bound.set(s.sessionId, s.tabId)
    for (const s of stored) for (const [key, tabId] of s.runningBindings()) bound.set(key, tabId)
    return bound
  }
  const claudeStore: ClaudeSessionStore = new ClaudeSessionStore({
    projectsRoot: path.join(world.home, '.claude', 'projects'),
    remoteProjectsRoot: (host) => path.join(world.home, 'mirror', host),
    pinnedPaths: () => manager!.pinnedPathList(),
    remoteTargets: () => manager!.remoteTargets(),
    kept: { list: () => [], add: () => {}, remove: () => {}, keepOnly: () => {} },
    rereadRows: () => manager!.refresh(),
    rereadGrownRows: () => manager!.rescanForGrowth(),
    runningBindings,
    liveSessions: (): Map<string, LiveSession> =>
      claudeSessionMovedTo
        ? new Map([[CLAUDE_SESSION, { treeRoot: claudeSessionMovedTo }]])
        : liveSessionsOf(tracker)
  })
  manager = new WorkspaceManager({
    agents: rowsOfEveryAgent(() => [
      { id: 'claude', rows: claudeStore },
      { id: 'codex', rows: rowsKeptInMemory(codex) },
      { id: 'agy', rows: rowsKeptInMemory(agy) }
    ]),
    loadLayout: () => layout,
    saveLayout: (next) => {
      layout = next
    },
    projectInfo: (dir) => ({ root: rootOf(dir), treeRoot: dir }),
    runningBindings,
    killTab: () => {},
    pushRows: (rows) => {
      rowsShown = rows
      said('rows')
    },
    onRescanned: () => said('rescan'),
    claimedFolder: { path: butlers, by: 'butler', shownAs: 'Butler' }
  })
  claudeStore.start()
  manager.start()
  const started = manager
  stops.push(
    () => started.dispose(),
    () => claudeStore.dispose()
  )
  await manager.firstScan
  for (const agent of ['codex', 'agy'] as const)
    sessionsOf[agent].observe(tabOf[agent], { type: 'did', what: 'Its first change' })
  await quiet()

  const rowOf = (workspace: string, id: string) =>
    rowsShown.find((e) => e.workspace.path === workspace)?.rows.find((row) => row.id === id)

  return {
    runtime,
    tracker,
    manager: started,
    codex,
    agy,
    sessionsOf,
    tabOf,
    butlers,
    notPinned,
    during,
    quiet,
    stepsInOrder: (): (keyof Seen)[] => [...seen],
    aRescanAskedForByAnythingElse: () => during(() => started.refresh()),
    rowOf,
    aBoundTab,
    statusOf: (agent: Agent): string | undefined => runtime.statusOf(tabOf[agent]),
    startsATurn: (agent: Agent): void => {
      if (agent === 'claude') tracker.setStatus(CLAUDE_TAB, 'working')
      else sessionsOf[agent].observe(tabOf[agent], { type: 'prompt' })
    },
    hasBackgroundWorkRunning: (agent: Agent): void => {
      if (agent === 'claude') runtime.setBackground(CLAUDE_TAB, STILL_RUNNING)
      else
        sessionsOf[agent].observe(tabOf[agent], {
          type: 'background-changed',
          items: STILL_RUNNING
        })
    },
    endsItsTurn: (agent: Agent): void => {
      if (agent === 'claude') tracker.setStatus(CLAUDE_TAB, 'waiting')
      else sessionsOf[agent].observe(tabOf[agent], { type: 'stop' })
    },
    changesWithNoTurnEdge: (agent: Stored): void =>
      sessionsOf[agent].observe(tabOf[agent], { type: 'did', what: `Reading ${Date.now()}` }),
    claudeSessionMoves: (to: string): void => {
      claudeSessionMovedTo = to
    }
  }
}

const SENT_ONCE_THROUGH_ALL_FOUR_STEPS: Seen = { books: 1, list: 1, manager: 1, answerable: 1 }

describe('a tab ends its turn while its background work still runs, so its status stays working', () => {
  it.each(EVERY_AGENT)(
    '%s: the session list is sent again within the throttle, and once',
    async (_name, agent) => {
      const app = await theSessionsOfTheApp()
      app.startsATurn(agent)
      app.hasBackgroundWorkRunning(agent)
      const seen = await app.during(() => app.endsItsTurn(agent))
      expect(app.statusOf(agent)).toBe('working')
      expect(app.runtime.turnOver(app.tabOf[agent])).toBe(true)
      expect(seen).toEqual(SENT_ONCE_THROUGH_ALL_FOUR_STEPS)
    }
  )
})

describe("every agent's signal goes through the same function", () => {
  it.each(EVERY_AGENT)(
    '%s: a turn that starts runs the four steps once, in this order: the books, the send of the session list, the workspace manager, the answerable sync',
    async (_name, agent) => {
      const app = await theSessionsOfTheApp()
      await app.during(() => app.startsATurn(agent))
      expect(app.statusOf(agent)).toBe('working')
      expect(app.stepsInOrder()).toEqual(['books', 'list', 'manager', 'answerable'])
    }
  )

  it.each(EVERY_AGENT)(
    '%s: a turn that ends, with its status changing to waiting, sends the session list once',
    async (_name, agent) => {
      const app = await theSessionsOfTheApp()
      app.startsATurn(agent)
      const seen = await app.during(() => app.endsItsTurn(agent))
      expect(app.statusOf(agent)).toBe('waiting')
      expect(seen).toEqual(SENT_ONCE_THROUGH_ALL_FOUR_STEPS)
    }
  )
})

describe('a change of a Codex or Antigravity session that is no edge of a turn', () => {
  it.each(STORED)(
    '%s: the four steps run once, and with its rows as they were nothing rescans',
    async (_name, agent) => {
      const app = await theSessionsOfTheApp()
      const seen = await app.during(() => app.changesWithNoTurnEdge(agent))
      expect(seen).toEqual(SENT_ONCE_THROUGH_ALL_FOUR_STEPS)
    }
  )

  it.each(STORED)(
    '%s: a tab of the other agent that is still starting in a pinned workspace makes it rescan nothing',
    async (_name, agent, other) => {
      const app = await theSessionsOfTheApp()
      await app.sessionsOf[other].launch({ kind: other, cwd: world.repo })
      const seen = await app.during(() => app.changesWithNoTurnEdge(agent))
      expect(seen).toEqual(SENT_ONCE_THROUGH_ALL_FOUR_STEPS)
    }
  )

  it.each(STORED)(
    '%s: after the folder of a session of the other agent was deleted, it rescans nothing; that row shows its folder as gone with the next rescan',
    async (_name, agent, other) => {
      const app = await theSessionsOfTheApp()
      const folder = path.join(world.repo, 'sub')
      fs.mkdirSync(folder)
      const key = keyOf[other](SAVED_SESSION)
      app.sessionsOf[other].store.upsertMember({
        id: SAVED_SESSION,
        key,
        workspacePath: world.repo,
        cwd: folder,
        title: 'Saved',
        createdAt: 1,
        updatedAt: Date.now()
      })
      await app.aRescanAskedForByAnythingElse()
      expect(app.rowOf(world.repo, key)?.invalidCwd).toBe(false)
      fs.rmSync(folder, { recursive: true })
      const seen = await app.during(() => app.changesWithNoTurnEdge(agent))
      expect(seen).toEqual(SENT_ONCE_THROUGH_ALL_FOUR_STEPS)
      expect(app.rowOf(world.repo, key)?.invalidCwd).toBe(false)
      await app.aRescanAskedForByAnythingElse()
      expect(app.rowOf(world.repo, key)?.invalidCwd).toBe(true)
    }
  )

  it.each(STORED)(
    '%s: after a Claude Code session moved to another folder, it stamps the rows again once, with no rescan',
    async (_name, agent) => {
      const app = await theSessionsOfTheApp()
      app.claudeSessionMoves(path.join(world.repo, 'moved'))
      const seen = await app.during(() => app.changesWithNoTurnEdge(agent))
      expect(seen).toEqual({ ...SENT_ONCE_THROUGH_ALL_FOUR_STEPS, rows: 1 })
    }
  )
})

describe('a title that changes', () => {
  it.each(STORED)(
    '%s: in a pinned workspace it rescans, and the row shows the new title',
    async (_name, agent) => {
      const app = await theSessionsOfTheApp()
      const seen = await app.during(() =>
        app.sessionsOf[agent].observe(app.tabOf[agent], { type: 'title', title: 'Renamed' })
      )
      expect(seen.rescan).toBe(1)
      expect(app.rowOf(world.repo, keyOf[agent](FIRST_SESSION))?.title).toBe('Renamed')
    }
  )

  it.each(STORED)(
    "%s: in the butler's folder, which is listed but not pinned, it rescans nothing; the row shows the new title with the next rescan",
    async (_name, agent) => {
      const app = await theSessionsOfTheApp()
      const tab = await app.aBoundTab(agent, SECOND_SESSION, app.butlers)
      const key = keyOf[agent](SECOND_SESSION)
      await app.quiet()
      expect(app.rowOf(app.butlers, key)?.running).toBe(true)
      const seen = await app.during(() =>
        app.sessionsOf[agent].observe(tab, { type: 'title', title: 'Renamed' })
      )
      expect(seen.rescan).toBeUndefined()
      expect(app.rowOf(app.butlers, key)?.title).not.toBe('Renamed')
      await app.aRescanAskedForByAnythingElse()
      expect(app.rowOf(app.butlers, key)?.title).toBe('Renamed')
    }
  )
})

describe('a session kept in the sidebar whose tab is closed and opened again', () => {
  it.each(STORED)(
    "%s: in the butler's folder each rescans once, so its row stops saying it runs after the close and says so again after the reopening",
    async (_name, agent) => {
      const app = await theSessionsOfTheApp()
      const tab = await app.aBoundTab(agent, SECOND_SESSION, app.butlers)
      const key = keyOf[agent](SECOND_SESSION)
      await app.quiet()
      expect(app.rowOf(app.butlers, key)?.running).toBe(true)

      const closing = await app.during(() => app.sessionsOf[agent].stop(tab))
      expect(closing.rescan).toBe(1)
      expect(app.rowOf(app.butlers, key)?.running).toBe(false)

      const reopening = await app.during(() =>
        app.sessionsOf[agent].resume({ sessionId: key, cwd: app.butlers })
      )
      expect(reopening.rescan).toBe(1)
      expect(app.rowOf(app.butlers, key)?.running).toBe(true)
    }
  )

  it.each(STORED)('%s: in a folder that is not pinned each rescans once', async (_name, agent) => {
    const app = await theSessionsOfTheApp()
    const tab = await app.aBoundTab(agent, SECOND_SESSION, app.notPinned)
    const key = keyOf[agent](SECOND_SESSION)
    const closing = await app.during(() => app.sessionsOf[agent].stop(tab))
    expect(closing.rescan).toBe(1)
    const reopening = await app.during(() =>
      app.sessionsOf[agent].resume({ sessionId: key, cwd: app.notPinned })
    )
    expect(reopening.rescan).toBe(1)
  })
})
