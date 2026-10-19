import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { EventEmitter } from 'events'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgySessions, type AgyHomePick, type AgySessionDeps } from '../../src/main/agySessions'
import { agySessionKey } from '../../src/main/sessionStore'
import { agyTranscript, type SummaryRow } from '../../src/main/agyStore'
import type { AgyMachineLaunch, RemoteAgyConfig } from '../../src/main/remote/agyTab'
import { TAB_TMUX_NAME_SH } from '../../src/main/remote/launch'
import { SessionRuntime } from '../../src/main/sessionRuntime'
import { PROGRAM_STATUS_REPLY } from '../../src/main/programStatus'
import { AGY_CONDUCTOR_GATE_SCRIPT } from '../../src/main/conductorGate'
import type { SessionEvent } from '../../src/shared/sessionEvent'
import { appendConversation, ownerTyped, writeSummaries } from './helpers/agyStore'

const mocks = vi.hoisted(() => ({ runtime: vi.fn() }))
vi.mock('../../src/main/cliRuntime', () => ({ resolveCliRuntime: mocks.runtime }))

const A = '3f1c2b9e-0d4a-4c1e-9a7b-5e6f7a8b9c0d'
const B = '7a2d4e6f-1b3c-4d5e-8f9a-0b1c2d3e4f5a'
const CHILD = 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f'
const ESC = '\x1b'
const osc = (body: string): string => `${ESC}]7501;${body}${ESC}\\`
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')
const state = (s: string, extra = ''): string => osc(`state=${s}${extra}:app=antigravity`)
const SERVICE = '/exa.language_server_pb.LanguageServerService/'
const REAL_PATH = process.env.PATH
const REMOTE_WS = 'ssh://devbox/home/me/proj'

let home: string
let repo: string
let gemini: string
let sessions: AgySessions
let pty: EventEmitter & { write: ReturnType<typeof vi.fn> }
let runtime: SessionRuntime
let created: { id: string; argv: string[]; env: NodeJS.ProcessEnv }[]
let agentTools: boolean
let picked: AgyHomePick | undefined
let apiKey: string | undefined
let assist: { role: string; allow: string[] } | undefined
let machine: {
  launches: AgyMachineLaunch[]
  ended: string[]
  config: RemoteAgyConfig
  rows: unknown[]
  held: boolean
  alive: Set<string>
  attach: boolean
  tmuxThere: string | null
}
let mirror: string

