import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { codexWires } from './codexWires'
import type { BackendId } from '@shared/types'
import { BackgroundFile } from '../../../src/main/backgroundFile'
import {
  agySessionsIn,
  claudeBackendIn,
  codexSessionsIn,
  makeWorld,
  ON_THE_MACHINE,
  type World
} from './agentTabs'
import {
  AskSurfaces,
  CHANNEL,
  holdAsksOf,
  runAskHook,
  SESSION_TITLE,
  writeHookScript
} from './askSurfaces'

const PINNED = './ask-text'
const SID = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '3f1c2b9e-0d4a-4c1e-9a7b-5e6f7a8b9c0d'
const THREAD = '22222222-2222-4222-8222-222222222222'
const CODEX_REQUEST_ID = 7
const ESC = '\x1b'
const SETTLES_MS = 100
const A_FIRST_INBOX_CARD_IS_ASKED_AGAIN_AFTER_MS = 1800
const A_HOOK_SEES_ITS_ANSWER_WITHIN_MS = 2500
const A_REPLY_IS_SEEN_WITHIN_MS = 10_000
const AN_AGENT_UNDER_LOAD_IS_READ_WITHIN_MS = 10_000
const PAST_THE_WAIT_FOR_A_TAKEN_ANSWER_MS = 1000
// PLATFORM§28
const A_FOLDER_WATCH_GOES_LIVE_WITHIN_MS = 500
export const A_SITUATION_TAKES_UP_TO_MS = 120_000
export const A_REFUSALS_TAKE_UP_TO_MS = 240_000

type Kind = 'claude-held' | 'claude-keys' | 'codex' | 'agy-api' | 'agy-keys'

const KINDS: Kind[] = ['claude-held', 'claude-keys', 'codex', 'agy-api', 'agy-keys']

const SECTION_TITLE: Record<Kind, string> = {
  'claude-held':
    'Claude Code, its ask held by its hook (a tab on this Mac that Discord or the owner-asleep butler answers)',
  'claude-keys':
    'Claude Code, its ask not held (a tab on this Mac nobody answers from elsewhere, or any tab on another machine, whose hook only records): Koloft answers by keys',
  codex: "Codex (its app-server's request, read on the TUI's connection)",
  'agy-api': 'Antigravity, read through its API (a tab on this Mac)',
  'agy-keys':
    'Antigravity, read from its tool call and 7501 status only (its API not answering, as on another machine): Koloft answers by keys'
}

const BACKEND_OF: Record<Kind, BackendId> = {
  'claude-held': 'claude',
  'claude-keys': 'claude',
  codex: 'codex',
  'agy-api': 'agy',
  'agy-keys': 'agy'
}

interface ClaudeAsk {
  tool_name: string
  tool_input: Record<string, unknown>
}

interface CodexAsk {
  before?: { method: string; params: Record<string, unknown> }[]
  method: string
  params: Record<string, unknown>
}

interface AgyAsk {
  tool?: { name: string; args: Record<string, unknown> }
  status: { kind: string; msg?: string }
  api?: unknown
  plan?: string
}

interface Never {
  never: string
}

interface Situation {
  file: string
  title: string
  claude: ClaudeAsk | Never
  codex: CodexAsk | Never
  agy: AgyAsk | Never
  replies: string[]
}

const FILE = '/home/me/proj/src/notes.md'
const OUTSIDE = '/elsewhere/outside.txt'
const COLOURS = [
  { label: 'Red', description: 'Choose red.' },
  { label: 'Green', description: 'Choose green.' }
]
const SIZES = [{ label: 'Small' }, { label: 'Large' }]
const TOPPINGS = [{ label: 'Cheese' }, { label: 'Ham' }, { label: 'Olives' }]
const PLAN = '# Plan\n1. Read the docs\n2. Fix the links'

const apiOptions = (labels: { label: string }[]): { id: string; text: string }[] =>
  labels.map((o, i) => ({ id: String.fromCharCode(97 + i), text: o.label }))

const waitingStep = (requestedInteraction: unknown): unknown => ({
  trajectoryId: 't9',
  steps: [
    { userInput: { userConfig: { plannerConfig: { planModel: 'M36' } } } },
    { status: 'CORTEX_STEP_STATUS_DONE' },
    { status: 'CORTEX_STEP_STATUS_WAITING', requestedInteraction }
  ]
})

const codexQuestion = (
  id: string,
  question: string,
  options: { label: string; description?: string }[],
  isOther: boolean
): Record<string, unknown> => ({
  id,
  header: id,
  question,
  isOther,
  isSecret: false,
  options
})

const NAMES_ITS_TOOL_ALWAYS =
  "Claude Code's PermissionRequest hook always names its tool (tool_name) and hands its input (CC§14)"

