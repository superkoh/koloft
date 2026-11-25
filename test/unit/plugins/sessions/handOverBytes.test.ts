import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

const terminal = vi.hoisted(() => {
  const spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  return {
    spawned,
    spawn: (file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      spawned.push({ file, args, env: opts.env })
      return {
        pid: process.pid,
        onData() {},
        onExit() {},
        write() {},
        resize() {},
        kill() {},
        process: 'zsh'
      }
    }
  }
})
vi.mock('node-pty', () => ({ spawn: terminal.spawn }))

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-hand-over-bytes-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

afterAll(() => fs.rmSync(app.getPath('userData'), { recursive: true, force: true }))

vi.mock('../../../../src/main/cliRuntime', () => ({
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

const appServer = vi.hoisted(() => ({ started: [] as unknown[] }))
vi.mock('../../../../src/agents/codex/main/codexTransport', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../../src/agents/codex/main/codexTransport')>()
  const { CodexRpcThatListsNoHooks } = await import('../../helpers/codexRpcStub')
  return {
    ...real,
    createCodexTransport: async (options: unknown) => {
      appServer.started.push(options)
      return { url: 'unix:///test/rpc.sock', stop: async () => {}, request: async () => ({}) }
    },
    CodexRpc: CodexRpcThatListsNoHooks
  }
})

import { PtyManager } from '../../../../src/main/ptyManager'
import { mirrorHookDir } from '../../../../src/main/remote/paths'
import { sessionVerb, type Target } from '../../../../src/plugins/sessions/main/sessionVerbs'
import { StartedSessions } from '../../../../src/plugins/sessions/main/startedSessions'
import {
  opensAsOnlyKoloftSends,
  quotedPrompt,
  saidFile
} from '../../../../src/plugins/sessions/main/hooks'
import { codexBackend } from '../../../../src/agents/codex/main/backend'
import { agyBackend } from '../../../../src/agents/agy/main/backend'
import type { ResumeProbes } from '../../../../src/main/resumePlan'
import { butlersWords } from '../../../../src/plugins/butler/main/sessionHooks'
import { withoutTheRelayTag } from '../../../../src/plugins/discord/main/sessionHooks'
import type { Turn } from '../../../../src/shared/turns'
import type { BackendId, SessionInfo } from '../../../../src/shared/types'
import type { SessionBackend } from '../../../../src/core/agent/sessionBackends'
import {
  agySessionsIn,
  claudeBackendIn,
  codexSessionsIn,
  makeWorld,
  MACHINE,
  ON_THE_MACHINE,
  recordingSsh,
  sameOnEveryRun,
  type World
} from '../../helpers/agentTabs'

const PINNED = './hand-over-bytes'
const NEW_TAB = 'pty-new'
const TASK = 'Fix the sidebar.'
const HANDOVER_STARTS = 'Koloft started you because'
const OWNERS_WORDS = '先把侧栏修好'
const STARTERS_WORDS = '帮我跑一下测试'
const CALLERS_OWN_WORDS = '再改一下'
const LONG_WORDS = '长'.repeat(200)
const MARKS = [
  TASK,
  HANDOVER_STARTS,
  OWNERS_WORDS,
  STARTERS_WORDS,
  CALLERS_OWN_WORDS,
  '长长长',
  'task-first'
]
const PICKED = ['--model', 'any', '--effort', 'low']
const NO_RESUME_IS_PLANNED_HERE = {} as ResumeProbes

const CALLER_TAB = 'pty-caller'
const CALLER_SESSION = 'aaaaaaaa-0000-4000-8000-000000000001'
const STARTER_TAB = 'pty-starter'
const STARTER_SESSION = 'aaaaaaaa-0000-4000-8000-000000000002'
const GRANDSTARTER_TAB = 'pty-grandstarter'
const GRANDSTARTER_SESSION = 'aaaaaaaa-0000-4000-8000-000000000003'
const BUTLER_TAB = 'pty-butler'
const BUTLER_SESSION = 'aaaaaaaa-0000-4000-8000-000000000004'
const CLOSED_SESSION = 'aaaaaaaa-0000-4000-8000-000000000005'
const WHO: Record<string, string> = {
  [CALLER_SESSION]: 'the caller',
  [STARTER_SESSION]: 'its starter',
  [GRANDSTARTER_SESSION]: "its starter's starter",
  [BUTLER_SESSION]: 'the butler'
}
const CALLED: Record<BackendId, string> = {
  claude: 'a Claude Code',
  codex: 'a Codex',
  agy: 'an Antigravity'
}

type Kind = { backend: BackendId; remote: boolean }

const KINDS: (Kind & { file: string; says: string })[] = [
  { backend: 'claude', remote: false, file: 'claude-on-this-mac', says: 'Claude Code on this Mac' },
  { backend: 'claude', remote: true, file: 'claude-over-ssh', says: 'Claude Code over SSH' },
  { backend: 'codex', remote: false, file: 'codex-on-this-mac', says: 'Codex on this Mac' },
  { backend: 'codex', remote: true, file: 'codex-over-ssh', says: 'Codex over SSH' },
  { backend: 'agy', remote: false, file: 'agy-on-this-mac', says: 'Antigravity on this Mac' },
  { backend: 'agy', remote: true, file: 'agy-over-ssh', says: 'Antigravity over SSH' }
]

let world: World
let stops: (() => Promise<void>)[]

beforeEach(() => {
  world = makeWorld()
  stops = []
  terminal.spawned.length = 0
  appServer.started.length = 0
})

afterEach(async () => {
  for (const stop of stops) await stop()
  await world.gone()
})

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

interface Caller {
  tabId?: string
  sessionId: string
  backendId: BackendId
  remote?: boolean
  open?: boolean
  startedBy?: string
  said?: string | null
  turns?: Turn[]
}

interface Scene {
  callers: Caller[]
  butler?: Caller
  from: string
}

const ownerSaid = (text: string, at = 1): Turn => ({
  said: [{ who: 'owner', text, at }],
  reply: 'ok',
  at
})

function infoOf(c: Caller): SessionInfo {
  return {
    tabId: c.tabId,
    backendId: c.backendId,
    host: c.remote ? 'ssh' : 'local',
    sessionId: c.sessionId,
    nativeSessionId: c.sessionId,
    title: c.sessionId.slice(-4),
    cwd: c.remote ? ON_THE_MACHINE : world.repo,
    treeRoot: c.remote ? ON_THE_MACHINE : world.repo,
    alive: true,
    status: 'waiting',
    updatedAt: 1,
    ...(c.remote && { remote: { host: MACHINE, path: '/home/me/proj' } })
  } as SessionInfo
}

function keep(c: Caller): void {
  if (!c.tabId || c.said === undefined) return
  const dir = c.remote ? mirrorHookDir(world.userData, MACHINE) : world.regDir
  fs.mkdirSync(dir, { recursive: true })
  if (c.said !== null) fs.writeFileSync(saidFile(dir, c.tabId), c.said)
}

interface Bench {
  run(args: string[]): Promise<string>
  got(): string
}

async function bench(scene: Scene): Promise<Bench> {
  const ptyMgr = koloftsTerminals()
  const onTheMachine = recordingSsh()
  const codexRan: string[] = []
  const claude = claudeBackendIn(world, ptyMgr, { machine: { run: onTheMachine.run } })
  const codex = codexSessionsIn(world, ptyMgr, {
    ranOnTheMachine: codexRan,
    run: () => ({ code: 0, stdout: '', stderr: '' })
  })
  stops.push(() => codex.stopAll())
  const agy = agySessionsIn(world, ptyMgr, {
    machine: { run: onTheMachine.run },
    apiKey: 'api-key-of-the-koloft-account'
  })
  stops.push(() => agy.stopAll())
  const agents: Record<BackendId, Pick<SessionBackend, 'create' | 'handOverLaunch'>> = {
    claude,
    codex: codexBackend(
      codex,
      NO_RESUME_IS_PLANNED_HERE,
      () => NO_RESUME_IS_PLANNED_HERE,
      async () => {},
      async () => undefined
    ),
    agy: agyBackend(agy, NO_RESUME_IS_PLANNED_HERE, () => NO_RESUME_IS_PLANNED_HERE)
  }

  const everyone = [...scene.callers, ...(scene.butler ? [scene.butler] : [])]
  for (const c of everyone) keep(c)
  const open = scene.callers.filter((c) => c.open !== false).map(infoOf)
  const started = new StartedSessions(() => path.join(world.home, 'started-sessions.json'))
  for (const c of scene.callers)
    if (c.startedBy) {
      const tab = c.tabId ?? `tab-of-${c.sessionId}`
      started.started(tab, c.startedBy)
      started.bound(tab, c.sessionId)
    }
  const butlerTarget: Target | undefined = scene.butler && {
    key: scene.butler.sessionId,
    name: 'Alfred',
    backend: scene.butler.backendId,
    remote: false,
    tabId: scene.butler.tabId,
    overseer: true,
    open: async () => scene.butler!.tabId ?? BUTLER_TAB
  }
  const remoteTabs = new Set(everyone.filter((c) => c.remote && c.tabId).map((c) => c.tabId!))
  const turnsOf = new Map(everyone.map((c) => [c.sessionId, c.turns ?? []]))
  const read: string[] = []

  const verbs = sessionVerb({
    workspaceOf: (tab) => open.find((s) => s.tabId === tab)?.cwd,
    allSessions: () => open,
    tabOpen: (tab) => open.some((s) => s.tabId === tab),
    pinnedWorkspaces: () => [
      { path: world.repo, missing: false },
      { path: ON_THE_MACHINE, missing: false }
    ],
    peerNames: () => async () => null,
    turnedOff: () => null,
    projectRules: async () => undefined,
    pickFacts: async () => ({
      fableLeft: true,
      listed: [{ id: 'any', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }]
    }),
    launch: async (options) => {
      const made = await agents[options.kind].create({ ...options, tabId: NEW_TAB })
      return made.ok ? made.id : null
    },
    handOverLaunch: (backend, handOver, task) => agents[backend].handOverLaunch(handOver, task),
    assist: async () => null,
    startedSessions: started,
    closable: () => [],
    whatIsLeft: async () => [],
    closeSoon: () => {},
    overseer: {
      is: (tab) => tab === BUTLER_TAB,
      target: (ref) => (ref === butlerTarget?.key ? butlerTarget : undefined),
      folder: () => path.join(world.home, 'butler'),
      ...butlersWords
    },
    speaksForTheOwner: () => false,
    sidebar: () => [
      {
        workspace: { path: world.repo, missing: false, isGit: false, hasHistory: true },
        rows: []
      },
      {
        workspace: { path: ON_THE_MACHINE, missing: false, isGit: false, hasHistory: true },
        rows: []
      }
    ],
    worktrees: async () => [],
    readTurns: async (key, n) => {
      read.push(WHO[key] ?? key)
      return (turnsOf.get(key) ?? []).slice(-n)
    },
    transcriptPlaces: () => undefined,
    quotedPrompt: (tabId) => {
      const dir = remoteTabs.has(tabId) ? mirrorHookDir(world.userData, MACHINE) : world.regDir
      return quotedPrompt(dir, tabId)
    },
    resume: async () => {
      throw new Error('no resume in this bench')
    },
    ready: async () => true,
    bound: async () => true,
    asking: () => false,
    send: async () => {
      throw new Error('no message is sent in this bench')
    },
    mightNotTakeAMessageNow: async () => false,
    press: async () => {},
    modeOf: () => 'prompting',
    opensAsOnlyKoloftSends,
    stop: () => {},
    answer: async () => undefined,
    undelivered: () => {},
    command: async () => '',
    screen: async () => ({ error: 'no screen' }),
    rowNote: () => undefined,
    announceStarting: async () => [],
    announceStarted: async () => [],
    ownersWords: withoutTheRelayTag
  })

  const caller = open.find((s) => s.tabId === scene.from)!
  let reply = ''
  let before = new Map<string, string>()
  return {
    run: async (args) => {
      before = filesIn(world.home)
      const r = await verbs.verb(args, { tabId: scene.from, cwd: caller.cwd, session: caller })
      reply = `exit ${r.exit}: ${r.text}`
      return reply
    },
    got: () =>
      sameOnEveryRun(
        [
          `The caller is told: ${reply}`,
          `Turns read: ${read.length ? read.join(', ') : '(none)'}`,
          ...carrying(terminal.spawned, 'the terminal'),
          ...carrying(appServer.started, "Codex's app-server"),
          ...carrying(onTheMachine.ran, 'run on the machine'),
          ...carrying(codexRan, 'run on the machine for Codex'),
          ...filesWritten(before, filesIn(world.home))
        ].join('\n'),
        world
      )
  }
}

const carries = (text: string): boolean => MARKS.some((m) => text.includes(m))

function carrying(value: unknown, where: string): string[] {
  if (typeof value === 'string') {
    if (!carries(value)) return []
    const lines = value.split('\n')
    return lines.length === 1
      ? [`${where}: ${JSON.stringify(value)}`]
      : lines.flatMap((l, i) =>
          carries(l) ? [`${where}, line ${i + 1}: ${JSON.stringify(l)}`] : []
        )
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => carrying(v, `${where} [${i}]`))
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => carrying(v, `${where} ${k}`))
  return []
}

const SAID = /said|task-first/

function filesIn(dir: string): Map<string, string> {
  return new Map(
    fs
      .readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .sort()
      .filter((rel) => fs.lstatSync(path.join(dir, rel)).isFile())
      .map((rel) => [rel, fs.readFileSync(path.join(dir, rel), 'utf8')])
  )
}

function filesWritten(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after]
    .filter(([rel, text]) => before.get(rel) !== text)
    .flatMap(([rel, text]) =>
      SAID.test(path.basename(rel))
        ? [`file ${rel}: ${JSON.stringify(text)}`]
        : carrying(text, `file ${rel}`)
    )
}

