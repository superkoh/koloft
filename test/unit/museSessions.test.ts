import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MuseSessions,
  museShowsItsInputBox,
  museTrustsFolder,
  trustMuseFolder,
  type MuseMachine,
  type MuseSessionDeps
} from '../../src/main/museSessions'
import { museSessionKey } from '../../src/main/sessionStore'
import { TAB_TMUX_NAME_SH } from '../../src/main/remote/launch'
import { SessionRuntime } from '../../src/main/sessionRuntime'
import { PROGRAM_STATUS_REPLY } from '../../src/main/programStatus'
import { MUSE_CONDUCTOR_GATE_SCRIPT } from '../../src/main/conductorGate'
import type { SessionEvent } from '../../src/shared/sessionEvent'

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  list: vi.fn(),
  read: vi.fn()
}))
vi.mock('../../src/main/cliRuntime', () => ({ resolveCliRuntime: mocks.runtime }))
vi.mock('../../src/main/museServe', () => ({
  listMuseSessions: mocks.list,
  readMuseTurns: mocks.read,
  readMuseAsk: async () => ({})
}))

const A = '01a13795-6b09-7531-bdd6-84ce54f976ea'
const B = '01a13796-77a9-7ee3-805e-e14ad0a7b22c'
const CHILD = '9cb2b3b7-f145-4411-bf47-ebd0341e75ff'
const ESC = '\x1b'
const osc = (body: string): string => `${ESC}]7501;${body}${ESC}\\`