let server: http.Server
let apiAnswers: boolean
let trajectory: unknown
let apiCalls: { method: string; body: unknown }[]

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
      apiCalls.push({ method, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(method === 'GetCascadeTrajectory' ? JSON.stringify({ trajectory }) : '{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(() => {
  server.close()
})

const events = (type: SessionEvent['type']): SessionEvent[] =>
  vi
    .mocked(sessions['deps'].events)
    .mock.calls.map(([, e]) => e)
    .filter((e) => e.type === type)

const tabEnv = (tabId: string): NodeJS.ProcessEnv => created.find((c) => c.id === tabId)!.env
const say = (tabId: string, data: string): void => {
  pty.emit('data', { id: tabId, data })
}
const sent = (method: string): unknown[] =>
  apiCalls.filter((c) => c.method === method).map((c) => c.body)

function hook(tabId: string, event: string, input: Record<string, unknown> = {}): string {
  const hooks = JSON.parse(
    fs.readFileSync(path.join(picked!.home, 'config', 'hooks.json'), 'utf8')
  ).koloft
  const [first] = hooks[event]
  const command: string = (first.hooks ?? [first])[0].command
  return execFileSync('/bin/sh', ['-c', command], {
    input: JSON.stringify({ conversationId: A, workspacePaths: [repo], ...input }),
    env: tabEnv(tabId),
    encoding: 'utf8'
  })
}

function title(tabId: string, input: Record<string, unknown>): void {
  const settings = JSON.parse(
    fs.readFileSync(path.join(picked!.home, 'antigravity-cli', 'settings.json'), 'utf8')
  )
  execFileSync('/bin/sh', ['-c', settings.title.command], {
    input: JSON.stringify({ agent_state: 'idle', ...input }),
    env: tabEnv(tabId),
    encoding: 'utf8'
  })
}

async function hooksTaken(tabId: string): Promise<void> {
  const log = tabEnv(tabId).KOLOFT_AGY_LOG!
  const size = fs.statSync(log).size
  await vi.waitFor(() => expect(sessions['runs'].get(tabId)?.log['offset']).toBe(size), {
    timeout: 2000
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sessions-')))
  repo = path.join(home, 'repo')
  fs.mkdirSync(repo)
  gemini = path.join(home, '.gemini')
  const tools = path.join(home, 'tools')
  fs.mkdirSync(tools)
  fs.writeFileSync(path.join(tools, 'playwright-cli'), '')
  fs.writeFileSync(path.join(tools, 'gh'), '')
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, 'lsof'),
    `#!/bin/sh\nif [ "$1" = "-t" ]; then cat '${path.join(home, 'lock-holders')}' 2>/dev/null; exit 0; fi\nexec /usr/sbin/lsof "$@"\n`,
    { mode: 0o755 }
  )
  process.env.PATH = `${bin}:${REAL_PATH}`
  mocks.runtime.mockResolvedValue({
    binary: '/fixture/agy',
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    version: '1.4.0',
    verified: true
  })
  created = []
  agentTools = false
  picked = { account: 'work', home: path.join(home, 'agy-homes', 'work') }
  apiKey = undefined
  assist = undefined
  apiAnswers = false
  trajectory = undefined
  apiCalls = []
  machine = {
    launches: [],
    ended: [],
    config: { ownersSettings: {}, ownersHooks: {}, ownSettings: {} },
    rows: [],
    held: false,
    alive: new Set(),
    attach: false,
    tmuxThere: null
  }
  mirror = path.join(home, 'mirror-hooks')
  fs.mkdirSync(mirror)
  const gateScript = path.join(home, 'agy-conductor-gate.js')
  fs.writeFileSync(gateScript, AGY_CONDUCTOR_GATE_SCRIPT)
  let tab = 0
  pty = Object.assign(new EventEmitter(), {
    nextId: vi.fn(() => `pty-${++tab}`),
    create: vi.fn((args: { id: string; argv: string[]; processEnv: NodeJS.ProcessEnv }) => {
      created.push({ id: args.id, argv: args.argv, env: args.processEnv })
      return { id: args.id, startedAt: Date.now() }
    }),
    pidOf: vi.fn(() => process.pid),
    write: vi.fn(),
    kill: vi.fn(),
    clearResumeIntent: vi.fn()
  })
  runtime = new SessionRuntime()
  const deps: AgySessionDeps = {
    pty: pty as unknown as AgySessionDeps['pty'],
    runtime,
    projectInfo: (p) => ({ root: p.startsWith('ssh://') ? REMOTE_WS : repo, treeRoot: p }),
    remoteDirExists: async () => true,
    changed: vi.fn(),
    events: vi.fn((tabId, event) => sessions.observe(tabId, event)),
    error: vi.fn(),
    openShimRoot: path.join(home, 'agy-open'),
    scriptsDir: path.join(home, 'scripts'),
    ownersGemini: () => gemini,
    pickHome: () => picked,
    apiKeyOf: async () => apiKey,
    playwrightBin: tools,
    browserEndpoint: () => '',
    builtInStatusLine: () => undefined,
    assistOf: () => assist,
    conductorGate: {
      script: gateScript,
      writeAllow: (tabId, allow) => {
        const file = path.join(home, `${tabId}.allow.json`)
        fs.writeFileSync(file, JSON.stringify(allow))
        return file
      }
    },
    agent: { enabled: () => agentTools, answer: vi.fn() },
    gitAccounts: { configEnv: (env) => env, ghWrapper: path.join(tools, 'gh') },
    remote: {
      machine: () => ({
        launchAgy: async (spec) => {
          machine.launches.push(spec)
          return {
            attach: machine.attach,
            tmuxName: spec.resumeId ? `k-${spec.resumeId}` : `m-${spec.tabId}-t`,
            spawnCwd: home,
            shell: '/bin/zsh',
            launchCommand: () => 'ssh devbox',
            resized: () => undefined
          }
        },
        readAgyConfig: async () => machine.config,
        agyHeldElsewhere: async () => machine.held,
        agyConversations: async () => machine.rows as SummaryRow[],
        endTmuxSession: async (name) => {
          machine.ended.push(name)
          return undefined
        },
        runScript: async (script) => (script === TAB_TMUX_NAME_SH ? machine.tmuxThere : null)
      }),
      hosts: () => ['devbox'],
      keyed: (host, p) => `ssh://${host}${p}`,
      mirrorDir: () => mirror,
      mirrorGemini: () => path.join(home, 'mirror-gemini'),
      gone: (_host, id) => !machine.alive.has(id),
      connected: () => true,
      nextPull: async () => undefined,
      setupLine: () => undefined,
      hookSettings: () => undefined,
      machineName: () => 'm-test'
    }
  }
  sessions = new AgySessions(path.join(home, 'agy-sessions.json'), deps)
})

afterEach(async () => {
  await sessions.stopAll()
  process.env.PATH = REAL_PATH
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 })
})

async function launch(
  extra: Partial<Parameters<AgySessions['launch']>[0]> = {}
): Promise<{ id: string }> {
  return sessions.launch({ kind: 'agy', cwd: repo, ...extra })
}

async function boundTab(): Promise<string> {
  const { id } = await launch()
  title(id, {
    conversation_id: A,
    model: { id: 'gemini-3.1-pro-low' },
    context_window: { used_percentage: 12 }
  })
  say(id, state('idle'))
  expect(sessions.list()[0]?.nativeSessionId).toBe(A)
  return id
}