const newSession = (backend: BackendId, remote: boolean): string[] => [
  'new',
  ...(backend === 'agy' && remote ? [] : ['--name', 'Helper']),
  '--backend',
  backend,
  ...(remote ? ['--workspace', ON_THE_MACHINE] : []),
  ...PICKED,
  '--',
  TASK
]

const CLAUDE_CALLER_WITH_WORDS: Caller = {
  tabId: CALLER_TAB,
  sessionId: CALLER_SESSION,
  backendId: 'claude',
  said: OWNERS_WORDS
}
const CLAUDE_CALLER_WITH_NONE: Caller = { ...CLAUDE_CALLER_WITH_WORDS, said: null }

describe('what a session started by koloft session new ends with in its agent’s hands, for each of the six kinds of tab: the hand-over and the task as its role or its first message, and the owner’s last words — pinned so that moving the choice into each agent changes no byte', () => {
  for (const kind of KINDS)
    it(kind.says, async () => {
      const sections: string[] = []
      for (const [says, caller] of [
        ["a Claude Code caller whose hook kept the owner's words", CLAUDE_CALLER_WITH_WORDS],
        ['a Claude Code caller whose hook kept none', CLAUDE_CALLER_WITH_NONE]
      ] as const) {
        terminal.spawned.length = 0
        appServer.started.length = 0
        const b = await bench({ callers: [caller], from: CALLER_TAB })
        await b.run(newSession(kind.backend, kind.remote))
        sections.push(`### ${says}\n${b.got()}`)
        for (const stop of stops.splice(0)) await stop()
        await world.gone()
        world = makeWorld()
      }
      await expect(sections.join('\n\n') + '\n').toMatchFileSnapshot(`${PINNED}/${kind.file}.txt`)
    })
})