let home: string
let repo: string
let sessions: MuseSessions
let pty: EventEmitter & { write: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
let runtime: SessionRuntime
let pids: Map<string, number>
let created: {
  id: string
  argv: string[]
  env: NodeJS.ProcessEnv
  extraEnv: Record<string, string>
}[]
let started: number
let agentTools: boolean
let endpoint: string
let picked: { account: string; env: Record<string, string> } | undefined
let assist: { role: string; allow: string[] } | undefined
let gateScript: string
let skipPermissions: boolean
let servers: Set<string>

const registryDir = (): string =>
  path.join(home, '.local', 'share', 'muse', 'runtime', 'muse', 'sessions')

function register(sessionId: string, pid: number, mtime?: Date): void {
  fs.mkdirSync(registryDir(), { recursive: true })
  const file = path.join(registryDir(), `${sessionId}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema_version: 1,
      session_id: sessionId,
      endpoint_hint: 'ms-1.sock',
      process_generation_hint: `pid=${pid}`
    })
  )
  if (mtime) fs.utimesSync(file, mtime, mtime)
}

function unregister(sessionId: string): void {
  fs.rmSync(path.join(registryDir(), `${sessionId}.json`), { force: true })
}

const say = (tabId: string, data: string): void => {
  pty.emit('data', { id: tabId, data })
}

function hook(tabId: string, event: string, input: Record<string, unknown>): string {
  const tab = created.find((c) => c.id === tabId)!
  const hooks = JSON.parse(fs.readFileSync(tab.env.TBH_MANAGED_HOOKS_PATH!, 'utf8')).hooks
  const command: string = hooks[event][0].hooks[0].command
  return execFileSync('/bin/sh', ['-c', command], {
    input: JSON.stringify({ hook_event_name: event, cwd: repo, ...input }),
    encoding: 'utf8'
  })
}

const context = (out: string): string =>
  JSON.parse(out).hookSpecificOutput.additionalContext as string

function logRecord(sessionId: string, record: Record<string, unknown>): void {
  const at = new Date(parseInt(sessionId.replace(/-/g, '').slice(0, 12), 16))
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const dir = path.join(
    home,
    '.local',
    'share',
    'muse',
    'sessions',
    String(at.getFullYear()),
    p2(at.getMonth() + 1),
    p2(at.getDate()),
    sessionId
  )
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'session.jsonl'), JSON.stringify(record) + '\n')
}

const events = (type: SessionEvent['type']): SessionEvent[] =>
  vi
    .mocked(sessions['deps'].events)
    .mock.calls.map(([, e]) => e)
    .filter((e) => e.type === type)

beforeEach(() => {
  vi.clearAllMocks()
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-sessions-')))
  repo = path.join(home, 'repo')
  fs.mkdirSync(repo)
  const tools = path.join(home, 'tools')
  fs.mkdirSync(tools)
  fs.writeFileSync(path.join(tools, 'playwright-cli'), '')
  fs.writeFileSync(path.join(tools, 'gh'), '')
  mocks.runtime.mockResolvedValue({
    binary: '/fixture/muse',
    env: { HOME: home, PATH: '/usr/bin' },
    version: '1.4.7',
    verified: true
  })
  mocks.list.mockResolvedValue([])
  mocks.read.mockResolvedValue([])
  pids = new Map()
  created = []
  started = Date.now()
  agentTools = false
  endpoint = ''
  picked = { account: 'work', env: { TBH_CREDENTIAL_BACKEND: 'file' } }
  assist = undefined
  skipPermissions = false
  servers = new Set()
  gateScript = path.join(home, 'muse-conductor-gate.js')
  fs.writeFileSync(gateScript, MUSE_CONDUCTOR_GATE_SCRIPT)
  let tab = 0
  pty = Object.assign(new EventEmitter(), {
    nextId: vi.fn(() => `pty-${++tab}`),
    create: vi.fn(
      (args: {
        id: string
        argv: string[]
        processEnv: NodeJS.ProcessEnv
        extraEnv: Record<string, string>
      }) => {
        pids.set(args.id, 4000 + tab)
        created.push({
          id: args.id,
          argv: args.argv,
          env: args.processEnv,
          extraEnv: args.extraEnv
        })
        return { id: args.id, startedAt: started }
      }
    ),
    pidOf: vi.fn((id: string) => pids.get(id)),
    write: vi.fn(),
    kill: vi.fn(),
    clearResumeIntent: vi.fn()
  })
  runtime = new SessionRuntime()
  const deps: MuseSessionDeps = {
    pty: pty as unknown as MuseSessionDeps['pty'],
    runtime,
    projectInfo: (p) => ({ root: repo, treeRoot: p }),
    changed: vi.fn(),
    events: vi.fn((tabId, event) => sessions.observe(tabId, event)),
    error: vi.fn(),
    openShimRoot: path.join(home, 'muse-open'),
    pickHome: () => picked,
    playwrightBin: tools,
    browserEndpoint: () => endpoint,
    assistOf: () => assist,
    conductorGate: {
      script: gateScript,
      writeAllow: (tabId, allow) => {
        const file = path.join(home, `${tabId}.allow.json`)
        fs.writeFileSync(file, JSON.stringify(allow))
        return file
      }
    },
    skipPermissions: () => skipPermissions,
    serversAmong: async () => servers,
    agent: { enabled: () => agentTools, answer: vi.fn() },
    gitAccounts: {
      configEnv: (env) => env,
      ghWrapper: path.join(tools, 'gh')
    }
  }
  sessions = new MuseSessions(path.join(home, 'muse-sessions.json'), deps)
})

afterEach(async () => {
  await sessions.stopAll()
  fs.rmSync(home, { recursive: true, force: true })
})

async function launch(
  extra: Partial<Parameters<MuseSessions['launch']>[0]> = {}
): Promise<{ id: string }> {
  return sessions.launch({ kind: 'muse', cwd: repo, ...extra })
}

async function boundTab(): Promise<string> {
  const { id } = await launch()
  hook(id, 'SessionStart', { session_id: A, source: 'startup' })
  await vi.waitFor(() => expect(sessions.list()[0]?.nativeSessionId).toBe(A))
  return id
}

describe('MuseSessions launch', () => {
  it('starts muse with the model and thinking level it was given, "never ask" as the unrestricted profile, and passes them again with resume', async () => {
    await launch({ model: 'm1', effort: 'high', permission: 'bypass', firstPrompt: 'hello' })
    expect(created[0].argv).toEqual([
      '--model',
      'm1',
      '--reasoning-effort',
      'high',
      '--permission-profile',
      ':unrestricted',
      'hello'
    ])
    sessions.store.upsertMember({
      id: A,
      key: museSessionKey(A),
      workspacePath: repo,
      cwd: repo,
      title: 'Saved',
      createdAt: 1,
      updatedAt: 1,
      permission: 'bypass'
    })
    await sessions.resume({ sessionId: museSessionKey(A), cwd: repo })
    expect(created[1].argv).toEqual(['--permission-profile', ':unrestricted', 'resume', A])
  })

  it('asks the owner instead of an AI reviewer by default, with the sandbox network open so a dev server can listen on a port, and "edit without asking" launches the same, since Muse never asks about edits', async () => {
    await launch()
    await launch({ permission: 'acceptEdits' })
    expect(created[0].argv).toEqual(['--approval-judge', 'off', '--sandbox-network', 'enabled'])
    expect(created[1].argv).toEqual(['--approval-judge', 'off', '--sandbox-network', 'enabled'])
  })

  it('starts unrestricted when "Skip permission prompts" is on in Accounts, but never over a permission picked for this launch, and a session started that way asks again on resume once the setting is off', async () => {
    skipPermissions = true
    const id = await boundTab()
    await launch({ permission: 'acceptEdits' })
    expect(created[0].argv).toEqual(['--permission-profile', ':unrestricted'])
    expect(created[1].argv).toEqual(['--approval-judge', 'off', '--sandbox-network', 'enabled'])
    expect(sessions.launchedBypassingChecks(id)).toBe(true)
    await sessions.stop(id)
    skipPermissions = false
    await sessions.resume({ sessionId: museSessionKey(A), cwd: repo })
    expect(created[2].argv).toEqual([
      '--approval-judge',
      'off',
      '--sandbox-network',
      'enabled',
      'resume',
      A
    ])
  })

  it('hands the Workbench browser to a tab that can drive it', async () => {
    endpoint = 'ws://127.0.0.1:9/cdp/x'
    await launch()
    expect(created[0].argv).toEqual(['--approval-judge', 'off', '--sandbox-network', 'enabled'])
    expect(created[0].env).toMatchObject({ KOLOFT_BROWSER_CDP: endpoint })
    expect(created[0].env.PWTEST_DAEMON_SESSION_DIR).toMatch(/^\/tmp\//)
  })

  it("writes the folder into muse's own trust list when Koloft was told to trust it", async () => {
    await launch({ trustFolder: true })
    expect(museTrustsFolder({ HOME: home }, repo)).toBe(true)
  })

  it('runs on the account Koloft picked, and does not start at all when there is none', async () => {
    await launch()
    expect(created[0].env.TBH_CREDENTIAL_BACKEND).toBe('file')
    picked = undefined
    await expect(launch()).rejects.toThrow(/No Muse account/)
  })

  it("puts the tab's own open, gh and playwright-cli commands first on muse's PATH", async () => {
    await launch()
    const first = created[0].env.PATH!.split(':')[0]
    for (const tool of ['open', 'gh', 'playwright-cli'])
      expect(fs.existsSync(path.join(first, tool))).toBe(true)
  })

  it("hands muse Koloft's instructions at every session start only when agent tools are on", async () => {
    agentTools = true
    const on = await launch()
    agentTools = false
    const off = await launch()
    const told = JSON.parse(hook(on.id, 'SessionStart', { session_id: A, source: 'clear' }))
    expect(told.hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart' })
    expect(told.hookSpecificOutput.additionalContext).toContain('koloft help')
    expect(hook(off.id, 'SessionStart', { session_id: B, source: 'startup' })).toBe('')
    const first = created[0].env.PATH!.split(':')[0]
    expect(fs.existsSync(path.join(first, 'koloft'))).toBe(true)
  })

  // ADR-0031
  it("reminds muse at each prompt and after every tool to write in the language of the owner's latest message, keeping it through a reply too short to show one", async () => {
    const id = await boundTab()
    expect(hook(id, 'PostToolUse', { session_id: A, tool_name: 'read_file' })).toBe('')
    const atPrompt = hook(id, 'UserPromptSubmit', {
      session_id: A,
      prompt: '现在在做什么',
      turn_id: 't1'
    })
    expect(context(atPrompt)).toContain('The user writes Chinese')
    const afterTool = hook(id, 'PostToolUse', { session_id: A, tool_name: 'read_file' })
    expect(JSON.parse(afterTool).hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(context(afterTool)).toContain('The user writes Chinese')
    hook(id, 'UserPromptSubmit', { session_id: A, prompt: 'ok', turn_id: 't2' })
    expect(context(hook(id, 'PostToolUse', { session_id: A, tool_name: 'bash' }))).toContain(
      'The user writes Chinese'
    )
    hook(id, 'UserPromptSubmit', { session_id: A, prompt: 'merge it now', turn_id: 't3' })
    expect(context(hook(id, 'PostToolUse', { session_id: A, tool_name: 'bash' }))).toContain(
      '«merge it now»'
    )
  })

  // ADR-0031
  it('a Muse child is reminded in the language of the owner’s words its parent handed over, not of its English task, until the owner writes to it', async () => {
    const { id } = await launch({
      firstPrompt: 'Koloft started you because … Fix the sidebar.',
      ownerWords: '把侧栏修好'
    })
    hook(id, 'SessionStart', { session_id: A, source: 'startup' })
    const first = hook(id, 'UserPromptSubmit', {
      session_id: A,
      prompt: 'Koloft started you because … Fix the sidebar.',
      turn_id: 't1'
    })
    expect(context(first)).toContain('The user writes Chinese')
    hook(id, 'UserPromptSubmit', { session_id: A, prompt: 'now check the tests', turn_id: 't2' })
    expect(context(hook(id, 'PostToolUse', { session_id: A, tool_name: 'bash' }))).toContain(
      '«now check the tests»'
    )
  })
})

describe('a Muse session open in another process', () => {
  it('counts as running elsewhere while the process named in its registry file is alive and not one of Koloft’s tabs, and not once that process is gone', async () => {
    await sessions.availability()
    register(A, process.pid)
    expect(sessions.runningElsewhere(museSessionKey(A))).toBe(true)
    register(B, 2 ** 22 + 1)
    expect(sessions.runningElsewhere(museSessionKey(B))).toBe(false)
  })
})

describe('Assist on Muse', () => {
  const decision = (out: string): string | undefined =>
    out ? JSON.parse(out).hookSpecificOutput.permissionDecision : undefined

  it('never stops to ask, trusts its folder, and is told its role instead of the session guide', async () => {
    agentTools = true
    endpoint = 'ws://127.0.0.1:9/cdp/x'
    assist = { role: 'You are the Assist of ws.', allow: [] }
    const { id } = await launch()
    expect(created[0].argv).toEqual(['--approval-mode', 'never', '--sandbox-network', 'enabled'])
    expect(created[0].env.KOLOFT_BROWSER_CDP).toBeUndefined()
    expect(museTrustsFolder({ HOME: home }, repo)).toBe(true)
    const told = JSON.parse(hook(id, 'SessionStart', { session_id: A, source: 'startup' }))
    expect(told.hookSpecificOutput.additionalContext).toBe('You are the Assist of ws.')
  })

  it('an Assist task allowed the browser gets the Workbench browser', async () => {
    endpoint = 'ws://127.0.0.1:9/cdp/x'
    assist = { role: 'r', allow: ['Bash(playwright-cli *)'] }
    await launch()
    expect(created[0].argv).toEqual(['--approval-mode', 'never', '--sandbox-network', 'enabled'])
    expect(created[0].env.KOLOFT_BROWSER_CDP).toBe(endpoint)
  })

  // ADR-0029 MUSE§9
  it('may read, write only inside its own folder and run one plain koloft command or one its task names per bash call, like a Claude Assist, never answered with an allow muse refuses; every other muse tool is stopped before it runs', async () => {
    assist = { role: 'r', allow: ['Bash(playwright-cli click)'] }
    const { id } = await launch()
    const tool = (
      tool_name: string,
      tool_input: Record<string, unknown> = {}
    ): string | undefined =>
      decision(hook(id, 'PreToolUse', { session_id: A, tool_name, tool_input }))
    expect(tool('bash', { command: 'koloft session list' })).toBeUndefined()
    expect(tool('bash', { command: 'playwright-cli click e5' })).toBeUndefined()
    expect(tool('bash', { command: 'playwright-cli eval x' })).toBe('deny')
    expect(tool('bash', { command: 'rm -rf ../workspace' })).toBe('deny')
    expect(tool('bash', { command: 'koloft session list; rm -rf ..' })).toBe('deny')
    expect(tool('read_file', { path: '/etc/hosts' })).toBeUndefined()
    expect(tool('read_skill', { name: 'koloft' })).toBeUndefined()
    expect(tool('write_file', { path: 'notes.md', content: 'x' })).toBeUndefined()
    expect(tool('edit_file', { path: path.join(repo, 'a', 'b.md') })).toBeUndefined()
    expect(tool('write_file', { path: '../outside.md', content: 'x' })).toBe('deny')
    expect(tool('edit_file', { path: '/etc/hosts' })).toBe('deny')
    for (const other of ['subagent_spawn', 'web_fetch', 'add_memory', 'cron_create'])
      expect(tool(other)).toBe('deny')
  })

  it('a plain session gets no tool gate', async () => {
    await launch()
    const hooks = JSON.parse(fs.readFileSync(created[0].env.TBH_MANAGED_HOOKS_PATH!, 'utf8')).hooks
    expect(hooks.PreToolUse).toBeUndefined()
  })
})

describe('MuseSessions status and binding', () => {
  it('answers the status question, then binds the tab to the session muse registers under its pid', async () => {
    const { id } = await launch()
    say(id, osc('?'))
    expect(pty.write).toHaveBeenCalledWith(id, PROGRAM_STATUS_REPLY)
    register(A, pids.get(id)!)
    say(id, osc('state=idle:app=muse'))
    expect(sessions.list()[0]).toMatchObject({ sessionId: museSessionKey(A), nativeSessionId: A })
    say(id, osc('state=working:app=muse'))
    expect(runtime.statusOf(id)).toBe('working')
  })

  it('applies a state seen before the registry file landed once the tab binds', async () => {
    const { id } = await launch()
    say(id, osc('state=working:app=muse'))
    expect(sessions.list()).toEqual([])
    register(A, pids.get(id)!)
    say(id, 'plain output')
    say(id, osc('state=working:app=muse'))
    expect(runtime.statusOf(id)).toBe('working')
  })

  it('binds once however often the same registry file is read', async () => {
    const { id } = await launch()
    register(A, pids.get(id)!)
    say(id, osc('state=idle:app=muse'))
    say(id, osc('state=working:app=muse'))
    say(id, osc('state=done:app=muse'))
    expect(events('bound')).toHaveLength(1)
  })

  it('ignores a registry file an earlier process left under a pid this tab now has', async () => {
    const { id } = await launch()
    register(A, pids.get(id)!, new Date(started - 60_000))
    say(id, osc('state=idle:app=muse'))
    expect(sessions.list()).toEqual([])
  })

  it('moves the tab to the new session after /clear and drops the old one', async () => {
    const { id } = await launch()
    register(A, pids.get(id)!)
    say(id, osc('state=idle:app=muse'))
    unregister(A)
    register(B, pids.get(id)!)
    say(id, osc('state=clear') + osc('state=idle:app=muse'))
    expect(sessions.list()[0].sessionId).toBe(museSessionKey(B))
    expect(sessions.store.getMember(museSessionKey(A))).toBeUndefined()
  })

  it('lists a session it just bound, before muse lists it, as active now', async () => {
    await boundTab()
    const [row] = sessions.rows(repo)
    expect(Date.now() - row.mtime).toBeLessThan(60_000)
  })

  it("never creates muse's registry folder", async () => {
    const { id } = await launch()
    say(id, osc('state=idle:app=muse'))
    expect(fs.existsSync(registryDir())).toBe(false)
  })

  it('binds from the session-start hook even when muse never writes its registry file, and follows /clear the same way', async () => {
    const id = await boundTab()
    hook(id, 'SessionStart', { session_id: B, source: 'clear' })
    await vi.waitFor(() => expect(sessions.list()[0]?.nativeSessionId).toBe(B))
    expect(sessions.store.getMember(museSessionKey(A))).toBeUndefined()
  })

  it('replays working then done that came before the bind, so a job sees its first turn end', async () => {
    const { id } = await launch()
    say(id, osc('state=working:app=muse') + osc('state=done:app=muse'))
    const statuses: (string | undefined)[] = []
    runtime.on('status', ({ next }: { next: string }) => statuses.push(next))
    register(A, pids.get(id)!)
    say(id, 'more output')
    await vi.waitFor(() => expect(statuses).toEqual(['working', 'waiting']))
  })

  it('does not take its own answer echoed back by the terminal for a new question', async () => {
    const { id } = await launch()
    say(id, PROGRAM_STATUS_REPLY)
    expect(pty.write).not.toHaveBeenCalled()
  })
})

describe('MuseSessions turns from hooks', () => {
  it('hands on the reply of a finished turn with the words that started it, once per turn, and names a new session after them', async () => {
    const id = await boundTab()
    hook(id, 'UserPromptSubmit', { session_id: A, prompt: 'fix the docs', turn_id: 't1' })
    await vi.waitFor(() => expect(sessions.list()[0].title).toBe('fix the docs'))
    hook(id, 'Stop', { session_id: A, last_assistant_message: 'Fixed.', turn_id: 't1' })
    hook(id, 'Stop', { session_id: A, last_assistant_message: 'Fixed.', turn_id: 't1' })
    await vi.waitFor(() => expect(events('turn-ended')).toHaveLength(1))
    const [ended] = events('turn-ended') as Extract<SessionEvent, { type: 'turn-ended' }>[]
    expect(ended.turn.reply).toBe('Fixed.')
    expect(ended.turn.said.map((s) => s.text)).toEqual(['fix the docs'])
  })

  // MUSE§9
  it('hands on the reply of a turn muse answers by itself without a Stop hook, like a bare first "hello", from the session log, and only once when Stop does come', async () => {
    const id = await boundTab()
    const run = (turnId: string, event: Record<string, unknown>): Record<string, unknown> => ({
      payload_type: 'runtime.session',
      payload: { kind: 'run', run_id: turnId, event }
    })
    hook(id, 'UserPromptSubmit', { session_id: A, prompt: 'hello', turn_id: 't1' })
    await vi.waitFor(() => expect(sessions.list()[0].title).toBe('hello'))
    logRecord(A, run('t1', { kind: 'assistant_message_committed', text: 'Hi! How can I help?' }))
    logRecord(A, run('t1', { kind: 'terminal', terminal: 'completed' }))
    say(id, osc('?') + osc('state=done:app=muse'))
    await vi.waitFor(() => expect(events('turn-ended')).toHaveLength(1))
    expect(events('turn-ended')[0]).toMatchObject({
      turn: { reply: 'Hi! How can I help?', said: [{ who: 'owner', text: 'hello' }] }
    })
    hook(id, 'UserPromptSubmit', { session_id: A, prompt: 'fix it', turn_id: 't2' })
    logRecord(A, run('t2', { kind: 'assistant_message_committed', text: 'Fixed.' }))
    logRecord(A, run('t2', { kind: 'terminal', terminal: 'completed' }))
    hook(id, 'Stop', { session_id: A, last_assistant_message: 'Fixed.', turn_id: 't2' })
    say(id, osc('state=done:app=muse'))
    await vi.waitFor(() => expect(events('turn-ended')).toHaveLength(2))
    await new Promise((r) => setTimeout(r, 300))
    expect(events('turn-ended')).toHaveLength(2)
  })

  it("ignores what a subagent or muse's own reminder helpers say", async () => {
    const id = await boundTab()
    hook(id, 'SubagentStart', {
      session_id: CHILD,
      child_session_id: CHILD,
      subagent_id: 'skill-reminder'
    })
    hook(id, 'Stop', { session_id: CHILD, last_assistant_message: 'reminder', turn_id: 'r1' })
    hook(id, 'Stop', { session_id: A, last_assistant_message: 'mine', turn_id: 't1' })
    await vi.waitFor(() => expect(events('turn-ended')).toHaveLength(1))
    expect(events('background-changed').every((e) => 'items' in e && e.items.length === 0)).toBe(
      true
    )
  })

  it('lists a file muse wrote with its added and removed lines', async () => {
    const id = await boundTab()
    hook(id, 'PostToolUse', {
      session_id: A,
      tool_name: 'edit_file',
      tool_input: { path: 'notes.md' },
      tool_response: {
        filePath: 'notes.md',
        structuredPatch: [{ lines: ['-old', '+new', '+more'], oldStart: 1, oldLines: 1 }]
      }
    })
    await vi.waitFor(() => expect(sessions.list()[0].files).toHaveLength(1))
    expect(sessions.list()[0]).toMatchObject({
      lastWritten: path.join(repo, 'notes.md'),
      files: [{ access: 'wrote', added: 2, removed: 1 }]
    })
  })

  it('shows a subagent as working in the background until it stops', async () => {
    const id = await boundTab()
    const sub = '6f1c5a2e-1d2b-4c3d-9e8f-0a1b2c3d4e5f'
    hook(id, 'SubagentStart', { session_id: CHILD, child_session_id: CHILD, subagent_id: sub })
    await vi.waitFor(() => expect(sessions.list()[0].background).toHaveLength(1))
    expect(sessions.list()[0].background![0]).toMatchObject({ kind: 'agent', state: 'working' })
    hook(id, 'SubagentStop', { session_id: CHILD, child_session_id: CHILD, subagent_id: sub })
    await vi.waitFor(() => expect(sessions.list()[0].background).toBeUndefined())
  })

  it('shows a command left running in the background until the session log says it finished', async () => {
    const id = await boundTab()
    const work = 'work.v2.managed_bash.sha256.abc'
    logRecord(A, { payload_type: 'session.opened.observed', payload: {} })
    hook(id, 'PostToolUse', {
      session_id: A,
      tool_name: 'bash',
      tool_input: { command: 'sleep 12' },
      tool_response: JSON.stringify({ execution_state: 'background_running', work_id: work })
    })
    await vi.waitFor(() => expect(sessions.list()[0].background).toHaveLength(1))
    hook(id, 'Stop', { session_id: A, last_assistant_message: 'started', turn_id: 't1' })
    logRecord(A, {
      payload_type: 'runtime.session',
      payload: {
        event: {
          kind: 'inbox_item_queued',
          registered_work_id: work,
          source: { source: 'background_task_terminal' }
        }
      }
    })
    hook(id, 'Stop', { session_id: A, last_assistant_message: 'done', turn_id: 't2' })
    await vi.waitFor(() => expect(sessions.list()[0].background).toBeUndefined())
  })

  // MUSE§8
  it('shows a background command that listens on a port as a server parked in the background, once its turn ends', async () => {
    const id = await boundTab()
    const work = 'work.v2.managed_bash.sha256.srv'
    hook(id, 'PostToolUse', {
      session_id: A,
      tool_name: 'bash',
      tool_input: { command: 'npm run dev' },
      tool_response: JSON.stringify({ execution_state: 'background_running', work_id: work })
    })
    await vi.waitFor(() =>
      expect(sessions.list()[0].background).toEqual([
        expect.objectContaining({ kind: 'command', state: 'working' })
      ])
    )
    servers = new Set([work])
    hook(id, 'Stop', { session_id: A, last_assistant_message: 'Started it', turn_id: 't1' })
    await vi.waitFor(() =>
      expect(sessions.list()[0].background).toEqual([
        expect.objectContaining({
          id: work,
          kind: 'server',
          label: 'npm run dev',
          state: 'waiting'
        })
      ])
    )
  })

  it('shows a monitor as waiting in the background until its timeout ends it', async () => {
    const id = await boundTab()
    hook(id, 'PostToolUse', {
      session_id: A,
      tool_name: 'monitor',
      tool_input: { command: 'tail -f log', description: 'Watch the log' },
      tool_response: JSON.stringify({
        work_id: 'work.v2.monitor.x',
        timeout_ms: 300,
        persistent: false
      })
    })
    await vi.waitFor(() => expect(sessions.list()[0].background).toHaveLength(1))
    expect(sessions.list()[0].background![0]).toMatchObject({
      kind: 'monitor',
      label: 'Watch the log',
      state: 'waiting'
    })
    await vi.waitFor(() => expect(sessions.list()[0].background).toBeUndefined())
  })

  it('keeps the session counted as still working while a job muse scheduled for itself is due, until a one-time job fires or a job is deleted', async () => {
    const id = await boundTab()
    logRecord(A, { payload_type: 'session.opened.observed', payload: {} })
    const create = (cron: string, recurring: boolean, job: string): string =>
      hook(id, 'PostToolUse', {
        session_id: A,
        tool_name: 'cron_create',
        tool_input: { cron, prompt: 'check', recurring },
        tool_response: `Scheduled ${job} (Every minute, once)`
      })
    create('* * * * *', false, '73ded10e')
    hook(id, 'Stop', { session_id: A, last_assistant_message: 'scheduled', turn_id: 't1' })
    await vi.waitFor(async () => expect(await runtime.stillWorking(id)).toBe(true))
    logRecord(A, {
      payload_type: 'runtime.session',
      payload: {
        event: { kind: 'inbox_item_queued', source: { source: 'scheduled', job_id: '73ded10e' } }
      }
    })
    hook(id, 'Stop', { session_id: A, last_assistant_message: 'checked', turn_id: 't2' })
    await vi.waitFor(async () => expect(await runtime.stillWorking(id)).toBe(false))
    create('*/5 * * * *', true, '7a328cdd')
    await vi.waitFor(async () => expect(await runtime.stillWorking(id)).toBe(true))
    hook(id, 'PostToolUse', {
      session_id: A,
      tool_name: 'cron_delete',
      tool_input: { id: '7a328cdd' },
      tool_response: 'Deleted 7a328cdd'
    })
    await vi.waitFor(async () => expect(await runtime.stillWorking(id)).toBe(false))
  })

  // MUSE§3
  it('shows a turn muse starts by itself as working, from the session log since such a turn sends no status, but not one logged before this tab bound', async () => {
    const queued = (atMs: number): Record<string, unknown> => ({
      recorded_at: atMs * 1000,
      payload_type: 'runtime.session',
      payload: { event: { kind: 'inbox_item_queued', source: { source: 'scheduled' } } }
    })
    logRecord(A, queued(started - 60_000))
    await boundTab()
    await new Promise((r) => setTimeout(r, 1200))
    expect(events('prompt')).toHaveLength(0)
    logRecord(A, queued(Date.now()))
    await vi.waitFor(() => expect(events('prompt')).toHaveLength(1))
  })

  // MUSE§9
  it('shows /compact as working from the session log, since a manual compaction sends no status, until its outcome is logged', async () => {
    const id = await boundTab()
    say(id, osc('?') + osc('state=done:app=muse'))
    await vi.waitFor(() => expect(runtime.statusOf(id)).toBe('waiting'))
    logRecord(A, {
      recorded_at: Date.now() * 1000,
      payload_type: 'runtime.command.accepted',
      payload: { kind: 'command_accepted', command_kind: 'context.compact.manual' }
    })
    await vi.waitFor(() => expect(runtime.statusOf(id)).toBe('working'), { timeout: 3000 })
    logRecord(A, {
      recorded_at: Date.now() * 1000,
      payload_type: 'context.compact.manual.outcome',
      payload: { kind: 'manual_compaction_outcome', terminal_outcome: 'compacted' }
    })
    await vi.waitFor(() => expect(runtime.statusOf(id)).toBe('waiting'), { timeout: 3000 })
  })

  it('retitles the row when the owner renames the session in muse, not when muse names it itself, and answers to muse’s own name for it either way', async () => {
    const id = await boundTab()
    logRecord(A, {
      payload_type: 'session.name.changed',
      payload: { new_name: 'iron-libra', source: 'automatic' }
    })
    hook(id, 'Stop', { session_id: A, last_assistant_message: 'x', turn_id: 't1' })
    await vi.waitFor(() => expect(sessions.peerName(museSessionKey(A))).toBe('iron-libra'))
    expect(sessions.list()[0].title).not.toBe('iron-libra')
    logRecord(A, {
      payload_type: 'session.name.changed',
      payload: { new_name: 'Docs cleanup', source: 'user' }
    })
    await vi.waitFor(() => expect(sessions.list()[0].title).toBe('Docs cleanup'), {
      timeout: 3000
    })
    expect(sessions.peerName(museSessionKey(A))).toBe('Docs cleanup')
  })
})

describe('MuseSessions search', () => {
  it('finds a session by what the owner said or Muse replied in any turn, not by the context muse sends the model', async () => {
    mocks.list.mockResolvedValue([{ id: A, cwd: repo }])
    await sessions.availability()
    await sessions.refreshHistory()
    logRecord(A, {
      payload_type: 'runtime.command_intake.received',
      payload: { record: { command: { kind: 'turn_submit', prompt: 'first ask' } } }
    })
    logRecord(A, {
      payload_type: 'runtime.session',
      payload: { kind: 'run', event: { kind: 'model_request_configured', text: 'zebra' } }
    })
    logRecord(A, {
      payload_type: 'runtime.session',
      payload: {
        kind: 'run',
        event: { kind: 'assistant_message_committed', text: 'The lantern is lit.' }
      }
    })
    expect(await sessions.searchSnippets('LANTERN')).toEqual([
      { id: museSessionKey(A), snippet: 'The lantern is lit.' }
    ])
    expect(await sessions.searchSnippets('zebra')).toEqual([])
  })
})

describe('reading the Muse screen before typing into it', () => {
  const RULE = '─'.repeat(60)
  const STATUS = '  fake-model · high · ~/ws · Auto-review'

  // MUSE§11
  it('takes typing only while the input box shows between the last two rules, whatever hint it holds, with or without background tasks listed under it, and not while an approval box takes its place', () => {
    expect(museShowsItsInputBox(['Muse Code 1.4.9', RULE, '❯', RULE, STATUS])).toBe(true)
    expect(
      museShowsItsInputBox([`── Voice input (⌥ + v to start) ${RULE}`, '❯ ', RULE, STATUS])
    ).toBe(true)
    expect(
      museShowsItsInputBox([RULE, '❯ ', RULE, 'main · ↓ to select', '└ ◆ Background sleep', STATUS])
    ).toBe(true)
    expect(
      museShowsItsInputBox([RULE, '❯ Press Ctrl+O to expand collapsed tool output', RULE, STATUS])
    ).toBe(true)
    expect(
      museShowsItsInputBox([
        '◇ Calling tools (1s · esc to interrupt)',
        RULE,
        'Approval request · keys active in a moment',
        '⟩ 1. Yes, proceed (y)',
        '  4. No, and tell Muse Code what to do differently (esc)',
        RULE,
        STATUS
      ])
    ).toBe(false)
    expect(museShowsItsInputBox(['❯'])).toBe(false)
  })
})

describe('muse trust list', () => {
  it("reads muse's own trust file by the folder's real path", () => {
    const link = path.join(home, 'link')
    fs.symlinkSync(repo, link)
    fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.config', 'muse', 'trust.json'),
      JSON.stringify({ schema_version: 1, projects: { [repo]: { decision: 'trusted' } } })
    )
    expect(museTrustsFolder({ HOME: home }, link)).toBe(true)
    expect(museTrustsFolder({ HOME: home }, home)).toBe(false)
  })

  it('adds a folder by its real path and keeps the folders muse already trusts', () => {
    const other = path.join(home, 'other')
    fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.config', 'muse', 'trust.json'),
      JSON.stringify({ schema_version: 1, projects: { [other]: { decision: 'trusted' } } })
    )
    const link = path.join(home, 'link')
    fs.symlinkSync(repo, link)
    trustMuseFolder({ HOME: home }, link)
    expect(museTrustsFolder({ HOME: home }, repo)).toBe(true)
    expect(museTrustsFolder({ HOME: home }, other)).toBe(true)
  })
})

describe('a Muse session on a remote machine', () => {
  const KEY = 'ssh://box/srv/proj'
  let mirrorDir: string
  let launches: Parameters<MuseMachine['launchMuse']>[0][]
  let attach: boolean
  let killed: string[]
  let gone: boolean
  let reachable: boolean
  let nameThere: string | null

  function onMachine(): void {
    mirrorDir = path.join(home, 'mirror')
    fs.mkdirSync(mirrorDir)
    launches = []
    attach = false
    killed = []
    gone = false
    reachable = true
    nameThere = null
    const acct = path.join(home, 'acct')
    fs.mkdirSync(path.join(acct, 'muse'), { recursive: true })
    fs.writeFileSync(path.join(acct, 'muse', 'auth.json'), '{"providers":{"meta":{}}}')
    picked = { account: 'work', env: { XDG_CONFIG_HOME: acct, TBH_CREDENTIAL_BACKEND: 'file' } }
    const machine: MuseMachine = {
      launchMuse: async (spec) => {
        launches.push(spec)
        if (!attach) spec.account.auth()
        return {
          attach,
          tmuxName: (tabId) => (spec.resumeSessionId ? `k-${spec.resumeSessionId}` : `m-${tabId}`),
          launchCommand: () => 'ssh box',
          resized: () => {}
        }
      },
      museServe: () => ({ binary: 'ssh', args: [] }),
      museTrusts: async () => false,
      endTmuxSession: async (name) => {
        killed.push(name)
        return undefined
      },
      runScript: async (script) => (script === TAB_TMUX_NAME_SH ? nameThere : null)
    }
    sessions = new MuseSessions(path.join(home, 'remote-sessions.json'), {
      ...sessions['deps'],
      projectInfo: (p) => ({ root: KEY, treeRoot: p }),
      remoteDirExists: async () => true,
      remote: {
        machine: () => machine,
        hosts: () => ['box'],
        keyed: (host, p) => `ssh://${host}${p}`,
        mirrorDir: () => mirrorDir,
        gone: () => gone,
        connected: () => reachable,
        poke: () => {},
        setupLine: () => undefined
      }
    })
  }

  const pulled = (): void => sessions.followMirrors('box')

  const mirror = (runId: string, ...lines: Record<string, unknown>[]): void => {
    fs.appendFileSync(
      path.join(mirrorDir, `${runId}.muse.jsonl`),
      lines.map((l) => JSON.stringify(l) + '\n').join('')
    )
    pulled()
  }

  async function boundRemote(): Promise<string> {
    const { id } = await sessions.launch({ kind: 'muse', cwd: KEY })
    mirror(id, { t: 'bound', sessionId: A })
    await vi.waitFor(() => expect(sessions.list()[0]?.nativeSessionId).toBe(A))
    return id
  }

  it('starts muse on the machine with the picked account carried along, the local ssh line in its tab, and binds from the bound line the wrapper writes', async () => {
    onMachine()
    const { id } = await sessions.launch({ kind: 'muse', cwd: KEY, firstPrompt: 'hi' })
    expect(launches[0]).toMatchObject({
      cwd: KEY,
      account: { name: 'work' },
      args: ['--approval-judge', 'off', '--sandbox-network', 'enabled', 'hi'],
      trust: []
    })
    expect(launches[0].account.auth()).toBe('{"providers":{"meta":{}}}')
    expect(vi.mocked(pty.create).mock.calls[0][0]).toMatchObject({
      kind: 'muse',
      cwd: os.homedir(),
      launchCommand: expect.any(Function)
    })
    mirror(id, { t: 'bound', sessionId: A })
    await vi.waitFor(() => expect(sessions.list()[0]?.nativeSessionId).toBe(A))
    expect(sessions.list()[0]).toMatchObject({ sessionId: museSessionKey(A, 'box'), cwd: KEY })
    expect(sessions.store.getMember(museSessionKey(A, 'box'))).toMatchObject({ cwd: KEY })
  })

  it("lists the machine's sessions under its workspace through muse serve there, and while the machine cannot be reached keeps the list it had instead of asking it", async () => {
    onMachine()
    mocks.list.mockImplementation(async (options: { over?: unknown }) =>
      options.over ? [{ id: A, cwd: '/srv/proj', name: 'On the box', createdAt: 1 }] : []
    )
    await sessions.refreshHistory()
    expect(sessions.rows(KEY).map((r) => [r.id, r.title, r.cwd])).toEqual([
      [museSessionKey(A, 'box'), 'On the box', KEY]
    ])
    reachable = false
    mocks.list.mockClear()
    await sessions.refreshHistory()
    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(sessions.rows(KEY).map((r) => r.id)).toEqual([museSessionKey(A, 'box')])
  })

  it('refuses to start when the picked account keeps no credential file to carry to the machine', async () => {
    onMachine()
    picked = { account: 'work', env: { XDG_CONFIG_HOME: path.join(home, 'empty') } }
    await expect(sessions.launch({ kind: 'muse', cwd: KEY })).rejects.toThrow(
      'keeps no credential file'
    )
  })

  it('ends a turn from the hook lines in the mirror, and keys the files Muse writes to the machine', async () => {
    onMachine()
    const id = await boundRemote()
    mirror(
      id,
      {
        t: 'hook',
        event: 'UserPromptSubmit',
        input: { session_id: A, prompt: 'go', turn_id: 't1' }
      },
      {
        t: 'hook',
        event: 'PostToolUse',
        input: {
          session_id: A,
          tool_name: 'write_file',
          tool_response: { filePath: 'src/a.ts', structuredPatch: [{ lines: ['+x'] }] }
        }
      },
      {
        t: 'hook',
        event: 'Stop',
        input: { session_id: A, turn_id: 't1', last_assistant_message: 'done' }
      }
    )
    await vi.waitFor(() => expect(events('turn-ended')).toHaveLength(1))
    expect(events('files-changed')[0]).toMatchObject({ lastWritten: `${KEY}/src/a.ts` })
  })

  it('never lets a state that came late through the mirror roll back a newer one the terminal already showed', async () => {
    onMachine()
    const id = await boundRemote()
    say(id, osc('state=working:app=muse:seq=1') + osc('state=done:app=muse:seq=2'))
    expect(events('prompt')).toHaveLength(1)
    expect(events('stop')).toHaveLength(1)
    mirror(
      id,
      { t: 'state', seq: 1, state: 'working', kind: null },
      { t: 'state', seq: 2, state: 'done', kind: null },
      { t: 'state', seq: 3, state: 'working', kind: null }
    )
    await vi.waitFor(() => expect(events('prompt')).toHaveLength(2))
    expect(events('stop')).toHaveLength(1)
  })

  it('after a Koloft restart it attaches to the session still running there, finds its wrapper through the pointer, and takes only the latest state, not the old turns', async () => {
    onMachine()
    attach = true
    sessions.store.upsertMember({
      id: A,
      key: museSessionKey(A, 'box'),
      workspacePath: KEY,
      cwd: KEY,
      title: 'Saved',
      createdAt: 1,
      updatedAt: 1
    })
    fs.writeFileSync(path.join(mirrorDir, `k-${A}.muse.run`), 'pty-old')
    mirror(
      'pty-old',
      { t: 'bound', sessionId: A },
      { t: 'state', seq: 1, state: 'working', kind: null },
      {
        t: 'hook',
        event: 'Stop',
        input: { session_id: A, turn_id: 'old', last_assistant_message: 'old' }
      },
      { t: 'state', seq: 2, state: 'blocked', kind: 'permission' }
    )
    await sessions.resume({ sessionId: museSessionKey(A, 'box'), cwd: KEY })
    expect(launches[0]).toMatchObject({ resumeSessionId: A })
    pulled()
    await vi.waitFor(() => expect(events('notify')).toHaveLength(1))
    expect(sessions.list()[0].nativeSessionId).toBe(A)
    expect(events('turn-ended')).toHaveLength(0)
    expect(events('prompt')).toHaveLength(0)
    mirror('pty-old', { t: 'state', seq: 3, state: 'done', kind: null })
    await vi.waitFor(() => expect(events('stop')).toHaveLength(1))
  })

  it('closing the tab ends the tmux session on the machine under its bound name; quitting Koloft leaves it running', async () => {
    onMachine()
    const id = await boundRemote()
    await sessions.stop(id)
    expect(killed).toEqual([`k-${A}`])
    const { id: second } = await sessions.launch({ kind: 'muse', cwd: KEY })
    expect(second).toBeTruthy()
    await sessions.stopAll()
    expect(killed).toEqual([`k-${A}`])
  })

  it('closing a tab before its bound line has come back ends the tmux session under the name the wrapper already gave it on the machine', async () => {
    onMachine()
    const { id } = await sessions.launch({ kind: 'muse', cwd: KEY })
    nameThere = `k-${A}\n`
    await sessions.stop(id)
    expect(killed).toEqual([`k-${A}`])
  })

  it('a status the terminal shows without a number, cut where the wrapper could not number it, still lights the row', async () => {
    onMachine()
    const id = await boundRemote()
    say(id, osc('state=working:app=muse'))
    expect(events('prompt')).toHaveLength(1)
  })

  it('a session that ends on the machine while the link is down closes its tab once the machine confirms it is gone', async () => {
    onMachine()
    const id = await boundRemote()
    vi.useFakeTimers()
    try {
      sessions.noticeRemoteExits('box', [A])
      gone = true
      vi.advanceTimersByTime(10_000)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() =>
      expect(events('exited')).toEqual([expect.objectContaining({ clean: false })])
    )
    expect(sessions.hasTab(id)).toBe(false)
  })
})