function storedMember(id: string, permission?: 'bypass'): void {
  sessions.store.upsertMember({
    id,
    key: agySessionKey(id),
    workspacePath: repo,
    cwd: repo,
    title: 'Saved',
    createdAt: 1,
    updatedAt: 1,
    ...(permission ? { permission } : {})
  })
}

describe('AgySessions launch', () => {
  it("starts agy on the account's own folder with a token for its API, the model and effort it was given, and the first prompt typed in", async () => {
    await launch({ model: 'gemini-3.1-pro-high', effort: 'high', firstPrompt: 'hello' })
    expect(created[0].argv).toEqual([
      `--gemini_dir=${picked!.home}`,
      expect.stringMatching(/^--csrf_token=[0-9a-f]{48}$/),
      '--model',
      'gemini-3.1-pro-high',
      '--effort',
      'high',
      '-i',
      'hello'
    ])
  })

  it('asks before every action by default, "edit without asking" starts accept-edits mode, and a resume opens the stored conversation with the permission it had', async () => {
    await launch()
    await launch({ permission: 'acceptEdits' })
    storedMember(A, 'bypass')
    await sessions.resume({ sessionId: agySessionKey(A), cwd: repo })
    expect(created.map((c) => c.argv.slice(2))).toEqual([
      [],
      ['--mode', 'accept-edits'],
      ['--dangerously-skip-permissions', `--conversation=${A}`]
    ])
  })

  it("keeps the account's sign-in in its own folder instead of the shared macOS Keychain, and routes to its API key when it has one", async () => {
    await launch()
    expect(created[0].env.WSL_INTEROP).toBe('koloft')
    expect(created[0].env.GEMINI_API_KEY).toBeUndefined()
    apiKey = 'key-1'
    await launch()
    expect(created[1].env.GEMINI_API_KEY).toBe('key-1')
    const settings = path.join(picked!.home, 'antigravity-cli', 'settings.json')
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).modelProvider).toBe('gemini')
  })

  it('does not start without a usable account', async () => {
    picked = undefined
    await expect(launch()).rejects.toThrow(/No Antigravity account/)
    expect(created).toEqual([])
  })

  it("writes the folder into agy's own trust list only when Koloft was told to trust it", async () => {
    await launch()
    expect(sessions.trustsFolder(repo)).toBe(false)
    await launch({ trustFolder: true })
    expect(sessions.trustsFolder(repo)).toBe(true)
  })

  it("hands agy Koloft's instructions when a conversation starts only when agent tools are on", async () => {
    agentTools = true
    const on = await launch()
    agentTools = false
    const off = await launch()
    const told = JSON.parse(hook(on.id, 'SessionStart'))
    expect(told.injectSteps[0].systemMessage.systemMessage).toContain('koloft help')
    expect(hook(off.id, 'SessionStart')).toBe('')
  })

  // AGY§9 AGY§24
  it('refuses to resume a conversation another agy process holds open, and resumes one whose lock nobody holds', async () => {
    storedMember(A)
    const presence = path.join(gemini, 'antigravity-cli', 'presence')
    fs.mkdirSync(presence, { recursive: true })
    fs.writeFileSync(path.join(presence, `${A}.lock`), '')
    fs.writeFileSync(path.join(home, 'lock-holders'), '99998\n')
    await expect(sessions.resume({ sessionId: agySessionKey(A), cwd: repo })).rejects.toThrow(
      /open in another agy window/
    )
    expect(created).toEqual([])
    fs.writeFileSync(path.join(home, 'lock-holders'), '')
    await sessions.resume({ sessionId: agySessionKey(A), cwd: repo })
    expect(created[0].argv).toContain(`--conversation=${A}`)
  })
})

describe('Assist on Antigravity', () => {
  const verdict = (out: string): string | undefined => (out ? JSON.parse(out).decision : undefined)

  it('never stops to ask, trusts its folder, and is told its role instead of the session guide', async () => {
    agentTools = true
    assist = { role: 'You are the Assist of ws.', allow: [] }
    const { id } = await launch()
    expect(created[0].argv).toContain('--dangerously-skip-permissions')
    expect(sessions.trustsFolder(repo)).toBe(true)
    const told = JSON.parse(hook(id, 'SessionStart'))
    expect(told.injectSteps[0].systemMessage.systemMessage).toBe('You are the Assist of ws.')
  })

  // ADR-0029 AGY§12 AGY§13
  it('puts every tool call through the Assist gate with the tools its task allows: writing inside its folder passes, a subagent is stopped before it runs', async () => {
    assist = { role: 'r', allow: ['search_web'] }
    const { id } = await launch()
    const tool = (name: string, args: Record<string, unknown> = {}): string | undefined =>
      verdict(hook(id, 'PreToolUse', { toolCall: { name, args } }))
    expect(tool('run_command', { CommandLine: 'koloft session list' })).toBeUndefined()
    expect(tool('write_to_file', { TargetFile: path.join(repo, 'notes.md') })).toBeUndefined()
    expect(tool('search_web', { query: 'x' })).toBeUndefined()
    expect(tool('write_to_file', { TargetFile: '/etc/hosts' })).toBe('deny')
    expect(tool('invoke_subagent', { Subagents: [] })).toBe('deny')
  })

  it('a plain session runs no tool gate', async () => {
    const { id } = await launch()
    expect(tabEnv(id).KOLOFT_AGY_GATE).toBeUndefined()
    expect(hook(id, 'PreToolUse', { toolCall: { name: 'invoke_subagent', args: {} } })).toBe('')
  })
})

