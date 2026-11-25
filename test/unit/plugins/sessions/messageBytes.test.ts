import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import net from 'net'
import path from 'path'
import { app } from 'electron'

const terminal = vi.hoisted(() => {
  interface Proc {
    pid: number
    written: string[]
    said?: (data: string) => void
    onData(cb: (data: string) => void): void
    onExit(): void
    write(data: string): void
    resize(): void
    kill(): void
    process: string
  }
  const procs: Proc[] = []
  const spawned: { env: NodeJS.ProcessEnv; proc: Proc }[] = []
  return {
    procs,
    spawned,
    spawn: (_file: string, _args: string[], opts: { env: NodeJS.ProcessEnv }): Proc => {
      const proc: Proc = {
        pid: process.pid,
        written: [],
        onData(cb) {
          proc.said = cb
        },
        onExit() {},
        write(data) {
          proc.written.push(data)
        },
        resize() {},
        kill() {},
        process: 'zsh'
      }
      procs.push(proc)
      spawned.push({ env: opts.env, proc })
      return proc
    }
  }
})
vi.mock('node-pty', () => ({ spawn: terminal.spawn }))

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-message-bytes-'))
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

const appServer = vi.hoisted(() => ({
  transports: [] as { onFrame: (side: string, frame: unknown) => void }[],
  asked: [] as { method: string; params: unknown }[],
  refuses: false
}))
vi.mock('../../../../src/agents/codex/main/codexTransport', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../../src/agents/codex/main/codexTransport')>()
  const { CodexRpcThatListsNoHooks } = await import('../../helpers/codexRpcStub')
  return {
    ...real,
    createCodexTransport: async (options: { onFrame: (side: string, frame: unknown) => void }) => {
      appServer.transports.push(options)
      return {
        url: 'unix:///test/rpc.sock',
        stop: async () => {},
        request: async (method: string, params: unknown) => {
          if (method !== 'thread/queue/add') return {}
          if (appServer.refuses) throw new Error('<the fake app-server refuses the request>')
          appServer.asked.push({ method, params })
          return {}
        }
      }
    },
    CodexRpc: CodexRpcThatListsNoHooks
  }
})

import { Commands } from '../../../../src/core/commands'
import { PLUGINS } from '../../../../src/plugins/list'
import { PtyManager } from '../../../../src/main/ptyManager'
import { sessionMessaging } from '../../../../src/main/sessionMessaging'
import { sessionVerb, type Target } from '../../../../src/plugins/sessions/main/sessionVerbs'
import { HandOver, type Recipient } from '../../../../src/plugins/sessions/main/handOver'
import { StartedSessions } from '../../../../src/plugins/sessions/main/startedSessions'
import {
  noteOfWhatKoloftSends,
  noteSent,
  writeConductorMarker
} from '../../../../src/plugins/sessions/main/hooks'
import { FROM_KOLOFT } from '../../../../src/plugins/sessions/main/messageOpenings'
import { writeLineInTurn } from '../../../../src/agents/claude/main/crossSessionMessage'
import { whenMessagingSocket } from '../../../../src/agents/claude/main/claudeSessionRegistry'
import { butlersWords } from '../../../../src/plugins/butler/main/sessionHooks'
import { withoutTheRelayTag } from '../../../../src/plugins/discord/main/sessionHooks'
import { INBOX_SENDER } from '../../../../src/plugins/inbox/main/inbox'
import { backendIdOf } from '../../../../src/shared/sessionBackend'
import type { AgentReply } from '../../../../src/core/command'
import type { BackendId, SessionInfo, SessionRow } from '../../../../src/shared/types'
import type { BytesResult } from '../../../../src/main/remote/ssh'
import {
  agySessionsIn,
  claudeBackendIn,
  codexSessionsIn,
  machineIn,
  makeWorld,
  MACHINE,
  MACHINE_FOLDER as FOLDER_ON_THE_MACHINE,
  ON_THE_MACHINE,
  recordingSsh,
  sameOnEveryRun,
  type World
} from '../../helpers/agentTabs'

