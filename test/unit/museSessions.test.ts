import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MuseSessions,
  museTrustsFolder,
  trustMuseFolder,
  type MuseSessionDeps
} from '../../src/main/museSessions'
import { museSessionKey } from '../../src/main/sessionStore'
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
  readMuseTurns: mocks.read
}))

const A = '01a13795-6b09-7531-bdd6-84ce54f976ea'
const B = '01a13796-77a9-7ee3-805e-e14ad0a7b22c'
const CHILD = '9cb2b3b7-f145-4411-bf47-ebd0341e75ff'
const ESC = '\x1b'
const osc = (body: string): string => `${ESC}]7501;${body}${ESC}\\`

let home: string
let repo: string
let sessions: MuseSessions
let pty: EventEmitter & { write: ReturnType<typeof vi.fn> }
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
    agent: { enabled: () => agentTools, answer: vi.fn() },
    gitAccounts: {
      configEnv: (env) => env,
      picked: async () => false,
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

  it('asks the owner instead of an AI reviewer by default, and "edit without asking" launches the same, since Muse never asks about edits', async () => {
    await launch()
    await launch({ permission: 'acceptEdits' })
    expect(created[0].argv).toEqual(['--approval-judge', 'off'])
    expect(created[1].argv).toEqual(['--approval-judge', 'off'])
  })

  it('opens the sandbox network only when the tab can drive the Workbench browser', async () => {
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
    expect(created[0].argv).toEqual(['--approval-mode', 'never'])
    expect(created[0].env.KOLOFT_BROWSER_CDP).toBeUndefined()
    expect(museTrustsFolder({ HOME: home }, repo)).toBe(true)
    const told = JSON.parse(hook(id, 'SessionStart', { session_id: A, source: 'startup' }))
    expect(told.hookSpecificOutput.additionalContext).toBe('You are the Assist of ws.')
  })

  it('an Assist task allowed the browser gets the Workbench browser and an open sandbox network to reach it', async () => {
    endpoint = 'ws://127.0.0.1:9/cdp/x'
    assist = { role: 'r', allow: ['Bash(playwright-cli *)'] }
    await launch()
    expect(created[0].argv).toEqual(['--approval-mode', 'never', '--sandbox-network', 'enabled'])
    expect(created[0].env.KOLOFT_BROWSER_CDP).toBe(endpoint)
  })

  // ADR-0029 MUSE§9
  it('may read, write only inside its own folder and run one plain koloft command per bash call, like a Claude Assist; every other muse tool is stopped before it runs', async () => {
    assist = { role: 'r', allow: [] }
    const { id } = await launch()
    const tool = (
      tool_name: string,
      tool_input: Record<string, unknown> = {}
    ): string | undefined =>
      decision(hook(id, 'PreToolUse', { session_id: A, tool_name, tool_input }))
    expect(tool('bash', { command: 'koloft session list' })).toBeUndefined()
    expect(tool('bash', { command: 'rm -rf ../workspace' })).toBe('deny')
    expect(tool('bash', { command: 'koloft session list; rm -rf ..' })).toBe('deny')
    expect(tool('read_file', { path: '/etc/hosts' })).toBeUndefined()
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
    const create = (cron: string, recurring: boolean, job: string): void =>
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

  it('retitles the row when the owner renames the session in muse, not when muse names it itself', async () => {
    const id = await boundTab()
    logRecord(A, {
      payload_type: 'session.name.changed',
      payload: { new_name: 'iron-libra', source: 'automatic' }
    })
    hook(id, 'Stop', { session_id: A, last_assistant_message: 'x', turn_id: 't1' })
    logRecord(A, {
      payload_type: 'session.name.changed',
      payload: { new_name: 'Docs cleanup', source: 'user' }
    })
    await vi.waitFor(() => expect(sessions.list()[0].title).toBe('Docs cleanup'), {
      timeout: 3000
    })
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