const SITUATIONS: Situation[] = [
  {
    file: 'one-question-own-words',
    title: 'Asks one question that takes one pick, and takes own words',
    claude: {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which colour do you prefer?',
            header: 'Colour',
            options: COLOURS,
            multiSelect: false
          }
        ]
      }
    },
    codex: {
      method: 'item/tool/requestUserInput',
      params: {
        itemId: 'call_1',
        questions: [codexQuestion('colour', 'Which colour do you prefer?', COLOURS, true)],
        isBlocking: true,
        autoResolutionMs: null
      }
    },
    agy: {
      tool: {
        name: 'ask_question',
        args: {
          questions: [{ question: 'Which colour do you prefer?', options: ['Red', 'Green'] }]
        }
      },
      status: { kind: 'question', msg: 'Which colour do you prefer?' },
      api: waitingStep({
        askQuestion: {
          questions: [{ question: 'Which colour do you prefer?', options: apiOptions(COLOURS) }]
        }
      })
    },
    replies: ['1', 'Green', 'Blue, please']
  },
  {
    file: 'one-question-no-own-words',
    title: 'Asks one question that takes one pick, and takes no own words',
    claude: {
      never:
        'every Claude Code question has its own row for own words (its dialog draws “Type something.”, CC§14), so Koloft takes own words for all of them'
    },
    codex: {
      method: 'item/tool/requestUserInput',
      params: {
        itemId: 'call_1',
        questions: [codexQuestion('colour', 'Which colour do you prefer?', COLOURS, false)],
        isBlocking: true,
        autoResolutionMs: null
      }
    },
    agy: {
      never:
        'Koloft reads every Antigravity question that has options as one that takes own words (agyQuestion, AGY§14)'
    },
    replies: ['1', 'Blue, please']
  },
  {
    file: 'several-questions',
    title: 'Asks two questions at once, each taking one pick',
    claude: {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: 'Which colour do you prefer?',
            header: 'Colour',
            options: COLOURS,
            multiSelect: false
          },
          { question: 'Which size?', header: 'Size', options: SIZES, multiSelect: false }
        ]
      }
    },
    codex: {
      method: 'item/tool/requestUserInput',
      params: {
        itemId: 'call_1',
        questions: [
          codexQuestion('colour', 'Which colour do you prefer?', COLOURS, true),
          codexQuestion('size', 'Which size?', SIZES, true)
        ],
        isBlocking: true,
        autoResolutionMs: null
      }
    },
    agy: {
      tool: {
        name: 'ask_question',
        args: {
          questions: [
            { question: 'Which colour do you prefer?', options: ['Red', 'Green'] },
            { question: 'Which size?', options: ['Small', 'Large'] }
          ]
        }
      },
      status: { kind: 'question', msg: 'Which colour do you prefer?' },
      api: waitingStep({
        askQuestion: {
          questions: [
            { question: 'Which colour do you prefer?', options: apiOptions(COLOURS) },
            { question: 'Which size?', options: apiOptions(SIZES) }
          ]
        }
      })
    },
    replies: ['1\n2', '1', 'Blue\nLarge']
  },
  {
    file: 'one-question-several-picks',
    title: 'Asks one question that takes several picks',
    claude: {
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: 'Which toppings?', header: 'Toppings', options: TOPPINGS, multiSelect: true }
        ]
      }
    },
    codex: {
      never: 'Codex asks no question that takes several picks (CODEX§20)'
    },
    agy: {
      tool: {
        name: 'ask_question',
        args: {
          questions: [
            {
              question: 'Which toppings?',
              options: ['Cheese', 'Ham', 'Olives'],
              is_multi_select: true
            }
          ]
        }
      },
      status: { kind: 'question', msg: 'Which toppings?' },
      api: waitingStep({
        askQuestion: {
          questions: [
            { question: 'Which toppings?', options: apiOptions(TOPPINGS), isMultiSelect: true }
          ]
        }
      })
    },
    replies: ['1, 3', 'Cheese', 'Anchovies']
  },
  {
    file: 'approve-a-plan',
    title: 'Asks to approve a plan',
    claude: { tool_name: 'ExitPlanMode', tool_input: { plan: PLAN } },
    codex: {
      never:
        'Codex never asks this through its app-server: “Implement this plan?” is a menu of its own screen (CODEX§19)'
    },
    agy: {
      status: { kind: 'permission', msg: 'Approve plan' },
      plan: PLAN,
      api: {
        trajectoryId: 't9',
        steps: [
          { userInput: { userConfig: { plannerConfig: { planModel: 'M36' } } } },
          { status: 'CORTEX_STEP_STATUS_DONE' }
        ]
      }
    },
    replies: ['yes', 'no', 'Add a step for the tests']
  },
  {
    file: 'run-a-command-with-reason',
    title: 'Wants to run a command, and gives a reason',
    claude: {
      tool_name: 'Bash',
      tool_input: { command: 'touch approved.txt', description: 'Write the probe file' }
    },
    codex: {
      method: 'item/commandExecution/requestApproval',
      params: {
        itemId: 'call_2',
        command: 'touch approved.txt',
        cwd: '/home/me/proj',
        reason: 'Write the probe file outside the sandbox'
      }
    },
    agy: { never: 'Antigravity gives no reason with a command (its 7501 msg table, AGY§8)' },
    replies: ['yes', 'no', 'maybe']
  },
  {
    file: 'run-a-command-no-reason',
    title: 'Wants to run a command, with no reason given',
    claude: { tool_name: 'Bash', tool_input: { command: 'npm test' } },
    codex: {
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'call_2', command: 'npm test', cwd: '/home/me/proj' }
    },
    agy: {
      tool: { name: 'run_command', args: { CommandLine: 'npm test' } },
      status: { kind: 'permission', msg: 'Approve RunCommand: npm test' },
      api: waitingStep({ permission: { resource: { action: 'command', target: 'npm test' } } })
    },
    replies: ['yes', 'no', 'maybe']
  },
  {
    file: 'edit-a-file',
    title: 'Wants to edit a file',
    claude: {
      tool_name: 'Edit',
      tool_input: { file_path: FILE, old_string: 'teh', new_string: 'the' }
    },
    codex: {
      before: [
        {
          method: 'item/started',
          params: {
            item: {
              id: 'patch',
              type: 'fileChange',
              status: 'inProgress',
              changes: [{ path: FILE, kind: { type: 'update' }, diff: '-teh\n+the\n' }]
            }
          }
        }
      ],
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'patch', reason: 'outside' }
    },
    agy: {
      tool: { name: 'write_to_file', args: { TargetFile: FILE } },
      status: { kind: 'permission', msg: `Approve WriteToFile: Write: ${FILE}` },
      api: waitingStep({ permission: { resource: { action: 'write_file', target: FILE } } })
    },
    replies: ['yes', 'no', 'maybe']
  },
  {
    file: 'read-a-file',
    title: 'Wants to read a file',
    claude: { tool_name: 'Read', tool_input: { file_path: OUTSIDE } },
    codex: { never: 'Codex never asks to read a file: Koloft never marks one of its asks a read' },
    agy: {
      tool: { name: 'read_file', args: { Path: OUTSIDE } },
      status: { kind: 'permission', msg: `Approve ReadFile: Read: ${OUTSIDE}` },
      api: waitingStep({ permission: { resource: { action: 'read_file', target: OUTSIDE } } })
    },
    replies: ['yes', 'no', 'maybe']
  },
  {
    file: 'use-another-tool-named',
    title: 'Wants to use another tool, and names it',
    claude: { tool_name: 'mcp__probe__ping', tool_input: { host: 'example.com' } },
    codex: {
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'probe',
        mode: 'form',
        _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
        message: 'Allow the probe MCP server to run tool "ping"?',
        requestedSchema: { type: 'object', properties: {} }
      }
    },
    agy: {
      tool: { name: 'schedule', args: { DurationSeconds: 1800, Prompt: 'Look again' } },
      status: { kind: 'permission', msg: 'Approve Schedule' }
    },
    replies: ['yes', 'no', 'maybe']
  },
  {
    file: 'use-another-tool-one-sentence',
    title: 'Wants approval, saying one sentence and naming no tool',
    claude: { never: NAMES_ITS_TOOL_ALWAYS },
    codex: {
      method: 'item/fileChange/requestApproval',
      params: { itemId: 'call_unseen', reason: 'Codex wants to write outside the workspace' }
    },
    agy: { status: { kind: 'permission', msg: 'Approve RunCommand' } },
    replies: ['yes', 'no', 'maybe']
  },
  {
    file: 'use-another-tool-nothing-said',
    title: 'Wants approval, and says nothing about what',
    claude: { never: NAMES_ITS_TOOL_ALWAYS },
    codex: { method: 'item/commandExecution/requestApproval', params: {} },
    agy: { status: { kind: 'permission' } },
    replies: ['yes', 'no', 'maybe']
  }
]