const OWNER_WORDS_CELLS: [string, Scene][] = [
  [
    "a Claude Code caller: its hook's file holds the owner's words",
    { callers: [CLAUDE_CALLER_WITH_WORDS], from: CALLER_TAB }
  ],
  [
    "a Claude Code caller with no file, though its starter's file and its own turns hold words: Koloft looks nowhere else",
    {
      callers: [
        {
          ...CLAUDE_CALLER_WITH_NONE,
          startedBy: STARTER_SESSION,
          turns: [ownerSaid(CALLERS_OWN_WORDS)]
        },
        {
          tabId: STARTER_TAB,
          sessionId: STARTER_SESSION,
          backendId: 'claude',
          said: STARTERS_WORDS
        }
      ],
      from: CALLER_TAB
    }
  ],
  [
    'a Claude Code caller whose file is empty',
    {
      callers: [{ ...CLAUDE_CALLER_WITH_WORDS, said: '', turns: [ownerSaid(CALLERS_OWN_WORDS)] }],
      from: CALLER_TAB
    }
  ],
  [
    'a Claude Code caller whose file holds a broken escape',
    {
      callers: [
        { ...CLAUDE_CALLER_WITH_WORDS, said: '\\q broken', turns: [ownerSaid(CALLERS_OWN_WORDS)] }
      ],
      from: CALLER_TAB
    }
  ],
  [
    'a Claude Code caller whose file holds 200 characters',
    { callers: [{ ...CLAUDE_CALLER_WITH_WORDS, said: LONG_WORDS }], from: CALLER_TAB }
  ],
  [
    "a Claude Code caller over SSH: its file is read from the machine's mirror folder",
    {
      callers: [{ ...CLAUDE_CALLER_WITH_WORDS, remote: true }],
      from: CALLER_TAB
    }
  ]
]