describe('AgySessions binding (AGY§9 AGY§10 AGY§11)', () => {
  it('answers the status question agy asks at start', async () => {
    const { id } = await launch()
    say(id, osc('?'))
    expect(pty.write).toHaveBeenCalledWith(id, PROGRAM_STATUS_REPLY)
  })

  it('binds the tab to the conversation agy names to its title script, and not to the empty id before the first prompt', async () => {
    const { id } = await launch()
    title(id, { conversation_id: '', agent_state: 'authenticating', model: null })
    say(id, state('idle'))
    expect(sessions.list()).toEqual([])
    title(id, { conversation_id: A })
    title(id, { conversation_id: A, agent_state: 'working' })
    say(id, state('working'))
    expect(sessions.list()[0]).toMatchObject({ sessionId: agySessionKey(A), nativeSessionId: A })
    expect(events('bound')).toHaveLength(1)
  })

  it('binds on its own from the title log, without waiting for a status frame', async () => {
    const { id } = await launch()
    title(id, { conversation_id: A })
    await vi.waitFor(() => expect(sessions.list()[0]?.nativeSessionId).toBe(A), { timeout: 3000 })
  })

  it('moves the tab to the new conversation after /clear and drops the old one', async () => {
    const id = await boundTab()
    title(id, { conversation_id: B })
    say(id, state('idle'))
    expect(sessions.list()[0].nativeSessionId).toBe(B)
    expect(sessions.store.getMember(agySessionKey(A))).toBeUndefined()
  })

  it('moves the tab to a stored conversation picked with /resume inside agy, and keeps the one it left', async () => {
    writeSummaries(gemini, [
      {
        conversation_id: B,
        title: 'Old work',
        workspace_uris: JSON.stringify([pathToFileURL(repo).href]),
        last_modified_time: '2026-10-15 08:00:00+00:00'
      }
    ])
    const id = await boundTab()
    await sessions.refreshHistory()
    title(id, { conversation_id: B })
    say(id, state('idle'))
    expect(sessions.list()[0]).toMatchObject({ nativeSessionId: B, title: 'Old work' })
    expect(sessions.store.getMember(agySessionKey(A))).toBeDefined()
  })

  it("does not let a subagent's hooks, which carry the subagent's own conversation id, count as the tab's work", async () => {
    const id = await boundTab()
    const child = path.join(repo, 'child.md')
    fs.writeFileSync(child, 'x\n')
    hook(id, 'PostToolUse', {
      conversationId: CHILD,
      toolCall: { name: 'write_to_file', args: { TargetFile: child } }
    })
    hook(id, 'Stop', { conversationId: CHILD, fullyIdle: false })
    await hooksTaken(id)
    const mine = path.join(repo, 'mine.md')
    fs.writeFileSync(mine, 'x\n')
    hook(id, 'PostToolUse', { toolCall: { name: 'write_to_file', args: { TargetFile: mine } } })
    await vi.waitFor(() => expect(sessions.list()[0].files).toHaveLength(1))
    expect(sessions.list()[0]).toMatchObject({ nativeSessionId: A, files: [{ src: mine }] })
    expect(sessions.list()[0].background).toBeUndefined()
  })
})