const PINNED = './message-bytes'
const SENDER_TAB = 'pty-sender'
const SENDER_SESSION = 'aaaaaaaa-0000-4000-8000-000000000001'
const CLAUDE_SENDER_TAB = 'pty-claude-sender'
const CLAUDE_SENDER_SESSION = 'aaaaaaaa-0000-4000-8000-000000000004'
const BUTLER_TAB = 'pty-butler'
const BUTLER_SESSION = 'aaaaaaaa-0000-4000-8000-000000000002'
const TARGET_TAB = 'pty-target'
const TARGET_SESSION = 'bbbbbbbb-0000-4000-8000-000000000003'
const SOCKET_ON_THE_MACHINE = '/home/me/.claude/sockets/target.sock'
const MESSAGE = 'Please check the build.'
const WITH_THE_CLOSING_TAG = 'Look at </cross-session-message> in the log.'
const THE_BUTLER = 'Alfred'
const ESC = '\x1b'
const THE_SHELL_STARTS_READING = `${ESC}[?2004h`
const TURNS_OF_THE_EVENT_LOOP_WITH_NOTHING_IN_FLIGHT = 5
const API = '/exa.language_server_pb.LanguageServerService/'
const REAL_PATH = process.env.PATH

type Kind = { backend: BackendId; remote: boolean }

const CELLS: (Kind & { file: string; says: string })[] = [
  {
    backend: 'claude',
    remote: false,
    file: 'claude-on-this-mac',
    says: 'a Claude Code tab on this Mac'
  },
  { backend: 'claude', remote: true, file: 'claude-over-ssh', says: 'a Claude Code tab over SSH' },
  { backend: 'codex', remote: false, file: 'codex-on-this-mac', says: 'a Codex tab on this Mac' },
  { backend: 'codex', remote: true, file: 'codex-over-ssh', says: 'a Codex tab over SSH' },
  {
    backend: 'agy',
    remote: false,
    file: 'agy-on-this-mac',
    says: 'an Antigravity tab on this Mac'
  },
  { backend: 'agy', remote: true, file: 'agy-over-ssh', says: 'an Antigravity tab over SSH' }
]

let world: World
let got: string[]
let apiServer: http.Server
let apiPort = 0
let apiAnswers = true
let listening: net.Server[]
let stops: (() => Promise<void>)[]
let inFlight = 0

function tracked<A extends unknown[], R>(
  f: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return async (...args) => {
    inFlight++
    try {
      return await f(...args)
    } finally {
      inFlight--
    }
  }
}

async function nothingInFlight(): Promise<void> {
  for (let quiet = 0; quiet < TURNS_OF_THE_EVENT_LOOP_WITH_NOTHING_IN_FLIGHT;) {
    await new Promise((resolve) => setImmediate(resolve))
    quiet = inFlight === 0 ? quiet + 1 : 0
  }
}

beforeAll(async () => {
  apiServer = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (!apiAnswers) {
        res.writeHead(503)
        return res.end('down')
      }
      const method = req.url!.slice(API.length)
      if (method === 'StreamAgentStateUpdates') return res.end()
      if (method === 'SendUserCascadeMessage')
        got.push(`agy's API, ${method}: ${Buffer.concat(chunks).toString('utf8')}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        method === 'GetCascadeTrajectory'
          ? JSON.stringify({
              trajectory: {
                steps: [{ userInput: { userConfig: { plannerConfig: { planModel: 'M36' } } } }]
              }
            })
          : '{}'
      )
    })
  })
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve))
  apiPort = (apiServer.address() as net.AddressInfo).port
})

afterAll(() => {
  apiServer.close()
})

beforeEach(() => {
  world = makeWorld()
  got = []
  listening = []
  stops = []
  apiAnswers = true
  inFlight = 0
  appServer.transports.length = 0
  appServer.asked.length = 0
  appServer.refuses = false
  terminal.procs.length = 0
  terminal.spawned.length = 0
  const bin = path.join(world.home, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, 'ssh'),
    [
      '#!/bin/sh',
      'case " $* " in',
      `  *" -W "*) { printf 'ssh'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; cat; } >> '${path.join(world.home, 'ssh-W.log')}' ;;`,
      '  *) exec /usr/bin/ssh "$@" ;;',
      'esac',
      ''
    ].join('\n'),
    { mode: 0o755 }
  )
  process.env.PATH = `${bin}:${REAL_PATH}`
})

afterEach(async () => {
  for (const stop of stops) await stop()
  for (const server of listening) server.close()
  process.env.PATH = REAL_PATH
  await world.gone()
})

function shown(text: string): string {
  return JSON.stringify(text)
}

const linesTakenAt = new Map<string, number>()

function listenAt(socket: string, whose: string): void {
  linesTakenAt.set(socket, 0)
  const server = net.createServer((conn) => {
    const chunks: Buffer[] = []
    conn.on('data', (c: Buffer) => chunks.push(c))
    conn.on('error', () => {})
    conn.on('close', () => {
      got.push(`${whose}'s message socket: ${shown(Buffer.concat(chunks).toString('utf8'))}`)
      linesTakenAt.set(socket, linesTakenAt.get(socket)! + 1)
    })
  })
  server.listen(socket)
  listening.push(server)
}