const SAMPLES_NOT_MEASURED: Record<string, string> = {
  'use-another-tool-one-sentence/codex':
    'a file change approval whose item Koloft never saw start (`item/fileChange/requestApproval` carrying only `reason`), the one way a Codex approval reaches Koloft with a sentence only; not seen from a real Codex',
  'use-another-tool-one-sentence/agy':
    'the 7501 msg with `AGY_CLI_OSC7501_MESSAGES=brief`, "Approve RunCommand" (AGY§8), with no tool call before it',
  'use-another-tool-nothing-said/codex':
    '`item/commandExecution/requestApproval` with no params, the sample of codexObservation.test.ts; other `…/requestApproval` kinds are not probed yet (CODEX§3)',
  'use-another-tool-nothing-said/agy':
    'a 7501 `blocked:kind=permission` with no msg and no tool call before it; not measured',
  'use-another-tool-named/agy':
    'the sample of agySessions.test.ts ("Approve Schedule" after a `schedule` tool call); the msg for this tool is not in the ledger',
  'use-another-tool-named/codex':
    'the MCP tool approval Codex measured (CODEX§20): an elicitation form with no fields'
}

let world: World
let surfaces: AskSurfaces
let stops: (() => unknown)[]
let server: http.Server
let trajectory: unknown
let apiAnswers = false
const apiCalls: { method: string; body: unknown }[] = []
const SERVICE = '/exa.language_server_pb.LanguageServerService/'