describe('AgySessions turns (AGY§8 AGY§10 AGY§12)', () => {
  it("turns agy's status frames into a turn starting, an approval or a question waiting, and the turn ending", async () => {
    const id = await boundTab()
    say(id, state('working'))
    expect(runtime.statusOf(id)).toBe('working')
    say(id, state('blocked', `:kind=permission:msg=${b64('Approve RunCommand: ls')}`))
    say(id, state('blocked', `:kind=question:msg=${b64('Which fruit?')}`))
    say(id, state('error', `:msg=${b64('Error 500')}`))
    const shown = vi
      .mocked(sessions['deps'].events)
      .mock.calls.map(([, e]) => e)
      .filter((e) => ['prompt', 'notify', 'stop'].includes(e.type))
    expect(shown).toEqual([
      { type: 'stop' },
      { type: 'prompt' },
      { type: 'notify', need: 'approval' },
      { type: 'notify', need: 'input' },
      { type: 'stop' }
    ])
  })

  it('names a new conversation with the title agy makes up for it in its list, without waiting for a /rename', async () => {
    const id = await boundTab()
    writeSummaries(gemini, [
      {
        conversation_id: A,
        title: 'Tidy the readme',
        workspace_uris: JSON.stringify([pathToFileURL(repo).href])
      }
    ])
    say(id, state('working'))
    say(id, state('done'))
    await vi.waitFor(() => expect(sessions.list()[0].title).toBe('Tidy the readme'))
    expect(sessions.rows(repo)[0].title).toBe('Tidy the readme')
  })

  it("hands on a finished turn's reply with the owner's own words, and its tokens and cost for the model agy reports", async () => {
    const id = await boundTab()
    appendConversation(gemini, A, [
      { type: 'USER_INPUT', content: ownerTyped('fix the docs') },
      {
        type: 'PLANNER_RESPONSE',
        content: 'Fixed.',
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 500
      }
    ])
    say(id, state('working') + state('done', `:msg=${b64('Fixed.')}`))
    await vi.waitFor(() => expect(events('usage')).toHaveLength(1))
    const [ended] = events('turn-ended') as Extract<SessionEvent, { type: 'turn-ended' }>[]
    expect(ended.turn.said.map((s) => s.text)).toEqual(['fix the docs'])
    expect(ended.turn.reply).toBe('Fixed.')
    const [{ usage }] = events('usage') as Extract<SessionEvent, { type: 'usage' }>[]
    expect(usage).toMatchObject({
      inTok: 1000,
      outTok: 200,
      cacheReadTok: 500,
      cacheWriteTok: 0,
      ctxPct: 0.12,
      model: 'gemini-3.1-pro-low'
    })
    expect(usage.costUsd).toBeCloseTo((1000 * 2 + 200 * 12 + 500 * 0.2) / 1e6, 10)
    const costFile = tabEnv(id).KOLOFT_AGY_COST!
    await vi.waitFor(() => expect(fs.readFileSync(costFile, 'utf8')).toBe(String(usage.costUsd)))
  })

  // ADR-0031 AGY§12
  it("quotes the owner's latest words to the model before each model call, so agy replies in their language", async () => {
    const id = await boundTab()
    appendConversation(gemini, A, [
      { type: 'USER_INPUT', content: ownerTyped('先别改代码，帮我查一下') }
    ])
    const out = hook(id, 'PreInvocation', { transcriptPath: agyTranscript(gemini, A) })
    expect(JSON.parse(out).injectSteps[0].ephemeralMessage).toContain('«先别改代码，帮我查一下»')
  })

  it('lists each file agy wrote or edited, with its added and removed lines, and not a file it only read', async () => {
    const id = await boundTab()
    const made = path.join(repo, 'new.md')
    hook(id, 'PostToolUse', { toolCall: { name: 'view_file', args: { AbsolutePath: made } } })
    hook(id, 'PostToolUse', {
      toolCall: {
        name: 'write_to_file',
        args: { TargetFile: made, CodeContent: JSON.stringify('a\nb\nc\n') }
      }
    })
    await vi.waitFor(() => expect(sessions.list()[0].files).toHaveLength(1))
    const edited = path.join(repo, 'old.md')
    appendConversation(gemini, A, [
      {
        type: 'GENERIC',
        content: `Edited file://${edited}\n[diff_block_start]\n@@ -1,2 +1,3 @@\n-x\n+y\n+z\n w\n[diff_block_end]`
      }
    ])
    hook(id, 'PostToolUse', {
      toolCall: { name: 'replace_file_content', args: { TargetFile: JSON.stringify(edited) } }
    })
    await vi.waitFor(() => expect(sessions.list()[0].files).toHaveLength(2))
    const files = Object.fromEntries(sessions.list()[0].files!.map((f) => [f.src, f]))
    expect(files[made]).toMatchObject({ access: 'wrote', added: 3 })
    expect(files[edited]).toMatchObject({ access: 'wrote', added: 2, removed: 1 })
    expect(sessions.list()[0]).toMatchObject({ lastWritten: edited, liveWrites: 2 })
  })

  it('shows work agy keeps doing after its turn, such as a subagent, until a Stop says it is fully idle', async () => {
    const id = await boundTab()
    hook(id, 'Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })
    await vi.waitFor(() => expect(sessions.list()[0].background).toHaveLength(1))
    expect(sessions.list()[0].background![0]).toMatchObject({ kind: 'agent', state: 'working' })
    hook(id, 'Stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL' })
    await vi.waitFor(() => expect(sessions.list()[0].background).toBeUndefined())
  })
})