async function writeLineAndSeeItTaken(
  receiver: string,
  line: string,
  write?: (line: string) => Promise<void>
): Promise<void> {
  const before = linesTakenAt.get(receiver)
  await writeLineInTurn(receiver, line, write)
  if (before === undefined) return
  while (linesTakenAt.get(receiver) === before)
    await new Promise((resolve) => setImmediate(resolve))
}

const procStart = (): string =>
  execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8'
  }).trim()

function registerClaude(
  registry: string,
  sessionId: string,
  socket: string,
  pidName: number
): void {
  fs.mkdirSync(registry, { recursive: true })
  fs.writeFileSync(
    path.join(registry, `${pidName}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId,
      procStart: procStart(),
      messagingSocketPath: socket
    })
  )
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

function info(
  tabId: string,
  sessionId: string,
  backendId: BackendId,
  title: string,
  remote: boolean
): SessionInfo {
  return {
    tabId,
    backendId,
    host: remote ? 'ssh' : 'local',
    sessionId,
    nativeSessionId: sessionId,
    title,
    cwd: remote ? ON_THE_MACHINE : world.repo,
    treeRoot: remote ? ON_THE_MACHINE : world.repo,
    alive: true,
    status: 'waiting',
    updatedAt: 1,
    ...(remote && { remote: { host: MACHINE, path: '/home/me/proj' } })
  } as SessionInfo
}

const SCRIPT_BELOW = ' <base64 of the script below>\n'
const ITS_STDIN = '\n--- its stdin ---\n'

function scriptsRunOnTheMachine(): { of(ran: string): string; listed(): string[] } {
  const seen: string[] = []
  return {
    of: (ran) => {
      const at = ran.indexOf(SCRIPT_BELOW)
      if (at < 0) return ran
      const [script, stdin] = ran.slice(at + SCRIPT_BELOW.length).split(ITS_STDIN)
      const lines = script.split('\n')
      const args = lines.find((l) => l.startsWith('set -- ')) ?? '(no arguments)'
      const body = [ran.slice(0, at), ...lines.filter((l) => l !== args)].join('\n')
      if (!seen.includes(body)) seen.push(body)
      return [
        `script ${seen.indexOf(body) + 1} with ${args}`,
        ...(stdin === undefined ? [] : [`  its stdin: ${shown(stdin)}`])
      ].join('\n')
    },
    listed: () => seen.map((body, i) => section(`script ${i + 1}, as run on the machine`, [body]))
  }
}

const tabWrote = (proc: (typeof terminal.procs)[number], from: number): string[] =>
  proc.written.slice(from)

interface Stage {
  verb(args: string[], fromTab: string): Promise<string>
  sendFrom: ReturnType<typeof sessionVerb>['sendFrom']
  tellFromKoloft: ReturnType<typeof sessionVerb>['tellFromKoloft']
  turnEnded(said: string, reply: string): boolean
  waitsOnSender(): boolean
  handOver: HandOver
  recipient: Recipient
  undelivered: string[]
  setBusy(busy: boolean): void
  turn: { dies: boolean }
  conversation: { started: boolean }
  open: { now: boolean }
  shut(): void
  drain(): Promise<string[]>
  scripts(): string[]
  setApi(answers: boolean): void
  codexGone: { now: boolean }
}

async function stage(kind: Kind): Promise<Stage> {
  const ptyMgr = koloftsTerminals()
  const registry = path.join(world.home, '.claude', 'sessions')
  const butlerSocket = path.join(world.home, 'b.sock')
  listenAt(butlerSocket, THE_BUTLER)
  registerClaude(registry, BUTLER_SESSION, butlerSocket, 1002)

  const machineAnswers = { code: 0 }
  const onTheMachine = recordingSsh((readable) => {
    if (/AGY|agy/.test(readable) && readable.includes('--- its stdin ---'))
      return { code: machineAnswers.code }
    return {}
  })
  const ranBefore = { n: 0 }

  const cwd = kind.remote ? ON_THE_MACHINE : world.repo
  let claudeTab = false
  let codex: ReturnType<typeof codexSessionsIn> | null = null
  let agy: ReturnType<typeof agySessionsIn> | null = null
  const codexGone = { now: false }
  if (kind.backend === 'claude') {
    const backend = claudeBackendIn(world, ptyMgr, {
      machine: { run: recordingSsh().run },
      remoteTab: kind.remote ? ({ host: MACHINE } as never) : undefined
    })
    const made = await backend.create({ kind: 'claude', cwd, tabId: TARGET_TAB })
    if (!made.ok) throw new Error(`launch refused: ${made.code}`)
    claudeTab = true
    if (!kind.remote) {
      const socket = path.join(world.home, 't.sock')
      listenAt(socket, 'the Claude Code session')
      registerClaude(registry, TARGET_SESSION, socket, 1003)
    }
  } else if (kind.backend === 'codex') {
    codex = codexSessionsIn(world, ptyMgr, {
      ranOnTheMachine: [],
      run: () => ({ code: 1, stdout: '', stderr: '' })
    })
    stops.push(() => codex!.stopAll())
    await codex.launch({ kind: 'codex', cwd, tabId: TARGET_TAB })
    const receive = appServer.transports.at(-1)!.onFrame
    receive('client', { id: 1, method: 'thread/start', params: {} })
    receive('server', {
      id: 1,
      result: {
        thread: {
          id: TARGET_SESSION,
          cwd: kind.remote ? FOLDER_ON_THE_MACHINE : cwd,
          name: 'Target',
          createdAt: 1,
          status: { type: 'idle' }
        }
      }
    })
    await vi.waitFor(() =>
      expect(codex!.list().find((s) => s.tabId === TARGET_TAB)?.nativeSessionId).toBe(
        TARGET_SESSION
      )
    )
  } else {
    agy = agySessionsIn(world, ptyMgr, {
      machine: { run: onTheMachine.run },
      apiKey: 'api-key-of-the-koloft-account'
    })
    stops.push(() => agy!.stopAll())
    await agy.launch({ kind: 'agy', cwd, tabId: TARGET_TAB, trustFolder: true })
    const proc = terminal.procs.at(-1)!
    if (kind.remote) {
      fs.writeFileSync(
        path.join(world.home, 'mirror-hooks', `${TARGET_TAB}.agy.jsonl`),
        JSON.stringify({ conversation_id: TARGET_SESSION, agent_state: 'idle' }) + '\n'
      )
      agy.mirrorPulled(MACHINE)
    } else {
      const env = terminal.spawned.at(-1)!.env
      const settings = JSON.parse(
        fs.readFileSync(
          path.join(world.home, 'agy-homes', 'work', 'antigravity-cli', 'settings.json'),
          'utf8'
        )
      )
      execFileSync('/bin/sh', ['-c', settings.title.command], {
        input: JSON.stringify({ agent_state: 'idle', conversation_id: TARGET_SESSION }),
        env,
        encoding: 'utf8'
      })
      proc.said?.(`${ESC}]7501;state=idle:app=antigravity${ESC}\\`)
    }
    await vi.waitFor(() =>
      expect(agy!.list().find((s) => s.tabId === TARGET_TAB)?.nativeSessionId).toBe(TARGET_SESSION)
    )
  }
  const proc = terminal.spawned.at(-1)!.proc
  proc.said?.(THE_SHELL_STARTS_READING)
  ptyMgr.agentBound(TARGET_TAB)
  let typedFrom = proc.written.length

  const target = info(TARGET_TAB, TARGET_SESSION, kind.backend, 'Target', kind.remote)
  const sender = info(SENDER_TAB, SENDER_SESSION, 'codex', 'Sender', false)
  const claudeSender = info(
    CLAUDE_SENDER_TAB,
    CLAUDE_SENDER_SESSION,
    'claude',
    'Claude sender',
    false
  )
  const butler = info(BUTLER_TAB, BUTLER_SESSION, 'claude', THE_BUTLER, false)
  const butlerTarget: Target = {
    key: BUTLER_SESSION,
    name: THE_BUTLER,
    backend: 'claude',
    remote: false,
    tabId: BUTLER_TAB,
    overseer: true,
    open: async () => BUTLER_TAB
  }
  const open = { now: true }
  const turn = { busy: false, dies: false, waiting: [] as (() => void)[] }
  const setBusy = (busy: boolean): void => {
    turn.busy = busy
    if (busy) return
    for (const wake of turn.waiting.splice(0)) {
      inFlight++
      wake()
    }
  }
  const conversation = { started: true }
  const undelivered: string[] = []
  const everyone = (): SessionInfo[] => [sender, claudeSender, ...(open.now ? [target] : [])]
  const sessionOfTab = (tab: string): SessionInfo | undefined =>
    [sender, claudeSender, butler, target].find((s) => s.tabId === tab)

  const noteSsh = recordingSsh()
  const machines = new Map<string, ReturnType<typeof machineIn>>()
  const messaging = sessionMessaging({
    tracker: {
      remoteOf: (tab) => (tab === TARGET_TAB && kind.remote ? { host: MACHINE } : undefined)
    },
    hosts: {
      machine: (host) => {
        if (!machines.has(host)) machines.set(host, machineIn(world, host, { run: noteSsh.run }))
        return machines.get(host)!
      }
    },
    get codexSessions() {
      return codexGone.now ? null : codex
    },
    hookRegDir: world.regDir,
    butler: { firstWordsComing: () => {} },
    sessionBackends: {
      permissionClass: (tab) => (tab === BUTLER_TAB || tab === TARGET_TAB ? 'bypass' : 'prompting')
    },
    writeLineInTurn: writeLineAndSeeItTaken,
    noteOfWhatKoloftSends,
    noteSent,
    buildHandOver: (d) =>
      new HandOver({
        ...d,
        ready: tracked(d.ready),
        type: tracked(d.type),
        queue: tracked(d.queue),
        sendLine: tracked(d.sendLine),
        noteSent: tracked(d.noteSent)
      }),
    ptyMgr,
    startupErrors: { codex: '<why Codex could not start>' },
    remoteControlDir: world.controlDir,
    sessionOfTab,
    machineOfTab: (tab) =>
      tab === TARGET_TAB && kind.remote ? (codex?.machineOfTab(tab) ?? MACHINE) : undefined,
    storedOwnerOf: (tab) => (tab === TARGET_TAB ? (agy ?? codex ?? undefined) : undefined),
    liveClaudeRegistryOn: async () =>
      JSON.stringify({ sessionId: TARGET_SESSION, messagingSocketPath: SOCKET_ON_THE_MACHINE }) +
      '\0',
    whenMessagingSocket: (sessionId, ms) => whenMessagingSocket(sessionId, ms, registry),
    whenMessagingSocketOnMachine: async (sessionId, ms, readLiveRegistry) => {
      const { whenMessagingSocketOnMachine } =
        await import('../../../../src/agents/claude/main/claudeSessionRegistry')
      return whenMessagingSocketOnMachine(sessionId, ms, readLiveRegistry)
    }
  })

  const started = new StartedSessions(() => path.join(world.home, 'started-sessions.json'))
  const verbs = sessionVerb({
    workspaceOf: (tab) => sessionOfTab(tab)?.cwd,
    allSessions: everyone,
    tabOpen: (tab) => everyone().some((s) => s.tabId === tab),
    pinnedWorkspaces: () => [{ path: world.repo, missing: false }],
    peerNames: () => async () => null,
    turnedOff: () => null,
    projectRules: async () => undefined,
    pickFacts: async () => ({ fableLeft: true }),
    launch: async () => null,
    assist: async () => null,
    startedSessions: started,
    closable: () => [],
    whatIsLeft: async () => [],
    closeSoon: () => {},
    overseer: {
      is: (tab) => tab === BUTLER_TAB,
      target: (ref) => (ref === BUTLER_SESSION ? butlerTarget : undefined),
      folder: () => path.join(world.home, 'butler'),
      ...butlersWords
    },
    speaksForTheOwner: (tab) => tab === BUTLER_TAB,
    sidebar: () => [
      {
        workspace: { path: cwd, missing: false, isGit: true, hasHistory: true },
        rows: [
          {
            id: TARGET_SESSION,
            nativeSessionId: TARGET_SESSION,
            title: 'Target',
            cwd,
            worktree: 'main',
            running: open.now,
            invalidCwd: false,
            mtime: 1,
            backendId: kind.backend,
            host: kind.remote ? 'ssh' : 'local'
          } as SessionRow
        ]
      }
    ],
    worktrees: async () => [],
    readTurns: async () => [],
    transcriptPlaces: () => undefined,
    quotedPrompt: () => undefined,
    resume: tracked(async () => {
      open.now = true
      return TARGET_TAB
    }),
    ready: tracked(async (tab, ms, turnEnded) => {
      if (tab !== TARGET_TAB || !turnEnded || !turn.busy) return true
      if (ms <= 0 || turn.dies) return false
      inFlight--
      await new Promise<void>((wake) => turn.waiting.push(wake))
      return true
    }),
    bound: async (tab) => tab !== TARGET_TAB || conversation.started,
    asking: () => false,
    queue: tracked(messaging.forSessionVerbs.queue),
    sendLine: tracked(messaging.forSessionVerbs.sendLine),
    press: tracked(messaging.forSessionVerbs.press),
    deliver: tracked(messaging.forSessionVerbs.deliver),
    noteSent: tracked(messaging.forSessionVerbs.noteSent),
    modeOf: messaging.forSessionVerbs.modeOf,
    stop: () => {},
    answer: async () => undefined,
    undelivered: (_callerTab, t, why) => void undelivered.push(`to ${t.name}: ${why}`),
    command: async () => '',
    screen: async () => ({ error: 'no screen' }),
    rowNote: () => undefined,
    announceStarting: async () => [],
    announceStarted: async () => [],
    ownersWords: withoutTheRelayTag
  })
  const commands = new Commands(PLUGINS)
  commands.register({ session: verbs.verb })

  const handOver = messaging.handOver(
    {
      backendOf: (tab) => backendIdOf(ptyMgr.get(tab)?.kind),
      boundKey: (tab) => sessionOfTab(tab)?.sessionId || undefined,
      type: (tab, keys) => ptyMgr.type(tab, keys)
    },
    { typable: () => true }
  ) as HandOver

  const scripts = scriptsRunOnTheMachine()

  const sentNotes = (): string[] =>
    fs
      .readdirSync(world.regDir)
      .filter((f) => f.startsWith(TARGET_TAB))
      .flatMap((f) => {
        const file = path.join(world.regDir, f)
        const text = fs.readFileSync(file, 'utf8')
        fs.rmSync(file)
        return [`Koloft noted in ${f}: ${shown(text)}`]
      })

  return {
    verb: async (args, fromTab) => {
      const reply: AgentReply = await commands.dispatch('session', args, {
        tabId: fromTab,
        cwd: world.repo,
        session: sessionOfTab(fromTab)
      } as never)
      return `exit ${reply.exit}: ${reply.text}`
    },
    sendFrom: verbs.sendFrom,
    tellFromKoloft: verbs.tellFromKoloft,
    turnEnded: (said, reply) =>
      verbs.turnEnded(TARGET_TAB, { said: [{ who: 'owner', text: said, at: 1 }], reply, at: 1 }),
    waitsOnSender: () => {
      target.status = 'working'
      const waits = verbs.waitsOnAnother(SENDER_SESSION)
      target.status = 'waiting'
      return waits
    },
    handOver,
    recipient: {
      key: TARGET_SESSION,
      name: 'Target',
      liveTab: () => TARGET_TAB,
      open: async () => TARGET_TAB,
      ownerIsWhere: () => '<where the owner is>'
    },
    undelivered,
    setBusy,
    turn,
    conversation,
    open,
    shut: () => {
      open.now = false
    },
    codexGone,
    scripts: () => scripts.listed(),
    setApi: (answers) => {
      apiAnswers = answers
      machineAnswers.code = answers ? 0 : 1
    },
    drain: async () => {
      await nothingInFlight()
      const lines = [...got]
      got.length = 0
      for (const asked of appServer.asked.splice(0))
        lines.push(`Codex's app-server, ${asked.method}: ${JSON.stringify(asked.params)}`)
      const sshW = path.join(world.home, 'ssh-W.log')
      if (fs.existsSync(sshW)) {
        lines.push(`ssh -W wrote: ${shown(fs.readFileSync(sshW, 'utf8'))}`)
        fs.rmSync(sshW)
      }
      for (const ran of onTheMachine.ran.slice(ranBefore.n))
        if (ran.includes('--- its stdin ---')) lines.push(`ran on the machine: ${scripts.of(ran)}`)
      ranBefore.n = onTheMachine.ran.length
      const typed = tabWrote(proc, typedFrom)
      typedFrom = proc.written.length
      if (typed.length)
        lines.push(`typed into the tab's terminal: ${typed.map(shown).join(' then ')}`)
      for (const ran of noteSsh.ran.splice(0))
        lines.push(`noted on the machine: ${scripts.of(ran)}`)
      lines.push(...sentNotes())
      return lines
    }
  }
}