const codexOrAgyCells = (backend: BackendId): [string, Scene][] => {
  const me: Caller = {
    tabId: CALLER_TAB,
    sessionId: CALLER_SESSION,
    backendId: backend,
    turns: [
      ownerSaid(STARTERS_WORDS, 1),
      {
        said: [
          { who: 'owner', text: CALLERS_OWN_WORDS, at: 2 },
          { who: 'owner', text: '(From the session "kid", id k:) All green.', at: 2 }
        ],
        reply: 'ok',
        at: 2
      }
    ]
  }
  return [
    [
      `${CALLED[backend]} caller no session started: its own last turns`,
      { callers: [me], from: CALLER_TAB }
    ],
    [
      `${CALLED[backend]} caller no session started, whose owner wrote 200 characters`,
      { callers: [{ ...me, turns: [ownerSaid(LONG_WORDS)] }], from: CALLER_TAB }
    ],
    [
      `${CALLED[backend]} caller started by an open Claude Code session whose file holds words: those words, its own turns not read`,
      {
        callers: [
          { ...me, startedBy: STARTER_SESSION },
          {
            tabId: STARTER_TAB,
            sessionId: STARTER_SESSION,
            backendId: 'claude',
            said: OWNERS_WORDS
          }
        ],
        from: CALLER_TAB
      }
    ],
    [
      `${CALLED[backend]} caller started by an open Claude Code session whose file is empty: no words, and no turns read`,
      {
        callers: [
          { ...me, startedBy: STARTER_SESSION },
          { tabId: STARTER_TAB, sessionId: STARTER_SESSION, backendId: 'claude', said: '' }
        ],
        from: CALLER_TAB
      }
    ],
    [
      `${CALLED[backend]} caller whose starter is closed: its own last turns`,
      { callers: [{ ...me, startedBy: CLOSED_SESSION }], from: CALLER_TAB }
    ],
    [
      `${CALLED[backend]} caller started by a Codex session started by an Antigravity one: the last one's turns`,
      {
        callers: [
          { ...me, startedBy: STARTER_SESSION },
          {
            tabId: STARTER_TAB,
            sessionId: STARTER_SESSION,
            backendId: 'codex',
            startedBy: GRANDSTARTER_SESSION,
            turns: [ownerSaid(CALLERS_OWN_WORDS)]
          },
          {
            tabId: GRANDSTARTER_TAB,
            sessionId: GRANDSTARTER_SESSION,
            backendId: 'agy',
            turns: [ownerSaid(OWNERS_WORDS)]
          }
        ],
        from: CALLER_TAB
      }
    ],
    [
      `${CALLED[backend]} caller and its starter that started each other: Koloft stops at the first one seen again`,
      {
        callers: [
          { ...me, startedBy: STARTER_SESSION },
          {
            tabId: STARTER_TAB,
            sessionId: STARTER_SESSION,
            backendId: 'codex',
            startedBy: CALLER_SESSION,
            turns: [ownerSaid(OWNERS_WORDS)]
          }
        ],
        from: CALLER_TAB
      }
    ],
    [
      `${CALLED[backend]} caller started by the butler, a Claude Code session whose file holds words`,
      {
        callers: [{ ...me, startedBy: BUTLER_SESSION }],
        butler: {
          tabId: BUTLER_TAB,
          sessionId: BUTLER_SESSION,
          backendId: 'claude',
          said: OWNERS_WORDS
        },
        from: CALLER_TAB
      }
    ],
    [
      `${CALLED[backend]} caller started by the butler, a Claude Code session with no tab now: no words, and no turns read`,
      {
        callers: [{ ...me, startedBy: BUTLER_SESSION }],
        butler: {
          sessionId: BUTLER_SESSION,
          backendId: 'claude',
          turns: [ownerSaid(OWNERS_WORDS)]
        },
        from: CALLER_TAB
      }
    ],
    [
      `${CALLED[backend]} caller started by the butler on Codex: the butler's turns`,
      {
        callers: [{ ...me, startedBy: BUTLER_SESSION }],
        butler: {
          tabId: BUTLER_TAB,
          sessionId: BUTLER_SESSION,
          backendId: 'codex',
          turns: [ownerSaid(OWNERS_WORDS)]
        },
        from: CALLER_TAB
      }
    ]
  ]
}

describe("where a hand-over takes the owner's last words from, by the kind of the session that runs koloft session new, as they reach a Claude Code session on this Mac (the hand-over's quote and its hook's file) — pinned as today", () => {
  for (const [file, cells] of [
    ['owners-words-from-a-claude-caller', OWNER_WORDS_CELLS],
    ['owners-words-from-a-codex-caller', codexOrAgyCells('codex')],
    ['owners-words-from-an-agy-caller', codexOrAgyCells('agy')]
  ] as const)
    it(file, async () => {
      const sections: string[] = []
      for (const [says, scene] of cells) {
        terminal.spawned.length = 0
        appServer.started.length = 0
        const b = await bench(scene)
        await b.run(newSession('claude', false))
        sections.push(`### ${says}\n${b.got()}`)
        for (const stop of stops.splice(0)) await stop()
        await world.gone()
        world = makeWorld()
      }
      await expect(sections.join('\n\n') + '\n').toMatchFileSnapshot(`${PINNED}/${file}.txt`)
    })
})