describe('answering what agy asks (AGY§14 AGY§16 AGY§19)', () => {
  const waitingStep = (requestedInteraction: unknown): unknown => ({
    trajectoryId: 't9',
    steps: [
      { userInput: { userConfig: { plannerConfig: { planModel: 'M36' } } } },
      { status: 'CORTEX_STEP_STATUS_DONE' },
      { status: 'CORTEX_STEP_STATUS_WAITING', requestedInteraction }
    ]
  })

  it("presses the key agy's own dialog takes when its API does not answer: 1 runs a command, 4 declines it, 2 declines a file", async () => {
    const id = await boundTab()
    const ask = async (name: string, args: Record<string, unknown>, msg: string): Promise<void> => {
      hook(id, 'PreToolUse', { toolCall: { name, args } })
      await hooksTaken(id)
      say(id, state('blocked', `:kind=permission:msg=${b64(msg)}`))
    }
    await ask('run_command', { CommandLine: 'rm -rf build' }, 'Approve RunCommand: rm -rf build')
    expect(sessions.openApproval(id)).toMatchObject({ command: 'rm -rf build' })
    expect(await sessions.answer(id, 'maybe')).toBe('an Antigravity approval takes yes or no.')
    expect(await sessions.answer(id, 'no')).toBeUndefined()
    await ask('run_command', { CommandLine: 'ls' }, 'Approve RunCommand: ls')
    expect(await sessions.answer(id, 'yes')).toBeUndefined()
    const file = path.join(repo, 'a.md')
    await ask('write_to_file', { TargetFile: file }, `Approve WriteToFile: Write: ${file}`)
    expect(sessions.openApproval(id)).toMatchObject({ command: file })
    expect(await sessions.answer(id, 'no')).toBeUndefined()
    expect(pty.write.mock.calls).toEqual([
      [id, '4'],
      [id, '1'],
      [id, '2']
    ])
    expect(await sessions.answer(id, 'yes')).toBe(false)
  })

  it("answers an approval through agy's API when it answers, and presses no key", async () => {
    apiAnswers = true
    trajectory = waitingStep({
      permission: { resource: { action: 'command', target: 'npm test' } }
    })
    const id = await boundTab()
    say(id, state('blocked', `:kind=permission:msg=${b64('Approve RunCommand: npm test')}`))
    await vi.waitFor(() => expect(sessions.openApproval(id)?.id).toBe('t9:2'))
    expect(sessions.openApproval(id)).toMatchObject({ command: 'npm test' })
    await sessions.answer(id, 'yes')
    expect(sent('HandleCascadeUserInteraction')).toEqual([
      {
        cascadeId: A,
        interaction: { trajectoryId: 't9', stepIndex: 2, permission: { allow: true } }
      }
    ])
    expect(pty.write).not.toHaveBeenCalled()
  })

  it("answers a question with the picked option's id through the API", async () => {
    apiAnswers = true
    trajectory = waitingStep({
      askQuestion: {
        questions: [
          {
            question: 'Which fruit?',
            options: [
              { id: 'a', text: 'Apple' },
              { id: 'b', text: 'Banana' }
            ]
          }
        ]
      }
    })
    const id = await boundTab()
    say(id, state('blocked', `:kind=question:msg=${b64('Which fruit?')}`))
    await vi.waitFor(() => expect(sessions.openQuestion(id)?.id).toBe('t9:2'))
    expect(sessions.openQuestion(id)).toMatchObject({
      question: 'Which fruit?',
      options: [{ label: 'Apple' }, { label: 'Banana' }]
    })
    expect(await sessions.answer(id, 'banana')).toBeUndefined()
    expect(sent('HandleCascadeUserInteraction')).toEqual([
      {
        cascadeId: A,
        interaction: {
          trajectoryId: 't9',
          stepIndex: 2,
          askQuestion: { responses: [{ question: 'Which fruit?', selectedOptionIds: ['b'] }] }
        }
      }
    ])
    expect(pty.write).not.toHaveBeenCalled()
  })

  it("answers a question with the option's digit when the API does not answer, reading the options from the tool call", async () => {
    const id = await boundTab()
    hook(id, 'PreToolUse', {
      toolCall: {
        name: 'ask_question',
        args: { questions: [{ question: 'Which fruit?', options: ['Apple', 'Banana'] }] }
      }
    })
    await hooksTaken(id)
    say(id, state('blocked', `:kind=question:msg=${b64('Which fruit?')}`))
    expect(sessions.openQuestion(id)).toMatchObject({
      question: 'Which fruit?',
      options: [{ label: 'Apple' }, { label: 'Banana' }]
    })
    expect(await sessions.answer(id, 'Cherry')).toBe(
      'this Antigravity question takes the number or the name of one option.'
    )
    expect(await sessions.answer(id, '2')).toBeUndefined()
    expect(pty.write.mock.calls).toEqual([[id, '2']])
  })

  it('approves a plan waiting for review by sending agy "[Approved] <plan>" through its API, with the conversation\'s own settings', async () => {
    apiAnswers = true
    trajectory = waitingStep({})
    const brain = path.join(gemini, 'antigravity-cli', 'brain', A)
    fs.mkdirSync(brain, { recursive: true })
    fs.writeFileSync(
      path.join(brain, 'implementation_plan.md.metadata.json'),
      JSON.stringify({ summary: 'x', requestFeedback: true })
    )
    fs.writeFileSync(
      path.join(brain, 'notes.md.metadata.json'),
      JSON.stringify({ summary: 'y', userFacing: true })
    )
    const id = await boundTab()
    say(id, state('blocked', `:kind=permission:msg=${b64('Approve plan')}`))
    expect(sessions.openApproval(id)).toMatchObject({ command: 'implementation_plan.md' })
    expect(await sessions.answer(id, 'yes')).toBeUndefined()
    expect(sent('SendUserCascadeMessage')).toEqual([
      {
        cascadeId: A,
        items: [{ text: '[Approved] implementation_plan.md' }],
        cascadeConfig: { plannerConfig: { planModel: 'M36' } }
      }
    ])
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('rejects a plan by pasting "[Rejected] <plan>" into agy when its API does not answer', async () => {
    const brain = path.join(gemini, 'antigravity-cli', 'brain', A)
    fs.mkdirSync(brain, { recursive: true })
    fs.writeFileSync(
      path.join(brain, 'implementation_plan.md.metadata.json'),
      JSON.stringify({ requestFeedback: true })
    )
    const id = await boundTab()
    say(id, state('blocked', `:kind=permission:msg=${b64('Approve plan')}`))
    expect(sessions.openApproval(id)).toMatchObject({ command: 'implementation_plan.md' })
    await sessions.answer(id, 'no')
    expect(pty.write.mock.calls).toEqual([
      [id, '\x1b[200~[Rejected] implementation_plan.md\x1b[201~\r']
    ])
  })

  it("delivers a message Koloft sends to the tab through agy's API, and says so when it could not", async () => {
    apiAnswers = true
    trajectory = waitingStep({})
    const id = await boundTab()
    expect(await sessions.deliver(id, 'hi')).toBe(true)
    expect(sent('SendUserCascadeMessage')).toMatchObject([{ items: [{ text: 'hi' }] }])
    apiAnswers = false
    expect(await sessions.deliver(id, 'again')).toBe(false)
  })
})

describe('AgySessions search (AGY§8)', () => {
  it('finds a conversation by what the owner said or agy replied, not by tool output', async () => {
    writeSummaries(gemini, [
      { conversation_id: A, workspace_uris: JSON.stringify([pathToFileURL(repo).href]) }
    ])
    appendConversation(gemini, A, [
      { type: 'USER_INPUT', content: ownerTyped('first ask') },
      { type: 'GENERIC', content: 'zebra' },
      { type: 'PLANNER_RESPONSE', content: 'The lantern is lit.' }
    ])
    await sessions.availability()
    await sessions.refreshHistory()
    expect(await sessions.searchSnippets('LANTERN')).toEqual([
      { id: agySessionKey(A), snippet: 'The lantern is lit.' }
    ])
    expect(await sessions.searchSnippets('zebra')).toEqual([])
  })
})

describe('Antigravity in a remote workspace (AGY§4 AGY§11 AGY§12)', () => {
  const mirrored = (tabId: string, lines: unknown[]): void => {
    fs.appendFileSync(
      path.join(mirror, `${tabId}.agy.jsonl`),
      lines.map((l) => JSON.stringify(l) + '\n').join('')
    )
    sessions.followMirrors('devbox')
  }
  const remoteMember = (id: string): void => {
    sessions.store.upsertMember({
      id,
      key: agySessionKey(id, 'devbox'),
      workspacePath: REMOTE_WS,
      cwd: REMOTE_WS,
      title: 'Remote',
      createdAt: 1,
      updatedAt: 1
    })
  }
  const shown = (): SessionEvent[] =>
    vi
      .mocked(sessions['deps'].events)
      .mock.calls.map(([, e]) => e)
      .filter((e) => ['prompt', 'notify', 'stop'].includes(e.type))

  it("starts agy on that machine over ssh, on the account's own folder there with Koloft's title and hook scripts from its machine package, the owner's own settings and hooks kept, the API key in the tab's env, and the folder trusted when asked", async () => {
    apiKey = 'key-1'
    machine.config = {
      ownersSettings: { theme: 'dark', trustedWorkspaces: ['/elsewhere'] },
      ownersHooks: { mine: { Stop: [] } },
      ownSettings: {}
    }
    await sessions.launch({ kind: 'agy', cwd: REMOTE_WS, trustFolder: true, firstPrompt: 'hi' })
    const [spec] = machine.launches
    expect(created).toHaveLength(1)
    expect(spec.cwd).toBe(REMOTE_WS)
    expect(spec.env).toEqual({ ANT_ACCOUNT: 'work', KOLOFT_AGY_KEY: 'key-1' })
    const settings = JSON.parse(spec.program.files['pty-1.settings.json'])
    expect(settings).toMatchObject({
      theme: 'dark',
      modelProvider: 'gemini',
      title: { command: '/bin/sh "$HOME/.koloft/m-test/agy-title.sh"' }
    })
    expect(settings.trustedWorkspaces.sort()).toEqual(['/elsewhere', '/home/me/proj'])
    const hooks = JSON.parse(spec.program.files['pty-1.hooks.json'])
    expect(Object.keys(hooks).sort()).toEqual(['koloft', 'mine'])
    expect(JSON.stringify(hooks.koloft)).toContain('$HOME/.koloft/m-test/agy-hook.sh')
    expect(spec.program.files['pty-1.auth.json']).toBeUndefined()
    expect(spec.program.run).toContain(`--gemini_dir="$HOME/.koloft/agy"/'work'`)
    expect(spec.program.run).toMatch(/'-i' 'hi'\n$/)
  })

  it('shows its state from the log the machine mirrors back: the first hook binds the tab, a model call is working, an open ask waits for approval and is answered by keys, Stop ends the turn', async () => {
    const { id } = await sessions.launch({ kind: 'agy', cwd: REMOTE_WS })
    mirrored(id, [
      { event: 'SessionStart', input: { conversationId: A } },
      { event: 'PreInvocation', input: { conversationId: A } },
      {
        event: 'PreToolUse',
        input: { conversationId: A, toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }
      },
      { conversation_id: A, agent_state: 'tool_use', tool_confirmation_pending: true }
    ])
    expect(sessions.list()[0].nativeSessionId).toBe(A)
    await vi.waitFor(() => expect(sessions.openApproval(id)).toMatchObject({ command: 'ls' }))
    expect(await sessions.answer(id, 'yes')).toBeUndefined()
    expect(pty.write).toHaveBeenCalledWith(id, '1')
    mirrored(id, [
      { conversation_id: A, agent_state: 'working' },
      { event: 'Stop', input: { conversationId: A, fullyIdle: true } }
    ])
    expect(shown()).toEqual([
      { type: 'prompt' },
      { type: 'notify', need: 'approval' },
      { type: 'prompt' },
      { type: 'stop' }
    ])
  })

  it("closing the tab ends the machine's tmux session by the name agy's title script gave it, by the conversation's name before that, and by the tab's launch name before it binds; quitting Koloft leaves it running to attach to again", async () => {
    const first = await sessions.launch({ kind: 'agy', cwd: REMOTE_WS })
    machine.tmuxThere = `k-${B}`
    await sessions.stop(first.id)
    machine.tmuxThere = null
    const second = await sessions.launch({ kind: 'agy', cwd: REMOTE_WS })
    mirrored(second.id, [{ event: 'SessionStart', input: { conversationId: A } }])
    await sessions.stop(second.id)
    const third = await sessions.launch({ kind: 'agy', cwd: REMOTE_WS })
    await sessions.stop(third.id)
    expect(machine.ended).toEqual([`k-${B}`, `k-${A}`, `m-${third.id}-t`])
    await sessions.launch({ kind: 'agy', cwd: REMOTE_WS })
    await sessions.stopAll()
    expect(machine.ended).toHaveLength(3)
  })

  it('a tab whose tmux session left the machine closes once the machine still lacks it a moment later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const { id } = await sessions.launch({ kind: 'agy', cwd: REMOTE_WS })
      mirrored(id, [{ event: 'SessionStart', input: { conversationId: A } }])
      sessions.noticeRemoteExits('devbox', [A])
      await vi.runAllTimersAsync()
      expect(sessions.list()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('resuming a conversation tmux still runs there attaches to it: the tab binds at once and follows the log its agy writes, found through the pointer the title script left', async () => {
    machine.attach = true
    machine.alive.add(A)
    machine.held = true
    remoteMember(A)
    fs.writeFileSync(path.join(mirror, `k-${A}.agy-log`), 'pty-old.agy.jsonl')
    const old = path.join(mirror, 'pty-old.agy.jsonl')
    fs.writeFileSync(old, JSON.stringify({ event: 'Stop', input: { conversationId: A } }) + '\n')
    const { id } = await sessions.resume({
      sessionId: agySessionKey(A, 'devbox'),
      cwd: REMOTE_WS
    })
    await vi.waitFor(() => expect(sessions.list()[0]?.nativeSessionId).toBe(A))
    fs.appendFileSync(
      old,
      JSON.stringify({ event: 'PreInvocation', input: { conversationId: A } }) + '\n'
    )
    sessions.followMirrors('devbox')
    expect(runtime.statusOf(id)).toBe('working')
    expect(shown()).toEqual([{ type: 'prompt' }])
  })

  it('refuses to resume a conversation another agy on that machine holds', async () => {
    machine.held = true
    remoteMember(A)
    await expect(
      sessions.resume({ sessionId: agySessionKey(A, 'devbox'), cwd: REMOTE_WS })
    ).rejects.toThrow(/open in another agy window/)
    expect(machine.launches).toEqual([])
  })

  it("lists the conversations in the machine's own store under its remote workspace", async () => {
    machine.rows = [
      {
        conversation_id: B,
        title: 'Remote work',
        preview: '',
        workspace_uris: JSON.stringify(['file:///home/me/proj']),
        last_modified_time: '2026-10-16 08:00:00+00:00',
        step_count: 2,
        born: 1_700_000_000_000
      }
    ]
    await sessions.refreshHistory()
    expect(sessions.rows(REMOTE_WS)).toEqual([
      expect.objectContaining({
        id: agySessionKey(B, 'devbox'),
        title: 'Remote work',
        cwd: 'ssh://devbox/home/me/proj',
        invalidCwd: false,
        createdAt: 1_700_000_000_000
      })
    ])
    expect(sessions.rows(repo)).toEqual([])
  })
})