function section(title: string, lines: string[]): string {
  return [`=== ${title} ===`, ...(lines.length ? lines : ['(nothing)'])].join('\n')
}

async function everyCase(kind: Kind): Promise<string> {
  const s = await stage(kind)
  const out: string[] = []

  out.push(
    section('koloft session send from a Claude Code session on this Mac, the target idle', [
      `the sender sees: ${await s.verb(['send', 'Target', MESSAGE], CLAUDE_SENDER_TAB)}`,
      ...(await s.drain())
    ])
  )

  out.push(
    section('koloft session send from a Codex session on this Mac, the target idle', [
      `the sender sees: ${await s.verb(['send', 'Target', MESSAGE], SENDER_TAB)}`,
      `while the target works, it counts as waiting on the sender: ${s.waitsOnSender()}`,
      ...(await s.drain())
    ])
  )

  s.setBusy(true)
  const busyReply = await s.verb(['send', 'Target', MESSAGE], SENDER_TAB)
  const busyNow = await s.drain()
  s.setBusy(false)
  out.push(
    section('koloft session send from a session, the target busy, with its own API answering', [
      `the sender sees: ${busyReply}`,
      'got at once:',
      ...busyNow,
      'got once its turn ended:',
      ...(await s.drain())
    ])
  )

  s.setApi(false)
  s.setBusy(true)
  const busyNoApi = await s.verb(['send', 'Target', MESSAGE], SENDER_TAB)
  const busyNoApiNow = await s.drain()
  s.setBusy(false)
  out.push(
    section('koloft session send from a session, the target busy, with its own API not answering', [
      `the sender sees: ${busyNoApi}`,
      'got at once:',
      ...busyNoApiNow,
      'got once its turn ended:',
      ...(await s.drain())
    ])
  )

  s.setBusy(true)
  s.turn.dies = true
  const dying = await s.verb(['send', 'Target', MESSAGE], SENDER_TAB)
  const dyingGot = await s.drain()
  out.push(
    section(
      'koloft session send from a session, the target busy and its tab ends before its turn does, its own API not answering',
      [
        `the sender sees: ${dying}`,
        `told to the sender later: ${s.undelivered.splice(0).join(' | ') || '(nothing)'}`,
        ...dyingGot
      ]
    )
  )
  s.setBusy(false)
  s.turn.dies = false

  s.conversation.started = false
  out.push(
    section(
      'koloft session send from a session, the target idle but with no conversation yet, its own API not answering',
      [
        `the sender sees: ${await s.verb(['send', 'Target', MESSAGE], SENDER_TAB)}`,
        ...(await s.drain())
      ]
    )
  )
  s.conversation.started = true
  s.setApi(true)

  s.shut()
  const closed = await s.verb(['send', 'Target', MESSAGE], SENDER_TAB)
  out.push(
    section('koloft session send from a session, the target closed (resumed first)', [
      `the sender sees: ${closed}`,
      ...(await s.drain())
    ])
  )

  out.push(
    section('koloft session send from a session, the message holding </cross-session-message>', [
      `the sender sees: ${await s.verb(['send', 'Target', WITH_THE_CLOSING_TAG], SENDER_TAB)}`,
      ...(await s.drain())
    ])
  )

  out.push(
    section('the butler sends for the owner (an owed reply is recorded)', [
      `the butler sees: ${await s.verb(['send', 'Target', MESSAGE], BUTLER_TAB)}`,
      `the target ends a turn that did not take the message: paid back now: ${s.turnEnded('something the owner typed', 'An unrelated reply.')}`,
      ...(await s.drain()),
      `the target ends a turn that took the message: paid back now: ${s.turnEnded(butlersWords.says(MESSAGE), 'The build is green.')}`,
      ...(await s.drain())
    ])
  )

  out.push(
    section("Koloft's own notice (a restart cut the run off)", [
      `delivered: ${await s.tellFromKoloft(TARGET_TAB, 'The restart cut your run off.')}`,
      ...(await s.drain())
    ])
  )

  out.push(
    section('the Inbox sends, the target idle', [
      `the Inbox sees: ${JSON.stringify(await s.sendFrom(INBOX_SENDER, TARGET_SESSION, 'Yes, go ahead.', false))}`,
      ...(await s.drain())
    ])
  )

  out.push(
    section("the Inbox sends an answer to the session's own question (toItsOwnSession)", [
      `the Inbox sees: ${JSON.stringify(await s.sendFrom(INBOX_SENDER, TARGET_SESSION, 'Yes, go ahead.', true))}`,
      ...(await s.drain())
    ])
  )

  out.push(
    section('the Inbox sends, the message holding </cross-session-message>', [
      `the Inbox sees: ${JSON.stringify(await s.sendFrom(INBOX_SENDER, TARGET_SESSION, WITH_THE_CLOSING_TAG, false))}`,
      ...(await s.drain())
    ])
  )

  s.setApi(false)
  s.setBusy(true)
  const inboxBusy = s.sendFrom(INBOX_SENDER, TARGET_SESSION, 'Yes, go ahead.', false)
  const inboxBusyNow = await s.drain()
  s.setBusy(false)
  out.push(
    section('the Inbox sends, the target busy, with its own API not answering', [
      'got while it was busy:',
      ...inboxBusyNow,
      `the Inbox sees: ${JSON.stringify(await inboxBusy)}`,
      'got once its turn ended:',
      ...(await s.drain())
    ])
  )
  s.setApi(true)

  s.shut()
  out.push(
    section('the Inbox sends, the target closed (resumed first)', [
      `the Inbox sees: ${JSON.stringify(await s.sendFrom(INBOX_SENDER, TARGET_SESSION, 'Yes, go ahead.', false))}`,
      ...(await s.drain())
    ])
  )

  const refusedHandOver = await new Promise<string | undefined>((settle) =>
    s.handOver.hand(s.recipient, {
      clientId: 'koloft-discord-1233',
      text: async () => `[Discord] ${WITH_THE_CLOSING_TAG}`,
      settle
    })
  )
  out.push(
    section('Discord hands a message over, the message holding </cross-session-message>', [
      `failed: ${refusedHandOver ?? '(no)'}`,
      ...(await s.drain())
    ])
  )

  const handed = await new Promise<string | undefined>((settle) =>
    s.handOver.hand(s.recipient, {
      clientId: 'koloft-discord-1234',
      text: async () => '[Discord] Hello from the phone.',
      settle
    })
  )
  out.push(
    section('Discord hands a message over', [`failed: ${handed ?? '(no)'}`, ...(await s.drain())])
  )

  out.push(
    section('Koloft tells the session through the hand-over (as it tells the butler)', [
      `delivered: ${await s.handOver.tell(s.recipient, `${FROM_KOLOFT}Could not deliver to Target.`)}`,
      ...(await s.drain())
    ])
  )

  if (kind.backend === 'codex') {
    s.codexGone.now = true
    out.push(
      section('Codex did not start in this Koloft: koloft session send', [
        `the sender sees: ${await s.verb(['send', 'Target', MESSAGE], SENDER_TAB)}`,
        ...(await s.drain())
      ])
    )
    const gone = await new Promise<string | undefined>((settle) =>
      s.handOver.hand(s.recipient, {
        clientId: 'koloft-discord-1235',
        text: async () => '[Discord] Hello again.',
        settle
      })
    )
    out.push(
      section('Codex did not start in this Koloft: Discord hands a message over', [
        `failed: ${gone ?? '(no)'}`,
        ...(await s.drain())
      ])
    )
    s.codexGone.now = false
    appServer.refuses = true
    out.push(
      section('the app-server refuses the queued message', [
        `the sender sees: ${await s.verb(['send', 'Target', MESSAGE], SENDER_TAB)}`,
        ...(await s.drain())
      ])
    )
    appServer.refuses = false
  }

  if (kind.backend === 'claude' && !kind.remote) {
    await new Promise((closed) => listening.at(-1)!.close(closed))
    out.push(
      section('the message socket file is gone (its server closed it)', [
        `the sender sees: ${await s.verb(['send', 'Target', MESSAGE], SENDER_TAB)}`,
        ...(await s.drain())
      ])
    )
  }

  out.push(...s.scripts())

  return sameOnEveryRun(out.join('\n\n'), world).replaceAll(String(apiPort), '<port>').concat('\n')
}

describe('what a message ends as in each agent’s hands — from koloft session send, the butler, Koloft’s notices, the Inbox and Discord’s hand-over, to the bytes each kind of tab gets — pinned so that moving the sending into the agents changes no cell', () => {
  for (const cell of CELLS)
    it(
      cell.says,
      async () => {
        await expect(await everyCase(cell)).toMatchFileSnapshot(`${PINNED}/${cell.file}.txt`)
      },
      60_000
    )
})