export function useAskTable(): void {
  beforeEach(() => {
    world = makeWorld()
    stops = []
  })

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop()
    await BackgroundFile.whenAllWritten()
    world.gone()
  })

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        if (!apiAnswers) {
          res.writeHead(503)
          return res.end('down')
        }
        const method = req.url!.slice(SERVICE.length)
        if (method === 'StreamAgentStateUpdates') return res.end()
        apiCalls.push({ method, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(method === 'GetCascadeTrajectory' ? JSON.stringify({ trajectory }) : '{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterAll(() => server.close())
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Raised {
  tab: string
  raw: string
  ids(): string
  reached(): Promise<string[]>
}

function surfacesFor(kind: Kind, sessionId: string): AskSurfaces {
  const s: AskSurfaces = new AskSurfaces(world, {
    backendOf: (t) => (t === s.liveTab ? BACKEND_OF[kind] : undefined),
    sessionIdOf: (t) => (t === s.liveTab ? sessionId : undefined)
  })
  if (noCardChannel) s.askChannel = undefined
  stops.push(() => s.close())
  return s
}

let noCardChannel = false

async function raiseClaude(kind: Kind, ask: ClaudeAsk): Promise<Raised> {
  const tab = 'claude-tab'
  surfaces = surfacesFor(kind, SID)
  surfaces.liveTab = tab
  surfaces.terminals.open(tab, 'claude')
  surfaces.terminals.takes = () => surfaces.runtime.recordTurn(tab, 'working')
  const backend = claudeBackendIn(world, surfaces.terminals, {
    machine: { run: async () => ({ code: 0, stdout: Buffer.from(''), stderr: '' }) },
    tracker: { infoOf: () => ({ sessionId: SID }) as never, list: () => [] },
    events: (tabId, event) => surfaces.backends.observe(tabId, event)
  })
  backend.watchLocalHooks(world.regDir)
  await sleep(A_FOLDER_WATCH_GOES_LIVE_WITHIN_MS)
  const script = writeHookScript(world)
  if (kind === 'claude-held') holdAsksOf(world, tab, true)
  const payload = { session_id: SID, ...ask }
  const hook = runAskHook(script, world, tab, payload)
  stops.push(() => hook.child.kill())
  await vi.waitFor(
    () =>
      expect(
        kind === 'claude-held' ? surfaces.asks.askOf(tab) : surfaces.wiring.claudeAskOf(tab)
      ).toBeDefined(),
    { timeout: A_REPLY_IS_SEEN_WITHIN_MS }
  )
  surfaces.runtime.recordTurn(tab, 'approval')
  let printed: string | undefined
  void hook.printed.then((out) => (printed = out))
  return {
    tab,
    raw: `PermissionRequest hook input: ${JSON.stringify({ hook_event_name: 'PermissionRequest', ...payload })}`,
    ids: () =>
      kind === 'claude-held'
        ? `the hook's own process id, only in the name of its file ${tab}.<pid>.ask.json; the "someone asked" moment is never announced for it`
        : surfaces.timeline.filter((l) => l.includes('(id ')).join('\n'),
    reached: async () => {
      if (kind !== 'claude-held') return surfaces.terminals.reached
      if (printed === undefined && !surfaces.asks.askOf(tab))
        await Promise.race([hook.printed, sleep(A_HOOK_SEES_ITS_ANSWER_WITHIN_MS)])
      return [
        ...surfaces.terminals.reached,
        ...(printed === undefined ? [] : [`the hook printed to Claude Code: ${printed}`])
      ]
    }
  }
}

async function raiseCodex(ask: CodexAsk): Promise<Raised> {
  codexWires.length = 0
  surfaces = surfacesFor('codex', THREAD)
  const sessions = codexSessionsIn(world, surfaces.terminals, {
    ranOnTheMachine: [],
    run: () => ({ code: 1, stdout: '', stderr: '' }),
    runtime: surfaces.runtime,
    events: (tabId, event) => sessions.observe(tabId, event)
  })
  stops.push(() => sessions.stopAll())
  const { id: tab } = await sessions.launch({ kind: 'codex', cwd: ON_THE_MACHINE })
  surfaces.liveTab = tab
  surfaces.stored.push(sessions)
  const wire = codexWires.at(-1)!
  const send = (direction: 'client' | 'server', frame: Record<string, unknown>): void => {
    const head = typeof frame.method === 'string' ? { method: frame.method } : { replyTo: frame.id }
    if (wire.observes(direction, head)) wire.onFrame(direction, frame)
  }
  send('client', { id: 1, method: 'thread/start', params: { cwd: '/home/me/proj' } })
  send('server', {
    id: 1,
    result: {
      thread: { id: THREAD, cwd: '/home/me/proj', status: { type: 'idle' }, source: 'cli' }
    }
  })
  await vi.waitFor(() => expect(sessions.list()[0]?.sessionId).toBeTruthy())
  send('server', { method: 'turn/started', params: { threadId: THREAD, turn: { id: 't1' } } })
  const frames = [
    ...(ask.before ?? []).map((b) => ({
      method: b.method,
      params: { threadId: THREAD, ...b.params }
    })),
    {
      id: CODEX_REQUEST_ID,
      method: ask.method,
      params: { threadId: THREAD, turnId: 't1', ...ask.params }
    }
  ]
  for (const frame of frames) send('server', frame)
  surfaces.terminals.takes = () => send('client', { id: CODEX_REQUEST_ID, result: {} })
  return {
    tab,
    raw: frames.map((f) => `app-server frame: ${JSON.stringify(f)}`).join('\n'),
    ids: () => {
      const open = sessions.openApproval(tab) ?? sessions.openQuestion(tab)
      return open
        ? `the app-server's request id: ${JSON.stringify(open.id)}`
        : 'none: Koloft holds no ask it can read'
    },
    reached: async () => surfaces.terminals.reached
  }
}

async function raiseAgy(kind: Kind, ask: AgyAsk): Promise<Raised> {
  apiAnswers = kind === 'agy-api'
  trajectory = ask.api
  apiCalls.length = 0
  surfaces = surfacesFor(kind, CONVERSATION)
  const bin = path.join(world.home, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, 'lsof'),
    `#!/bin/sh\nif [ "$1" = "-t" ]; then exit 0; fi\nexec /usr/sbin/lsof "$@"\n`,
    { mode: 0o755 }
  )
  const pathBefore = process.env.PATH
  process.env.PATH = `${bin}:${pathBefore}`
  stops.push(() => (process.env.PATH = pathBefore))
  const sessions = agySessionsIn(world, surfaces.terminals, {
    machine: { run: async () => ({ code: 0, stdout: Buffer.from(''), stderr: '' }) },
    runtime: surfaces.runtime
  })
  stops.push(() => sessions.stopAll())
  const { id: tab } = await sessions.launch({ kind: 'agy', cwd: world.repo })
  surfaces.liveTab = tab
  surfaces.stored.push(sessions)
  const accountHome = path.join(world.home, 'agy-homes', 'work')
  const tabEnv = (): NodeJS.ProcessEnv => {
    const c = surfaces.terminals.created.find((one) => one.id === tab)!
    return { ...c.processEnv, ...c.envSetForThisTab }
  }
  const say = (data: string): void => void surfaces.terminals.emit('data', { id: tab, data })
  const settings = JSON.parse(
    fs.readFileSync(path.join(accountHome, 'antigravity-cli', 'settings.json'), 'utf8')
  )
  execFileSync('/bin/sh', ['-c', settings.title.command], {
    input: JSON.stringify({ agent_state: 'idle', conversation_id: CONVERSATION }),
    env: tabEnv(),
    encoding: 'utf8'
  })
  say(agyState('idle'))
  await vi.waitFor(() => expect(sessions.list()[0]?.nativeSessionId).toBe(CONVERSATION))
  say(agyState('working'))
  if (ask.plan !== undefined) {
    const brain = path.join(world.home, '.gemini', 'antigravity-cli', 'brain', CONVERSATION)
    fs.mkdirSync(brain, { recursive: true })
    fs.writeFileSync(path.join(brain, 'plan.md'), ask.plan)
    fs.writeFileSync(
      path.join(brain, 'plan.md.metadata.json'),
      JSON.stringify({ requestFeedback: true, updatedAt: '1' })
    )
  }
  const raw: string[] = []
  if (ask.tool) {
    const hooks = JSON.parse(
      fs.readFileSync(path.join(accountHome, 'config', 'hooks.json'), 'utf8')
    ).koloft
    const [first] = hooks.PreToolUse
    const input = { conversationId: CONVERSATION, workspacePaths: [world.repo], toolCall: ask.tool }
    execFileSync('/bin/sh', ['-c', (first.hooks ?? [first])[0].command], {
      input: JSON.stringify(input),
      env: tabEnv(),
      encoding: 'utf8'
    })
    raw.push(`PreToolUse hook input: ${JSON.stringify(input)}`)
    const log = tabEnv().KOLOFT_AGY_LOG!
    const size = fs.statSync(log).size
    await vi.waitFor(() => expect(sessions['runs'].get(tab)?.log['offset']).toBe(size))
  }
  if (ask.plan !== undefined)
    raw.push(`brain/<conversation>/plan.md, waiting for review: ${JSON.stringify(ask.plan)}`)
  raw.push(
    `7501 status: state=blocked, kind=${ask.status.kind}, msg=${ask.status.msg === undefined ? '(none)' : JSON.stringify(ask.status.msg)}`
  )
  if (kind === 'agy-api' && ask.api !== undefined)
    raw.push(`its API's trajectory: ${JSON.stringify(ask.api)}`)
  const seen: string[] = []
  const note = (): void => {
    const id = sessions.openApproval(tab)?.id ?? sessions.openQuestion(tab)?.id
    if (id !== undefined && seen.at(-1) !== String(id)) seen.push(String(id))
  }
  const watching = setInterval(note, 2)
  stops.push(() => clearInterval(watching))
  say(blocked(ask.status.kind, ask.status.msg))
  note()
  if (kind === 'agy-api' && ask.api !== undefined)
    await vi.waitFor(() => expect(seen.at(-1)).not.toMatch(/^hook:/), {
      timeout: AN_AGENT_UNDER_LOAD_IS_READ_WITHIN_MS
    })
  else if (kind === 'agy-api' && ask.plan === undefined)
    await vi.waitFor(
      () => expect(apiCalls.some((c) => c.method === 'GetCascadeTrajectory')).toBe(true),
      { timeout: AN_AGENT_UNDER_LOAD_IS_READ_WITHIN_MS }
    )
  surfaces.terminals.takes = () => say(agyState('working'))
  return {
    tab,
    raw: raw.join('\n'),
    ids: () => `the ids it had, in turn: ${seen.join(' → ') || '(none)'}`,
    reached: async () => [
      ...surfaces.terminals.reached,
      ...apiCalls
        .filter((c) => c.method === 'HandleCascadeUserInteraction')
        .map((c) => `through its API: ${JSON.stringify(c.body)}`)
    ]
  }
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')
const blocked = (kind: string, msg?: string): string =>
  `${ESC}]7501;state=blocked:kind=${kind}${msg === undefined ? '' : `:msg=${b64(msg)}`}:app=antigravity${ESC}\\`
const agyState = (s: string): string => `${ESC}]7501;state=${s}:app=antigravity${ESC}\\`

async function freshWorld(): Promise<void> {
  for (const stop of stops.splice(0)) await stop()
  await BackgroundFile.whenAllWritten()
  world.gone()
  world = makeWorld()
}

function askOf(kind: Kind, s: Situation): ClaudeAsk | CodexAsk | AgyAsk | Never {
  if (kind === 'claude-held' || kind === 'claude-keys') return s.claude
  return kind === 'codex' ? s.codex : s.agy
}

async function raise(kind: Kind, s: Situation): Promise<Raised> {
  await freshWorld()
  const ask = askOf(kind, s)
  if (kind === 'claude-held' || kind === 'claude-keys') return raiseClaude(kind, ask as ClaudeAsk)
  if (kind === 'codex') return raiseCodex(ask as CodexAsk)
  return raiseAgy(kind, ask as AgyAsk)
}

const A_THROWAWAY_HOME = /\/[^"\s]*koloft-agent-tabs-[A-Za-z0-9]+/g

const sameOnEveryRun = (text: string): string =>
  text.replace(A_THROWAWAY_HOME, '<home>').replace(/hook:\d+/g, 'hook:<when it was read>')

const field = (label: string, value: string | undefined): string => {
  const text = value === undefined || value === '' ? '(nothing)' : value
  return text.includes('\n')
    ? `${label}:\n${text
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n')}`
    : `${label}: ${text}`
}

const OWNER_ASLEEP_LINE = new RegExp(
  `"${SESSION_TITLE}" (asked (?:the owner|to be allowed:) "[\\s\\S]*?"); Koloft`
)

async function settledDiscordCard(): Promise<void> {
  await vi
    .waitFor(() => expect(surfaces.cards.length).toBeGreaterThan(0), {
      timeout: A_REPLY_IS_SEEN_WITHIN_MS
    })
    .catch(() => undefined)
  await sleep(SETTLES_MS)
}

async function surfacesOf(kind: Kind, s: Situation): Promise<string> {
  const raised = await raise(kind, s)
  const { tab } = raised
  await settledDiscordCard()
  const card = surfaces.cards.at(-1)
  surfaces.markAsking(tab)
  await vi.waitFor(() => expect(surfaces.inboxCards().length).toBeGreaterThan(0), {
    timeout: A_REPLY_IS_SEEN_WITHIN_MS
  })
  if (surfaces.inboxCards()[0].title.includes('is waiting for you in its tab'))
    await sleep(A_FIRST_INBOX_CARD_IS_ASKED_AGAIN_AFTER_MS)
  const inbox = surfaces.inboxCards()[0]
  const quotes = inbox.blocks.flatMap((b) => (b.type === 'quote' ? [`${b.who}: ${b.text}`] : []))
  const choices = inbox.blocks.flatMap((b) =>
    b.type === 'choice'
      ? b.questions.map(
          (q) =>
            `“${q.text}”: options ${q.options.map((o) => o.label).join(' | ')}; several picks: ${q.multi ? 'yes' : 'no'}; own-words box: ${q.ownAnswer ? 'yes' : 'no'}`
        )
      : []
  )
  const texts = inbox.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : []))
  const report = await surfaces.ownerAsleepReport(tab)
  const shown = [
    field('the raw ask', raised.raw),
    field("the session row's small line", surfaces.wiring.askingOf(tab)),
    field('Discord card: body', card?.body),
    field('Discord card: footnote', card?.footer),
    field('Discord card: buttons', card?.buttons?.map((b) => b.label).join(' | ')),
    field('Inbox card: title', inbox.title),
    field('Inbox card: quote', quotes.join('\n')),
    field('Inbox card: questions', choices.join('\n')),
    field('Inbox card: text', texts.join('\n')),
    field('Inbox card: buttons', inbox.actions.map((a) => a.label).join(' | ')),
    field(
      "the butler's owner-asleep report, the part that says what was asked",
      report && (OWNER_ASLEEP_LINE.exec(report)?.[1] ?? `(not in the expected shape) ${report}`)
    ),
    field("this ask's id", raised.ids())
  ]
  if (card?.buttons?.length) shown.push(await pressFirstButton(raised, card))
  return shown.join('\n')
}

async function pressFirstButton(
  raised: Raised,
  card: NonNullable<AskSurfaces['cards'][number]>
): Promise<string> {
  const reachedBefore = (await raised.reached()).length
  const saidBefore = surfaces.said.length
  await surfaces.pressButton(card, 0)
  await vi
    .waitFor(
      () => expect(surfaces.edits.length + surfaces.said.length - saidBefore).toBeGreaterThan(0),
      {
        timeout: A_REPLY_IS_SEEN_WITHIN_MS
      }
    )
    .catch(() => undefined)
  await sleep(SETTLES_MS)
  const reached = (await raised.reached()).slice(reachedBefore)
  return [
    `--- pressed the Discord card's first button, ${JSON.stringify(card.buttons![0].label)} ---`,
    field('the card now says', surfaces.edits.at(-1)?.footer),
    field('Discord said', surfaces.said.slice(saidBefore).join('\n')),
    field('what reached the agent', reached.join('\n'))
  ].join('\n')
}

async function byDiscordMessage(
  raised: Raised,
  reply: string
): Promise<{ text: string; taken: boolean }> {
  const reachedBefore = (await raised.reached()).length
  const saidBefore = surfaces.said.length
  const handedBefore = surfaces.handedOver.length
  surfaces.message(reply)
  await vi
    .waitFor(
      () =>
        expect(
          surfaces.said.length - saidBefore + surfaces.handedOver.length - handedBefore
        ).toBeGreaterThan(0),
      { timeout: A_REPLY_IS_SEEN_WITHIN_MS }
    )
    .catch(() => undefined)
  await sleep(SETTLES_MS)
  const reached = (await raised.reached()).slice(reachedBefore)
  const said = surfaces.said.slice(saidBefore)
  const handed = surfaces.handedOver.slice(handedBefore)
  return {
    taken: reached.length > 0 || handed.length > 0,
    text: [
      `--- replied ${JSON.stringify(reply)} in the session's Discord room ---`,
      field('Discord said', said.join('\n')),
      field('handed to the session as a message', handed.join('\n')),
      field('what reached the agent', reached.join('\n'))
    ].join('\n')
  }
}

async function bySessionAnswer(raised: Raised, reply: string): Promise<string> {
  const reachedBefore = (await raised.reached()).length
  const refused = await surfaces.asks.answerSession(raised.tab, reply)
  const reached = (await raised.reached()).slice(reachedBefore)
  return [
    `--- answered ${JSON.stringify(reply)} with koloft session answer ---`,
    field('Koloft said', refused ?? '(taken, no refusal)'),
    field('what reached the agent', reached.join('\n'))
  ].join('\n')
}

async function answersOf(kind: Kind, s: Situation): Promise<string[]> {
  const parts: string[] = []
  for (const reply of s.replies) {
    let raised = await raise(kind, s)
    await settledDiscordCard()
    const discord = await byDiscordMessage(raised, reply)
    parts.push(discord.text)
    if (discord.taken) {
      raised = await raise(kind, s)
      await settledDiscordCard()
    }
    parts.push(await bySessionAnswer(raised, reply))
  }
  return parts
}

async function sectionOf(kind: Kind, s: Situation): Promise<string> {
  const head = `## ${SECTION_TITLE[kind]}`
  const ask = askOf(kind, s)
  if ('never' in ask) return `${head}\nnever asks this: ${ask.never}`
  const agent = kind.startsWith('claude') ? 'claude' : kind.startsWith('agy') ? 'agy' : 'codex'
  const sample = SAMPLES_NOT_MEASURED[`${s.file}/${agent}`]
  const parts = [head, ...(sample ? [field('the sample', sample)] : [])]
  parts.push(await surfacesOf(kind, s))
  parts.push(...(await answersOf(kind, s)))
  return sameOnEveryRun(parts.join('\n'))
}

const RUN_A_COMMAND = SITUATIONS.find((s) => s.file === 'run-a-command-no-reason')!

async function raiseWithoutACard(kind: Kind): Promise<Raised> {
  noCardChannel = true
  try {
    const raised = await raise(kind, RUN_A_COMMAND)
    await sleep(SETTLES_MS)
    return raised
  } finally {
    noCardChannel = false
    surfaces.askChannel = CHANNEL
  }
}

export async function pinSituation(file: string): Promise<void> {
  const s = SITUATIONS.find((one) => one.file === file)!
  const sections: string[] = [`# ${s.title}`]
  for (const kind of KINDS) sections.push(await sectionOf(kind, s))
  await expect(sections.join('\n\n') + '\n').toMatchFileSnapshot(`${PINNED}/${s.file}.txt`)
}

export const titleOf = (file: string): string => SITUATIONS.find((s) => s.file === file)!.title

export async function pinWhenACardIsPosted(): Promise<void> {
  const parts: string[] = ['# When the Discord card is posted, for one ask to run a command']
  for (const kind of KINDS) {
    await raise(kind, RUN_A_COMMAND)
    await settledDiscordCard()
    parts.push(sameOnEveryRun(`## ${SECTION_TITLE[kind]}\n${surfaces.timeline.join('\n')}`))
  }
  await expect(parts.join('\n\n') + '\n').toMatchFileSnapshot(`${PINNED}/when-a-card-is-posted.txt`)
}

export async function pinWhenAMessageAnswers(): Promise<void> {
  const parts: string[] = [
    '# When a Discord message counts as an answer, for one ask to run a command'
  ]
  for (const kind of KINDS) {
    parts.push(`## ${SECTION_TITLE[kind]}`)
    let raised = await raise(kind, RUN_A_COMMAND)
    await settledDiscordCard()
    parts.push(field('cards posted', String(surfaces.cards.length)))
    parts.push(sameOnEveryRun((await byDiscordMessage(raised, 'yes')).text))
    raised = await raiseWithoutACard(kind)
    parts.push(field('cards posted', String(surfaces.cards.length)))
    parts.push(sameOnEveryRun((await byDiscordMessage(raised, 'yes')).text))
  }
  await expect(parts.join('\n') + '\n').toMatchFileSnapshot(
    `${PINNED}/when-a-discord-message-answers.txt`
  )
}

const SEVERAL_PICKS = SITUATIONS.find((s) => s.file === 'one-question-several-picks')!
const ONE_QUESTION = SITUATIONS.find((s) => s.file === 'one-question-own-words')!
const SOMEONE_ELSE = 'someone-else'

async function answeredTwiceBeforeItTookTheFirst(kind: Kind, s: Situation): Promise<string> {
  const { tab } = await raise(kind, s)
  await settledDiscordCard()
  surfaces.terminals.takes = undefined
  const reply = s === SEVERAL_PICKS ? '1, 3' : 'yes'
  const first = surfaces.asks.answerSession(tab, reply)
  await sleep(SETTLES_MS)
  const second = await surfaces.asks.answerSession(tab, reply)
  const firstSaid = await first
  const lines = [
    field(`a second ${JSON.stringify(reply)} while the first goes in`, second ?? '(taken)'),
    field('the first, once the agent never took it', firstSaid ?? '(taken)')
  ]
  if (s === SEVERAL_PICKS) {
    await sleep(PAST_THE_WAIT_FOR_A_TAKEN_ANSWER_MS)
    lines.push(
      field(
        `${JSON.stringify(reply)} once more, after that`,
        (await surfaces.asks.answerSession(tab, reply)) ?? '(taken)'
      )
    )
  }
  return lines.join('\n')
}

async function refusalsOf(kind: Kind): Promise<string> {
  const lines: string[] = []
  lines.push(await answeredTwiceBeforeItTookTheFirst(kind, RUN_A_COMMAND))
  if (kind === 'claude-keys' || kind === 'agy-keys')
    lines.push(await answeredTwiceBeforeItTookTheFirst(kind, SEVERAL_PICKS))

  const { tab } = await raise(kind, RUN_A_COMMAND)
  await settledDiscordCard()
  const card = surfaces.cards.at(-1)!
  const saidBefore = surfaces.said.length
  await surfaces.pressButton(card, 0, SOMEONE_ELSE)
  lines.push(
    field('its card’s button, pressed by someone else', surfaces.said.slice(saidBefore).join('\n'))
  )
  lines.push(
    field('answered "yes" elsewhere', (await surfaces.asks.answerSession(tab, 'yes')) ?? '(taken)')
  )
  await sleep(SETTLES_MS)
  const saidAfter = surfaces.said.length
  await surfaces.pressButton(card, 1)
  lines.push(field('then its card’s button pressed', surfaces.said.slice(saidAfter).join('\n')))
  lines.push(
    field('then answered "yes" again', (await surfaces.asks.answerSession(tab, 'yes')) ?? '(taken)')
  )
  surfaces.runtime.recordTurn(tab, 'approval')
  lines.push(
    field(
      'its state back to waiting on the owner, with nothing Koloft can read, then "yes"',
      (await surfaces.asks.answerSession(tab, 'yes')) ?? '(taken)'
    )
  )

  const touched = kind === 'codex' ? ONE_QUESTION : SEVERAL_PICKS
  const raised = await raise(kind, touched)
  await settledDiscordCard()
  surfaces.ownerTouchedTheTerminal = true
  lines.push(
    field(
      `"${touched === ONE_QUESTION ? '1' : '1, 3'}" to ${touched.title.toLowerCase()}, after the owner pressed keys in its terminal`,
      (await surfaces.asks.answerSession(raised.tab, touched === ONE_QUESTION ? '1' : '1, 3')) ??
        '(taken)'
    )
  )
  return lines.join('\n')
}

export async function pinRefusals(): Promise<void> {
  const parts: string[] = [
    '# Refusals that no single situation above shows: an answer on its way, one never taken, an old card, someone else, nothing to answer, nothing readable, the owner already at the keys'
  ]
  for (const kind of KINDS)
    parts.push(sameOnEveryRun(`## ${SECTION_TITLE[kind]}\n${await refusalsOf(kind)}`))
  await expect(parts.join('\n\n') + '\n').toMatchFileSnapshot(`${PINNED}/refusals.txt`)
}
