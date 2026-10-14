import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MuseSessions, museTrustsFolder, type MuseSessionDeps } from '../../src/main/museSessions'
import { museSessionKey } from '../../src/main/sessionStore'
import { SessionRuntime } from '../../src/main/sessionRuntime'
import { PROGRAM_STATUS_REPLY } from '../../src/main/programStatus'

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
const ESC = '\x1b'
const osc = (body: string): string => `${ESC}]7501;${body}${ESC}\\`

let home: string
let repo: string
let sessions: MuseSessions
let pty: EventEmitter & { write: ReturnType<typeof vi.fn> }
let runtime: SessionRuntime
let pids: Map<string, number>
let created: { id: string; argv: string[]; env: NodeJS.ProcessEnv }[]
let started: number

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

beforeEach(() => {
  vi.clearAllMocks()
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-sessions-')))
  repo = path.join(home, 'repo')
  fs.mkdirSync(repo)
  mocks.runtime.mockResolvedValue({
    binary: '/fixture/muse',
    env: { HOME: home, PATH: '/usr/bin' },
    version: '1.4.7',
    verified: true
  })
  mocks.list.mockResolvedValue([])
  mocks.read.mockResolvedValue({ turns: [] })
  pids = new Map()
  created = []
  started = Date.now()
  let tab = 0
  pty = Object.assign(new EventEmitter(), {
    nextId: vi.fn(() => `pty-${++tab}`),
    create: vi.fn((args: { id: string; argv: string[]; processEnv: NodeJS.ProcessEnv }) => {
      pids.set(args.id, 4000 + tab)
      created.push({ id: args.id, argv: args.argv, env: args.processEnv })
      return { id: args.id, startedAt: started }
    }),
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
    gitAccounts: { configEnv: (env) => env }
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

describe('MuseSessions launch', () => {
  it('starts muse with the model, thinking level and "never ask" it was given, and passes them again with resume', async () => {
    await launch({ model: 'm1', effort: 'high', permission: 'bypass', firstPrompt: 'hello' })
    expect(created[0].argv).toEqual([
      '--model',
      'm1',
      '--reasoning-effort',
      'high',
      '--approval-mode',
      'never',
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
    expect(created[1].argv).toEqual(['--approval-mode', 'never', 'resume', A])
  })

  it('launches like the default for "edit without asking", since Muse has no such mode', async () => {
    await launch({ permission: 'acceptEdits' })
    expect(created[0].argv).toEqual([])
  })

  it('trusts the folder for this run only when Koloft was told to trust it', async () => {
    await launch({ trustFolder: true })
    expect(created[0].argv).toEqual(['--trust-workspace'])
  })

  it("puts the tab's own open command first on muse's PATH", async () => {
    await launch()
    const first = created[0].env.PATH!.split(':')[0]
    expect(fs.existsSync(path.join(first, 'open'))).toBe(true)
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
    const bound = vi
      .mocked(sessions['deps'].events)
      .mock.calls.filter(([, e]) => e.type === 'bound')
    expect(bound).toHaveLength(1)
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
})

describe('MuseSessions finished turns', () => {
  it('hands on the reply of a finished turn, and not again after a shell command that follows it', async () => {
    const { id } = await launch()
    register(A, pids.get(id)!)
    say(id, osc('state=idle:app=muse'))
    const turn = {
      said: [{ who: 'owner', text: 'hi', at: Date.now() }],
      reply: 'hello',
      at: Date.now()
    }
    mocks.read.mockResolvedValue({ turns: [turn], lastReplyId: 'item-1' })
    const events = vi.mocked(sessions['deps'].events)
    say(id, osc('state=working:app=muse') + osc('state=done:app=muse'))
    await vi.waitFor(() =>
      expect(events.mock.calls.filter(([, e]) => e.type === 'turn-ended')).toHaveLength(1)
    )
    say(id, osc('state=working:app=muse') + osc('state=error:app=muse'))
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))
    expect(events.mock.calls.filter(([, e]) => e.type === 'turn-ended')).toHaveLength(1)
  })
})

describe('museTrustsFolder', () => {
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
})
