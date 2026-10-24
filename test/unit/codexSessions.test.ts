import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundFile } from '../../src/main/backgroundFile'
import { CodexSessions, type CodexSessionDeps } from '../../src/main/codexSessions'
import { storedBackend } from '../../src/main/backends/stored'
import { codexSessionKey, type WorktreeResource } from '../../src/main/sessionStore'
import type { CodexProcessOptions, CodexTransportOptions } from '../../src/main/codexTransport'
import type { MachineLogin } from '../../src/main/remote/codexMachine'
import { CODEX_ASKS_AND_WAITS } from '../../src/main/codexLaunchConfig'
import { SessionRuntime } from '../../src/main/sessionRuntime'
import { CODEX_REPLY_LANGUAGE_HOOKS, codexHoldHook } from '../../src/main/hooks'
import { HOLD_SCRIPT } from '../../src/main/resourceGuard'
import { BUSY_MARKER } from '../../src/main/machineRoom'
import { spawn } from 'child_process'
import { MIN_CODEX_VERSION } from '../../src/main/cliMinimums'
import { portOffset } from '@shared/worktreeName'

const TOO_OLD = { binary: '/fixture/codex', env: {}, version: '0.150.0', verified: false }

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  runtime: vi.fn(),
  update: vi.fn(),
  rpcHomes: [] as (string | undefined)[],
  rpcOptions: [] as CodexProcessOptions[],
  crashLeftoverMarkers: [] as string[]
}))
vi.mock('../../src/main/leftovers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/leftovers')>()),
  endCodexAppServersLeftByACrash: async (marker: string) => {
    mocks.crashLeftoverMarkers.push(marker)
  }
}))
vi.mock('../../src/main/codexRuntime', async (importOriginal) => ({
  resolveCodexRuntime: mocks.runtime,
  updateCodex: mocks.update
}))
vi.mock('../../src/main/codexTransport', () => ({
  createCodexTransport: mocks.create,
  CodexRpc: class {
    private home?: string
    constructor(options: CodexProcessOptions) {
      this.home = options.env?.CODEX_HOME
      mocks.rpcHomes.push(this.home)
      mocks.rpcOptions.push(options)
    }
    request = (method: string, params: unknown) => mocks.request(method, params, this.home)
    close = mocks.close
  }
}))

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
let directory: string
let realHome: string | undefined
let repo: string
let other: string
let sessions: CodexSessions
let deps: CodexSessionDeps
let transports: {
  options: CodexTransportOptions
  stop: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
}[]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function bind(index = 0, id = A, cwd = repo, requestId = 1, method = 'thread/start') {
  const receive = transports[index].options.onFrame
  receive('client', { id: requestId, method, params: { threadId: id } })
  receive('server', {
    id: requestId,
    result: { thread: { id, cwd, name: 'A session', createdAt: 1, status: { type: 'idle' } } }
  })
}

const HOOK_HASH = 'sha256:' + 'f'.repeat(64)

const REPLY_LANGUAGE_ENV = {
  KOLOFT_CODEX_REPLY_LANGUAGE: '/koloft/codex-reply-language.sh',
  KOLOFT_CODEX_SAID: expect.stringMatching(/\/said$/)
}

const REPLY_LANGUAGE_LISTED = CODEX_REPLY_LANGUAGE_HOOKS.map(({ event, command }) => ({
  key: `/<session-flags>/config.toml:${event}:0:0`,
  eventName: event.charAt(0).toLowerCase() + event.slice(1),
  command
}))

function hookListing(trustStatus: string, listed = REPLY_LANGUAGE_LISTED) {
  return {
    data: [
      {
        cwd: repo,
        hooks: listed.map((hook) => ({
          ...hook,
          source: 'sessionFlags',
          currentHash: HOOK_HASH,
          trustStatus
        })),
        warnings: [],
        errors: []
      }
    ]
  }
}

const historyOrTrustedHooks = async (method: string) =>
  method === 'hooks/list' ? hookListing('trusted') : { data: [], nextCursor: null }

function addMember(id = A, cwd = repo, worktreeResourceId?: string) {
  sessions.store.upsertMember({
    id,
    key: codexSessionKey(id),
    workspacePath: repo,
    cwd,
    title: 'Saved',
    createdAt: 1,
    updatedAt: 1,
    worktreeResourceId
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sessions-')))
  realHome = process.env.HOME
  process.env.HOME = directory
  repo = path.join(directory, 'repo')
  other = path.join(directory, 'other')
  fs.mkdirSync(repo)
  fs.mkdirSync(other)
  transports = []
  mocks.rpcHomes.length = 0
  mocks.rpcOptions.length = 0
  mocks.crashLeftoverMarkers.length = 0
  mocks.create.mockImplementation(async (options: CodexTransportOptions) => {
    const stop = vi.fn(async () => {})
    const request = vi.fn(async () => ({}))
    transports.push({ options, stop, request })
    return { url: 'unix:///test/rpc.sock', stop, request }
  })
  mocks.request.mockImplementation(historyOrTrustedHooks)
  mocks.close.mockResolvedValue(undefined)
  mocks.runtime.mockResolvedValue({
    binary: '/fixture/codex',
    env: {},
    version: MIN_CODEX_VERSION,
    verified: true
  })
  let tab = 0
  deps = {
    pty: {
      nextId: vi.fn(() => 'pty-reserved'),
      create: vi.fn(() => ({ id: `pty-${++tab}` })),
      kill: vi.fn(),
      clearResumeIntent: vi.fn()
    } as unknown as CodexSessionDeps['pty'],
    runtime: new SessionRuntime(),
    projectInfo: (p) => ({ root: p.startsWith(repo) ? repo : other, treeRoot: p }),
    changed: vi.fn(),
    events: vi.fn((tabId, event) => sessions.observe(tabId, event)),
    error: vi.fn(),
    trustFolder: vi.fn(),
    pickHome: vi.fn(() => ({ account: 'work', home: '/homes/work' })),
    assistOf: () => undefined,
    replyLanguageScript: '/koloft/codex-reply-language.sh',
    builtInStatusLine: vi.fn(() => true),
    browserEndpoint: vi.fn(() => ''),
    openShimRoot: path.join(directory, 'codex-open'),
    playwrightBin: path.join(directory, 'commands', 'bin'),
    agent: { enabled: () => false, answer: vi.fn() },
    gitAccounts: {
      configEnv: (env) => env,
      picked: vi.fn(async () => false),
      ghWrapper: path.join(directory, 'shim', 'gh')
    }
  }
  sessions = new CodexSessions(path.join(directory, 'sessions.json'), deps)
  vi.spyOn(sessions, 'availability').mockResolvedValue({ id: 'codex', available: true })
})

afterEach(async () => {
  vi.useRealTimers()
  await sessions.stopAll()
  vi.restoreAllMocks()
  process.env.HOME = realHome
  await BackgroundFile.whenAllWritten()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('CodexSessions', () => {
  it('moves binding and membership ownership to the native switched checkout', async () => {
    await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    bind(0, B, other, 2, 'thread/resume')
    expect(sessions.store.getMember(codexSessionKey(A))?.cwd).toBe(repo)
    expect(sessions.store.getMember(codexSessionKey(B))).toMatchObject({
      cwd: other,
      workspacePath: other
    })
    expect(sessions.list()[0]).toMatchObject({ sessionId: codexSessionKey(B), cwd: other })
    expect(sessions.rows(repo).map((row) => row.id)).toEqual([codexSessionKey(A)])
  })

  it('starts the Codex TUI with its update notice turned off, so nothing covers a new session', async () => {
    await sessions.launch({ kind: 'codex', cwd: repo })
    const argv = vi.mocked(deps.pty.create).mock.calls[0][0].argv ?? []
    const at = argv.indexOf('check_for_update_on_startup=false')
    expect(at).toBeGreaterThan(0)
    expect(argv[at - 1]).toBe('-c')
  })

  it('replaces membership on native new while keeping the former history available', async () => {
    await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    bind(0, B, repo, 2)
    expect(sessions.members().has(codexSessionKey(A))).toBe(false)
    expect(sessions.members().has(codexSessionKey(B))).toBe(true)
    expect(sessions.rows(repo).some((row) => row.id === codexSessionKey(A))).toBe(true)
  })

  it('names the session a native new replaced, so its Keep running mark can follow; a switch names none', async () => {
    deps.replaced = vi.fn()
    await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    bind(0, B, repo, 2)
    expect(deps.replaced).toHaveBeenCalledWith(codexSessionKey(A), codexSessionKey(B))
    bind(0, A, repo, 3, 'thread/resume')
    expect(deps.replaced).toHaveBeenCalledTimes(1)
  })

  it('keeps a bound run visible if saving its member fails', async () => {
    await sessions.launch({ kind: 'codex', cwd: repo })
    vi.spyOn(sessions.store, 'upsertMember').mockImplementation(() => {
      throw new Error('disk full')
    })
    bind()
    expect(sessions.members().has(codexSessionKey(A))).toBe(true)
    expect(sessions.list()).toHaveLength(1)
    expect(deps.error).toHaveBeenCalled()
  })

  it('retains old history and membership when a later page fails', async () => {
    mocks.request.mockImplementation(async (_method, params) =>
      params.archived ? { data: [] } : { data: [{ id: A, cwd: repo }] }
    )
    expect(await sessions.historyRows(repo)).toHaveLength(1)
    addMember()
    mocks.request.mockImplementation(async (_method, params) => {
      if (params.cursor) throw new Error('page failed')
      return { data: [{ id: B, cwd: repo }], nextCursor: 'second' }
    })
    await expect(sessions.historyRows(repo)).rejects.toThrow('page failed')
    expect(sessions.rows(repo).map((row) => row.id)).toEqual([codexSessionKey(A)])
    expect(sessions.members().has(codexSessionKey(A))).toBe(true)
  })

  it('looks at each history folder on disk once per history list, not on every rows read (the shared stored-sessions rows, so Muse and Antigravity too)', async () => {
    mocks.request.mockImplementation(async (_method, params) =>
      params.archived
        ? { data: [] }
        : {
            data: [
              { id: A, cwd: repo },
              { id: B, cwd: repo }
            ]
          }
    )
    await sessions.refreshHistory()
    const projectInfo = vi.spyOn(deps, 'projectInfo')
    const stat = vi.spyOn(fs, 'statSync')
    expect(sessions.rows(repo)).toHaveLength(2)
    expect(projectInfo).toHaveBeenCalledTimes(1)
    expect(stat).toHaveBeenCalledTimes(1)
    sessions.rows(repo)
    sessions.rows(other)
    expect(projectInfo).toHaveBeenCalledTimes(1)
    expect(stat).toHaveBeenCalledTimes(1)
    await sessions.refreshHistory()
    sessions.rows(repo)
    expect(projectInfo).toHaveBeenCalledTimes(2)
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('calls a thread gone only once a listing finished without it, never before the first listing, after a failed one or while a listing runs', async () => {
    const listed = codexSessionKey(A)
    const unlisted = codexSessionKey(B)
    expect(sessions.threadGone(unlisted)).toBe(false)
    mocks.request.mockRejectedValue(new Error('history unreadable'))
    await sessions.refreshHistory()
    expect(sessions.threadGone(unlisted)).toBe(false)
    mocks.request.mockImplementation(async (_method, params) => ({
      data: params.archived ? [] : [{ id: A, cwd: repo }]
    }))
    const listing = sessions.refreshHistory()
    expect(sessions.threadGone(unlisted)).toBe(false)
    await listing
    expect(sessions.threadGone(listed)).toBe(false)
    expect(sessions.threadGone(unlisted)).toBe(true)
  })

  it('reports unavailable history instead of returning an empty successful listing', async () => {
    vi.mocked(sessions.availability).mockResolvedValue({
      id: 'codex',
      available: false,
      reason: 'CLI missing'
    })
    await expect(sessions.historyRows(repo)).rejects.toThrow('CLI missing')
  })

  it('excludes archived native history from restoration and preserves managed members when resume is refused', async () => {
    mocks.request.mockImplementation(async (_method, params) => ({
      data: [{ id: params.archived ? A : B, cwd: repo }]
    }))
    expect((await sessions.historyRows(repo)).map((row) => row.id)).toEqual([codexSessionKey(B)])
    addMember()
    expect(await sessions.transcriptExists(codexSessionKey(A))).toBe(false)
    await expect(sessions.resume({ sessionId: codexSessionKey(A), cwd: repo })).rejects.toThrow(
      `codex unarchive ${A}`
    )
    expect(sessions.members().has(codexSessionKey(A))).toBe(true)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('retains archived status when a later history refresh fails partway through', async () => {
    mocks.request.mockImplementation(async (_method, params) => ({
      data: params.archived ? [{ id: A, cwd: repo }] : []
    }))
    await sessions.refreshHistory()
    mocks.request.mockImplementation(async (_method, params) => {
      if (params.archived) throw new Error('archived page unavailable')
      return { data: [] }
    })
    await expect(sessions.historyRows(repo)).rejects.toThrow('archived page unavailable')
    expect(await sessions.transcriptExists(codexSessionKey(A))).toBe(false)
  })

  it('exposes freshly read history to the resume planner without a workspace rescan', async () => {
    mocks.request.mockImplementation(async (_method, params) =>
      params.archived ? { data: [] } : { data: [{ id: A, cwd: repo }] }
    )
    await sessions.refreshHistory()
    expect(sessions.findRow(codexSessionKey(A))).toMatchObject({
      id: codexSessionKey(A),
      cwd: repo
    })
  })

  it('waits for confirmed stop before clearing a run and retains membership on stop failure', async () => {
    const launched = await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    const gate = deferred<void>()
    transports[0].stop.mockReturnValueOnce(gate.promise)
    const stopping = sessions.stop(launched.id)
    expect(sessions.hasTab(launched.id)).toBe(true)
    expect(deps.pty.kill).not.toHaveBeenCalled()
    gate.reject(new Error('still running'))
    await expect(stopping).rejects.toThrow('still running')
    expect(sessions.hasTab(launched.id)).toBe(true)
    expect(sessions.members().has(codexSessionKey(A))).toBe(true)
    await sessions.stop(launched.id)
    expect(sessions.hasTab(launched.id)).toBe(false)
    expect(sessions.members().has(codexSessionKey(A))).toBe(true)
  })

  // CODEX§15
  it('a launch and a resume both run in the account home the picker chose, since every home shares one sessions folder', async () => {
    const first = await sessions.launch({ kind: 'codex', cwd: repo })
    expect(transports[0].options.env?.CODEX_HOME).toBe('/homes/work')
    expect(vi.mocked(deps.pty.create).mock.calls[0][0].processEnv?.CODEX_HOME).toBe('/homes/work')
    bind()
    expect(sessions.list()[0].pickedAccount).toBe('work')
    await sessions.stop(first.id)

    vi.mocked(deps.pickHome).mockReturnValue({ account: 'home', home: '/homes/home' })
    await sessions.resume({ sessionId: codexSessionKey(A), cwd: repo })
    expect(transports[1].options.env?.CODEX_HOME).toBe('/homes/home')
  })

  // CODEX§15
  it('lists history from the default home every account home shares, tells a thread has a transcript from the file its listing named without asking Codex, and reads a thread whose listed file is not written yet on that same app-server', async () => {
    const written = path.join(directory, 'rollout-a.jsonl')
    const later = path.join(directory, 'rollout-b.jsonl')
    fs.writeFileSync(written, '')
    mocks.request.mockImplementation(async (method, params) => {
      if (method === 'thread/read') return { thread: { id: B, cwd: repo, path: later } }
      return params.archived
        ? { data: [] }
        : {
            data: [
              { id: A, cwd: repo, path: written },
              { id: B, cwd: repo, path: later }
            ]
          }
    })
    expect((await sessions.historyRows(repo)).map((row) => row.id).sort()).toEqual(
      [codexSessionKey(A), codexSessionKey(B)].sort()
    )
    const asked = mocks.request.mock.calls.length
    expect(await sessions.transcriptExists(codexSessionKey(A))).toBe(true)
    expect(mocks.request.mock.calls.length).toBe(asked)
    expect(await sessions.transcriptExists(codexSessionKey(B))).toBe(false)
    fs.writeFileSync(later, '')
    expect(await sessions.transcriptExists(codexSessionKey(B))).toBe(true)
    expect(mocks.request.mock.calls.slice(asked).map(([method]) => method)).toEqual(['thread/read'])
    expect(mocks.rpcHomes).toEqual([undefined])
  })

  // CODEX§24
  it('a search offers the threads of the given workspaces but no archived one, and asks thread/search once, in the default home every account shares', async () => {
    const C = '33333333-3333-4333-8333-333333333333'
    const D = '44444444-4444-4444-8444-444444444444'
    mocks.request.mockImplementation(async (method, params) => {
      if (method === 'thread/list')
        return params.archived
          ? { data: [{ id: D, cwd: repo, name: 'Parser, archived' }] }
          : {
              data: [
                { id: A, cwd: repo, name: 'Parser plan' },
                { id: B, cwd: repo, name: 'Quiet title' },
                { id: C, cwd: other, name: 'Elsewhere' }
              ]
            }
      return {
        data: [
          { snippet: '... the PARSER crashed on an empty file', thread: { id: B, cwd: repo } },
          { snippet: 'parser here too', thread: { id: C, cwd: other } }
        ],
        nextCursor: null
      }
    })
    await sessions.refreshHistory()
    expect(
      sessions
        .searchable([repo])
        .map((c) => [c.row.id, c.row.backendId, c.workspacePath])
        .sort()
    ).toEqual(
      [
        [codexSessionKey(A), 'codex', repo],
        [codexSessionKey(B), 'codex', repo]
      ].sort()
    )
    expect(await sessions.searchSnippets('parser')).toEqual([
      { id: codexSessionKey(B), snippet: '... the PARSER crashed on an empty file' },
      { id: codexSessionKey(C), snippet: 'parser here too' }
    ])
    expect(mocks.request).toHaveBeenCalledWith(
      'thread/search',
      expect.objectContaining({ searchTerm: 'parser', archived: false }),
      undefined
    )
    expect(mocks.request.mock.calls.filter(([method]) => method === 'thread/search')).toHaveLength(
      1
    )

    mocks.request.mockRejectedValue(new Error('state database locked'))
    expect(await sessions.searchSnippets('parser')).toEqual([])
  })

  it('waits for an in-flight stop before restarting and prevents duplicate resume', async () => {
    const launched = await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    const gate = deferred<void>()
    transports[0].stop.mockReturnValueOnce(gate.promise)
    const stopping = sessions.stop(launched.id)
    const restarting = sessions.resume({ sessionId: codexSessionKey(A), cwd: repo })
    await expect(sessions.resume({ sessionId: codexSessionKey(A), cwd: repo })).rejects.toThrow(
      'already opening'
    )
    expect(mocks.create).toHaveBeenCalledTimes(1)
    gate.resolve()
    await stopping
    await restarting
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(sessions.runningBindings().get(codexSessionKey(A))).toBe('pty-2')
    expect(sessions.list()).toEqual([])
  })

  it('a restart hands nothing over and resumes in the same worktree, a closed tab hands its worktree over for removal only once its Codex is gone, a resume after that removal rebuilds the worktree there, and quitting Koloft hands nothing over', async () => {
    const worktree = path.join(repo, '.claude', 'worktrees', 'w1')
    fs.mkdirSync(worktree, { recursive: true })
    const resource: WorktreeResource = {
      id: randomUUID(),
      originalCwd: repo,
      worktreePath: worktree,
      worktreeName: 'w1',
      worktreeBranch: 'worktree-w1',
      originalHeadCommit: 'a'.repeat(40),
      state: 'ready',
      managed: true
    }
    sessions.store.putResource(resource)
    vi.spyOn(sessions.worktrees, 'create').mockResolvedValue(resource)
    const rebuild = vi.spyOn(sessions.worktrees, 'rebuild').mockImplementation(async () => {
      fs.mkdirSync(worktree, { recursive: true })
      return resource
    })
    const leftWorktree = vi.fn(async (left: WorktreeResource) => {
      expect(deps.pty.kill).toHaveBeenCalled()
      fs.rmSync(left.worktreePath, { recursive: true })
    })
    deps.leftWorktree = leftWorktree

    const launched = await sessions.launch({ kind: 'codex', cwd: repo, worktree: 'w1' })
    bind(0, A, worktree)
    await sessions.stop(launched.id, undefined, true)
    expect(leftWorktree).not.toHaveBeenCalled()
    const inPlace = await sessions.resume({ sessionId: codexSessionKey(A), cwd: worktree })
    expect(rebuild).not.toHaveBeenCalled()
    bind(1, A, worktree, 1, 'thread/resume')

    await sessions.stop(inPlace.id)
    expect(leftWorktree.mock.calls).toEqual([[resource]])
    expect(fs.existsSync(worktree)).toBe(false)

    const restarted = await sessions.resume({ sessionId: codexSessionKey(A), cwd: worktree })
    expect(rebuild).toHaveBeenCalledWith(resource.id)
    expect(restarted.cwd).toBe(worktree)
    bind(2, A, worktree, 1, 'thread/resume')
    await sessions.stopAll()
    expect(leftWorktree).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(worktree)).toBe(true)
  })

  it('a resume or a restart whose deleted worktree cannot be rebuilt answers rebuild-failed, and a plain resume of the deleted folder answers cwd-missing, as a Claude Code resume does', async () => {
    const worktree = path.join(repo, '.claude', 'worktrees', 'w2')
    fs.mkdirSync(worktree, { recursive: true })
    const resource: WorktreeResource = {
      id: randomUUID(),
      originalCwd: repo,
      worktreePath: worktree,
      worktreeName: 'w2',
      worktreeBranch: 'worktree-w2',
      originalHeadCommit: 'a'.repeat(40),
      state: 'ready',
      managed: true
    }
    sessions.store.putResource(resource)
    vi.spyOn(sessions.worktrees, 'create').mockResolvedValue(resource)
    vi.spyOn(sessions.worktrees, 'rebuild').mockRejectedValue(
      new Error('The missing worktree is locked; unlock it before rebuilding')
    )
    const launched = await sessions.launch({ kind: 'codex', cwd: repo, worktree: 'w2' })
    bind(0, A, worktree)
    await sessions.stop(launched.id, undefined, true)
    fs.rmSync(worktree, { recursive: true })
    const backend = storedBackend(sessions, {} as never, {} as never)
    const key = codexSessionKey(A)

    await expect(
      backend.resume({ sessionId: key, cwd: worktree, mode: 'rebuild' })
    ).resolves.toEqual({ ok: false, code: 'rebuild-failed' })
    await expect(backend.resume({ sessionId: key, cwd: worktree })).resolves.toEqual({
      ok: false,
      code: 'rebuild-failed'
    })
    await expect(
      backend.resume({ sessionId: key, cwd: worktree, mode: 'direct' })
    ).resolves.toEqual({ ok: false, code: 'cwd-missing' })
  })

  it('a restarting session reads as running from the old run stopping until the new one starts, and cold again, with the sidebar told, when the new one fails', async () => {
    const launched = await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    const serverUp = deferred<void>()
    mocks.create.mockImplementationOnce(async () => {
      await serverUp.promise
      throw new Error('app-server did not start')
    })
    const stopping = sessions.stop(launched.id)
    const restarting = sessions.resume({ sessionId: codexSessionKey(A), cwd: repo })
    await stopping
    expect(sessions.hasTab(launched.id)).toBe(false)
    expect(sessions.rows(repo)[0]).toMatchObject({ id: codexSessionKey(A), running: true })
    vi.mocked(deps.changed).mockClear()
    serverUp.resolve()
    await expect(restarting).rejects.toThrow('app-server did not start')
    expect(sessions.rows(repo)[0]).toMatchObject({ id: codexSessionKey(A), running: false })
    expect(deps.changed).toHaveBeenCalled()
  })

  it('retains members for uncertain native exit, evicts only an acknowledged native unsubscribe', async () => {
    const first = await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    transports[0].options.onFrame('client', {
      id: 2,
      method: 'thread/unsubscribe',
      params: { threadId: A }
    })
    await sessions.stop(first.id, 0)
    expect(sessions.members().has(codexSessionKey(A))).toBe(true)
    const second = await sessions.resume({ sessionId: codexSessionKey(A), cwd: repo })
    bind(1, A, repo, 1, 'thread/resume')
    transports[1].options.onFrame('client', {
      id: 2,
      method: 'thread/unsubscribe',
      params: { threadId: A }
    })
    transports[1].options.onFrame('server', { id: 2, result: { status: 'unsubscribed' } })
    await sessions.stop(second.id, 0)
    expect(sessions.members().has(codexSessionKey(A))).toBe(false)
  })

  it('a waiting Codex session turns idle after 4 minutes and closes itself 30 minutes later, but not while a background command is still open', async () => {
    vi.useFakeTimers()
    const closes: string[] = []
    deps.runtime.on('auto-close', ({ tabId }: { tabId: string }) => closes.push(tabId))
    const launched = await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    const status = () => sessions.list()[0]?.status
    expect(status()).toBe('waiting')
    const command = { type: 'commandExecution', id: 'dev', command: 'npm run dev' }
    const receive = transports[0].options.onFrame
    receive('server', {
      method: 'item/started',
      params: { threadId: A, item: { ...command, status: 'inProgress' } }
    })
    await vi.advanceTimersByTimeAsync(4 * 60_000 - 1)
    expect(status()).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1)
    expect(status()).toBe('idle')
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(closes).toEqual([])
    receive('server', {
      method: 'item/completed',
      params: { threadId: A, item: { ...command, status: 'completed' } }
    })
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(closes).toEqual([launched.id])
  })

  it('shows the files a Codex patch wrote on the session, and counts the patch as a live write', async () => {
    await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    const file = path.join(repo, 'notes.txt')
    transports[0].options.onFrame('server', {
      method: 'item/completed',
      params: {
        threadId: A,
        item: {
          type: 'fileChange',
          id: 'patch',
          status: 'completed',
          changes: [{ path: file, kind: { type: 'update', move_path: null }, diff: '+new\n' }]
        }
      }
    })
    expect(sessions.list()[0]).toMatchObject({
      files: [{ src: file, access: 'wrote', added: 1 }],
      lastWritten: file,
      liveWrites: 1
    })
  })

  it('hands an open command Codex ran to the Workbench for that tab', async () => {
    const launched = await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    transports[0].options.onFrame('server', {
      method: 'item/completed',
      params: {
        threadId: A,
        item: {
          type: 'commandExecution',
          id: 'open',
          status: 'completed',
          command: "/bin/zsh -lc 'open ./report.html'",
          cwd: repo,
          commandActions: [{ type: 'unknown', command: 'open ./report.html' }]
        }
      }
    })
    expect(deps.events).toHaveBeenCalledWith(launched.id, {
      type: 'open',
      target: path.join(repo, 'report.html')
    })
  })

  it("points Codex's zsh at a dotfile folder of the run's own, whose open shim asks Koloft through /tmp and reads no KOLOFT_ variable", async () => {
    await sessions.launch({ kind: 'codex', cwd: repo })
    const zdot = transports[0].options.env?.ZDOTDIR
    expect(zdot?.startsWith(path.join(directory, 'codex-open') + path.sep)).toBe(true)
    expect(vi.mocked(deps.pty.create).mock.calls[0][0].processEnv?.ZDOTDIR).toBe(zdot)
    const script = fs.readFileSync(path.join(path.dirname(zdot!), 'open'), 'utf8')
    expect(script).toMatch(/\/tmp\/koloft-cx-open-\d+-[0-9a-f-]{36}/)
    expect(script).not.toContain('KOLOFT_')
  })

  it("an open the shim drops in the run's request folder reaches that tab's Workbench, and stopping the run removes the shim and the folder", async () => {
    const launched = await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    const shimDir = path.dirname(transports[0].options.env!.ZDOTDIR!)
    const requestDir = /\/tmp\/koloft-cx-open-\d+-[0-9a-f-]{36}/.exec(
      fs.readFileSync(path.join(shimDir, 'open'), 'utf8')
    )![0]
    fs.writeFileSync(
      path.join(requestDir, 'drop-1.json'),
      JSON.stringify({ openId: 'drop-1', path: path.join(repo, 'report.html'), url: '', cwd: repo })
    )
    await expect
      .poll(() => vi.mocked(deps.events).mock.calls)
      .toContainEqual([launched.id, { type: 'open', target: path.join(repo, 'report.html') }])
    await sessions.stop(launched.id)
    expect(fs.existsSync(shimDir)).toBe(false)
    expect(fs.existsSync(requestDir)).toBe(false)
  })

  // CODEX§17
  it("with agent tools on, the app-server is told to run koloft help and to hand work needing its own worktree to a Koloft session, a koloft request dropped in the run's own folder is answered for that tab, and stopping the run removes the folder", async () => {
    const answer = vi.fn()
    deps.agent = { enabled: () => true, answer }
    const launched = await sessions.launch({ kind: 'codex', cwd: repo })
    const hint = transports[0].options.configOverrides?.find((c) =>
      c.startsWith('developer_instructions=')
    )
    expect(hint).toContain('koloft help')
    expect(hint).toContain('koloft session new -w')
    const shimDir = path.dirname(transports[0].options.env!.ZDOTDIR!)
    const requestDir = /\/tmp\/koloft-cx-open-\d+-[0-9a-f-]{36}/.exec(
      fs.readFileSync(path.join(shimDir, 'koloft'), 'utf8')
    )![0]
    const request = { argv: ['help'], cwd: repo }
    // PLATFORM§28
    await expect
      .poll(() => {
        fs.writeFileSync(path.join(requestDir, 'req-1.json'), JSON.stringify(request))
        return answer.mock.calls
      })
      .toContainEqual([launched.id, requestDir, 'req-1.json', request])
    await sessions.stop(launched.id)
    expect(fs.existsSync(requestDir)).toBe(false)
  })

  // CODEX§17
  it("koloft session send queues on the session's own thread, never on the TUI's title thread", async () => {
    const launched = await sessions.launch({ kind: 'codex', cwd: repo })
    await expect(sessions.queueMessage(launched.id, 'hello')).rejects.toThrow('not started')
    bind()
    const receive = transports[0].options.onFrame
    receive('client', { id: 'title', method: 'thread/start', params: { ephemeral: true } })
    receive('server', { id: 'title', result: { thread: { id: B, cwd: repo, ephemeral: true } } })
    await sessions.queueMessage(launched.id, 'hello')
    expect(transports[0].request).toHaveBeenCalledWith(
      'thread/queue/add',
      expect.objectContaining({
        threadId: A,
        input: [{ type: 'text', text: 'hello', text_elements: [] }]
      }),
      expect.any(Number)
    )
  })

  // ADR-0029
  it('a conductor with agent tools on is told its role but never the helper rules, which would have it do work itself', async () => {
    deps.agent = { enabled: () => true, answer: vi.fn() }
    await sessions.launch({ kind: 'codex', cwd: repo, conductor: true, role: 'ROLE-TEXT' })
    const hint = transports[0].options.configOverrides?.find((c) =>
      c.startsWith('developer_instructions=')
    )
    expect(hint).toContain('ROLE-TEXT')
    expect(hint).not.toContain('HELPERS')
  })

  // ADR-0031
  it('a Codex child starts with the owner’s words its parent handed over already saved for its reply-language hook, whatever language its handover note is in', async () => {
    await sessions.launch({
      kind: 'codex',
      cwd: repo,
      role: 'Koloft 启动了你。主人最后写的是 «把侧栏修好»。',
      firstPrompt: 'Fix the sidebar.',
      ownerWords: '把侧栏修好'
    })
    const said = transports[0].options.sessionEnv!.KOLOFT_CODEX_SAID
    expect(fs.readFileSync(said, 'utf8')).toBe('把侧栏修好')
  })

  it('with agent tools off, a Codex tab gets neither the koloft command nor the Koloft hint', async () => {
    await sessions.launch({ kind: 'codex', cwd: repo })
    expect(
      transports[0].options.configOverrides?.some((c) => c.startsWith('developer_instructions='))
    ).toBe(false)
    const shimDir = path.dirname(transports[0].options.env!.ZDOTDIR!)
    expect(fs.existsSync(path.join(shimDir, 'koloft'))).toBe(false)
  })

  it('reports an unexpected exit after confirmed stop without immediately clearing the alert', async () => {
    const launched = await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    vi.mocked(deps.events).mockClear()
    await sessions.stop(launched.id, 1)
    expect(deps.events).toHaveBeenCalledWith(
      launched.id,
      expect.objectContaining({ type: 'exited', clean: false })
    )
    expect(sessions.members().has(codexSessionKey(A))).toBe(true)
  })

  it('honors the selected renamed checkout even if initial history reports the old cwd', async () => {
    const oldPath = path.join(repo, 'old')
    const newPath = path.join(repo, 'new')
    fs.mkdirSync(oldPath)
    fs.mkdirSync(newPath)
    const resource: WorktreeResource = {
      id: randomUUID(),
      originalCwd: repo,
      worktreePath: oldPath,
      worktreeName: 'old',
      worktreeBranch: 'worktree-old',
      originalHeadCommit: 'a'.repeat(40),
      managed: true,
      state: 'ready'
    }
    const renamed: WorktreeResource = {
      ...resource,
      id: randomUUID(),
      worktreePath: newPath,
      worktreeName: 'new',
      worktreeBranch: 'worktree-new'
    }
    sessions.store.putResource(resource)
    sessions.store.putResource(renamed)
    addMember(A, oldPath, resource.id)
    vi.spyOn(sessions.worktrees, 'prepareRenamed').mockResolvedValue(renamed)
    const result = await sessions.resume({
      sessionId: codexSessionKey(A),
      cwd: oldPath,
      mode: 'renamed',
      worktree: 'new'
    })
    expect(result.cwd).toBe(newPath)
    bind(0, A, oldPath, 1, 'thread/resume')
    expect(sessions.store.getMember(codexSessionKey(A))).toMatchObject({
      cwd: newPath,
      worktreeResourceId: renamed.id
    })
    expect(sessions.list()[0].cwd).toBe(newPath)
  })

  it('a person’s new worktree launch trusts the workspace folder and the worktree itself in the shared config, never through an account home, and passes the chosen permission as approval and sandbox flags; a scheduled one trusts nothing', async () => {
    const worktree = path.join(repo, '.claude', 'worktrees', 'w1')
    fs.mkdirSync(worktree, { recursive: true })
    vi.spyOn(sessions.worktrees, 'create').mockResolvedValue({
      id: randomUUID(),
      originalCwd: repo,
      worktreePath: worktree,
      worktreeName: 'w1',
      worktreeBranch: 'worktree-w1'
    } as WorktreeResource)
    vi.mocked(deps.pickHome).mockReturnValue({ account: 'work', home: '/homes/work' })
    await sessions.launch({ kind: 'codex', cwd: repo, worktree: 'w1', permission: 'bypass' })
    expect(vi.mocked(deps.trustFolder).mock.calls.map(([dir]) => dir)).toEqual([repo, worktree])
    for (const [, env] of vi.mocked(deps.trustFolder).mock.calls)
      expect(env?.CODEX_HOME).toBeUndefined()
    expect(vi.mocked(deps.pty.create).mock.calls[0][0].processEnv?.CODEX_HOME).toBe('/homes/work')
    const argv = vi.mocked(deps.pty.create).mock.calls[0][0].argv!
    expect(argv.slice(-4)).toEqual(['-a', 'never', '-s', 'danger-full-access'])

    await sessions.launch({ kind: 'codex', cwd: repo, worktree: 'w1', scheduled: true })
    expect(deps.trustFolder).toHaveBeenCalledTimes(2)
  })

  it("a worktree launch's app-server gets that worktree's port offset, and a launch in the main checkout gets none", async () => {
    const worktree = path.join(repo, '.claude', 'worktrees', 'w1')
    fs.mkdirSync(worktree, { recursive: true })
    vi.spyOn(sessions.worktrees, 'create').mockResolvedValue({
      id: randomUUID(),
      originalCwd: repo,
      worktreePath: worktree,
      worktreeName: 'w1',
      worktreeBranch: 'worktree-w1'
    } as WorktreeResource)
    await sessions.launch({ kind: 'codex', cwd: repo, worktree: 'w1' })
    await sessions.launch({ kind: 'codex', cwd: repo })
    const sessionEnvs = mocks.create.mock.calls.map(
      (call) => (call[0] as CodexTransportOptions).sessionEnv
    )
    expect(sessionEnvs.map((e) => e?.KOLOFT_PORT_OFFSET)).toEqual([
      String(portOffset('w1')),
      undefined
    ])
  })

  // CODEX§26
  it("with browser control on, every Playwright MCP entry in the owner's Codex config keeps its own env_vars and gains the tab's relay endpoint; other entries, and names Codex's -c cannot spell, are left alone", async () => {
    const endpoint = 'ws://127.0.0.1:4100/cdp/' + 'a'.repeat(32)
    vi.mocked(deps.browserEndpoint).mockImplementation((tabId) =>
      tabId === 'pty-reserved' ? endpoint : ''
    )
    mocks.request.mockImplementation(async (method: string) =>
      method === 'config/read'
        ? {
            config: {
              mcp_servers: {
                playwright: {
                  command: 'npx',
                  args: ['@playwright/mcp@latest'],
                  env_vars: ['MINE']
                },
                'pw-global': { command: '/usr/local/bin/playwright-mcp', args: [] },
                'my.browser': { command: 'npx', args: ['@playwright/mcp'] },
                github: { command: 'github-mcp', args: [], env_vars: ['GH_TOKEN'] }
              }
            }
          }
        : {}
    )
    await sessions.launch({ kind: 'codex', cwd: repo })
    const options = mocks.create.mock.calls[0][0] as CodexTransportOptions
    expect(mocks.request).toHaveBeenCalledWith('config/read', { cwd: repo }, '/homes/work')
    expect(options.configOverrides).toEqual(
      expect.arrayContaining([
        'mcp_servers.playwright.env_vars=["MINE","PLAYWRIGHT_MCP_CDP_ENDPOINT","PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS"]',
        'mcp_servers.pw-global.env_vars=["PLAYWRIGHT_MCP_CDP_ENDPOINT","PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS"]'
      ])
    )
    expect(options.configOverrides!.filter((o) => o.startsWith('mcp_servers.'))).toHaveLength(2)
    expect(vi.mocked(deps.pty.create).mock.calls[0][0].id).toBe('pty-reserved')

    const answer = mocks.request.getMockImplementation()!
    let lostTheRace = false
    mocks.request.mockImplementation(async (method: string, ...rest: unknown[]) => {
      if (method === 'config/read' && !lostTheRace) {
        lostTheRace = true
        throw new Error('app-server exited')
      }
      return answer(method, ...rest)
    })
    await sessions.launch({ kind: 'codex', cwd: repo })
    const retried = mocks.create.mock.calls.at(-1)![0] as CodexTransportOptions
    expect(retried.configOverrides!.filter((o) => o.startsWith('mcp_servers.'))).toHaveLength(2)
    mocks.request.mockImplementation(answer)

    vi.mocked(deps.browserEndpoint).mockReturnValue('')
    mocks.request.mockClear()
    await sessions.launch({ kind: 'codex', cwd: repo })
    expect(mocks.request).not.toHaveBeenCalledWith(
      'config/read',
      expect.anything(),
      expect.anything()
    )
    const off = mocks.create.mock.calls.at(-1)![0] as CodexTransportOptions
    expect(off.configOverrides!.some((o) => o.startsWith('mcp_servers.'))).toBe(false)
    expect(off.sessionEnv).toEqual({
      ...REPLY_LANGUAGE_ENV,
      PLAYWRIGHT_CLI_SESSION: 'koloft-pty-reserved'
    })
  })

  // CODEX§26 PLATFORM§17 ADR-0029
  it("every tab's shell finds Koloft's playwright-cli first and runs it under the tab's own session; with browser control on it also gets the relay endpoint, and its sandbox the network plus Playwright's cache folder on top of the owner's own writable folders, the butler's alike; with browser control off the sandbox stays as it was", async () => {
    const endpoint = 'ws://127.0.0.1:4100/cdp/' + 'b'.repeat(32)
    const cache = path.join(directory, 'Library', 'Caches', 'ms-playwright')
    vi.mocked(deps.browserEndpoint).mockReturnValue(endpoint)
    mocks.request.mockImplementation(async (method: string) =>
      method === 'config/read'
        ? { config: { sandbox_workspace_write: { writable_roots: ['/owner/root', cache] } } }
        : historyOrTrustedHooks(method)
    )
    await sessions.launch({ kind: 'codex', cwd: repo })
    const on = mocks.create.mock.calls[0][0] as CodexTransportOptions
    expect(on.sessionEnv).toEqual({
      ...REPLY_LANGUAGE_ENV,
      PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint,
      PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: '1',
      PLAYWRIGHT_CLI_SESSION: 'koloft-pty-reserved',
      KOLOFT_BROWSER_CDP: endpoint
    })
    expect(on.configOverrides).toEqual(
      expect.arrayContaining([
        'sandbox_workspace_write.network_access=true',
        `sandbox_workspace_write.writable_roots=${JSON.stringify(['/owner/root', cache])}`
      ])
    )
    expect(fs.statSync(cache).isDirectory()).toBe(true)
    const zdot = vi.mocked(deps.pty.create).mock.calls[0][0].processEnv!.ZDOTDIR!
    expect(fs.readlinkSync(path.join(path.dirname(zdot), 'playwright-cli'))).toBe(
      path.join(deps.playwrightBin, 'playwright-cli')
    )

    await sessions.launch({ kind: 'codex', cwd: repo, conductor: true })
    const conductor = mocks.create.mock.calls[1][0] as CodexTransportOptions
    expect(conductor.sessionEnv).toEqual({
      ...REPLY_LANGUAGE_ENV,
      PLAYWRIGHT_MCP_CDP_ENDPOINT: endpoint,
      PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: '1',
      PLAYWRIGHT_CLI_SESSION: 'koloft-pty-reserved',
      KOLOFT_BROWSER_CDP: endpoint
    })
    expect(conductor.configOverrides).toEqual(expect.arrayContaining([...on.configOverrides!]))

    vi.mocked(deps.browserEndpoint).mockReturnValue('')
    await sessions.launch({ kind: 'codex', cwd: repo })
    const off = mocks.create.mock.calls[2][0] as CodexTransportOptions
    expect(off.configOverrides!.some((o) => o.startsWith('sandbox_workspace_write.'))).toBe(false)
    expect(off.sessionEnv).toEqual({
      ...REPLY_LANGUAGE_ENV,
      PLAYWRIGHT_CLI_SESSION: 'koloft-pty-reserved'
    })
  })

  it("a tab's shell finds the user's own gh before the one Koloft ships, and Koloft's git first only when the Mac has none", async () => {
    mocks.runtime.mockResolvedValue({
      binary: '/fixture/codex',
      env: { PATH: '/usr/bin:/opt/homebrew/bin' },
      version: MIN_CODEX_VERSION,
      verified: true
    })
    vi.mocked(sessions.availability).mockRestore()
    deps.fallbackBin = '/koloft/fallback-bin'
    await sessions.launch({ kind: 'codex', cwd: repo })
    const withGit = vi.mocked(deps.pty.create).mock.calls[0][0].processEnv!
    expect(withGit.PATH).toBe('/usr/bin:/opt/homebrew/bin:/koloft/fallback-bin')
    expect(fs.existsSync(path.join(path.dirname(withGit.ZDOTDIR!), 'git'))).toBe(false)
    expect(fs.readlinkSync(path.join(path.dirname(withGit.ZDOTDIR!), 'gh'))).toBe(
      deps.gitAccounts.ghWrapper
    )

    deps.gitBin = path.join(directory, 'git-bin')
    await sessions.launch({ kind: 'codex', cwd: repo })
    const noGit = vi.mocked(deps.pty.create).mock.calls[1][0].processEnv!
    expect(fs.readlinkSync(path.join(path.dirname(noGit.ZDOTDIR!), 'git'))).toBe(
      path.join(deps.gitBin, 'git')
    )
  })

  // CODEX§29
  it('a tab in a repository with a picked git account may reach the network, and one without stays offline', async () => {
    vi.mocked(deps.gitAccounts.picked).mockImplementation(async (cwd) => cwd === repo)
    await sessions.launch({ kind: 'codex', cwd: repo })
    await sessions.launch({ kind: 'codex', cwd: other })
    const [picked, unpicked] = mocks.create.mock.calls.map(([o]) => o as CodexTransportOptions)
    expect(picked.configOverrides).toContain('sandbox_workspace_write.network_access=true')
    expect(unpicked.configOverrides!.some((o) => o.startsWith('sandbox_workspace_write.'))).toBe(
      false
    )
  })

  // ADR-0029 CODEX§11
  it('the butler runs with the permission it is started and resumed with, like any tab: bypass is approvals never and the danger-full-access sandbox as TUI flags, and on a resume, which refuses those flags, its own app-server gets the same choice', async () => {
    const first = await sessions.launch({
      kind: 'codex',
      cwd: repo,
      conductor: true,
      permission: 'bypass'
    })
    bind()
    await sessions.stop(first.id)
    const again = await sessions.resume({
      sessionId: codexSessionKey(A),
      cwd: repo,
      conductor: true,
      permission: 'bypass'
    })
    const [startArgv, resumeArgv] = vi.mocked(deps.pty.create).mock.calls.map(([c]) => c.argv!)
    expect(startArgv[startArgv.indexOf('-s') + 1]).toBe('danger-full-access')
    expect(startArgv[startArgv.indexOf('-a') + 1]).toBe('never')
    expect(resumeArgv).not.toContain('-s')
    expect(resumeArgv).not.toContain('-a')
    expect(transports[1].options.configOverrides).toEqual(
      expect.arrayContaining(['approval_policy="never"', 'sandbox_mode="danger-full-access"'])
    )
    expect(sessions.launchedBypassingChecks(again.id)).toBe(true)

    await sessions.launch({ kind: 'codex', cwd: repo, conductor: true })
    const asking = vi.mocked(deps.pty.create).mock.calls.at(-1)![0].argv!
    expect(asking).not.toContain('-s')
    expect(asking).not.toContain('-a')
  })

  // CODEX§27
  // ADR-0031
  it("every Codex tab's app-server, the butler's alike, carries a question tool that waits for the owner and Koloft's reply-language hooks once Codex trusts them, and no gate; before the TUI starts a second app-server started the same way is asked whether Codex trusts them", async () => {
    const replyHooks = (options: CodexTransportOptions): string[] =>
      options.configOverrides!.filter((o) => /^hooks\.(UserPromptSubmit|PostToolUse)=/.test(o))
    mocks.request.mockImplementation(async (method: string) =>
      method === 'hooks/list' ? hookListing('untrusted') : {}
    )
    await sessions.launch({ kind: 'codex', cwd: repo })
    expect(transports[0].options.configOverrides).toContain(CODEX_ASKS_AND_WAITS)
    expect(replyHooks(transports[0].options)).toEqual([])

    mocks.request.mockImplementation(async (method: string) =>
      method === 'hooks/list' ? hookListing('trusted') : { data: [], nextCursor: null }
    )
    await sessions.launch({ kind: 'codex', cwd: repo })
    expect(replyHooks(transports[1].options)).toHaveLength(2)

    await sessions.launch({ kind: 'codex', cwd: repo, conductor: true })
    const tab = transports[2].options
    expect(tab.configOverrides!.some((o) => o.startsWith('hooks.PreToolUse='))).toBe(false)
    expect(tab.configOverrides).toContain(CODEX_ASKS_AND_WAITS)
    expect(replyHooks(tab)).toHaveLength(2)
    const checker = mocks.rpcOptions.at(-1)!
    expect(checker.sessionEnv).toEqual(tab.sessionEnv)
    expect(checker.env).toEqual(tab.env)
    expect(checker.cwd).toBe(repo)
    expect(mocks.request).toHaveBeenCalledWith('hooks/list', { cwds: [repo] }, '/homes/work')
    expect(mocks.close).toHaveBeenCalled()
  })

  async function launchWithBuiltInStatusLine(...switches: boolean[]): Promise<void> {
    for (const on of switches) {
      vi.mocked(deps.builtInStatusLine).mockReturnValue(on)
      await sessions.launch({ kind: 'codex', cwd: repo })
    }
  }

  // CODEX§8
  it("with the built-in status line off, neither a Codex tab's app-server nor its TUI is handed Koloft's status line, so Codex shows the owner's own", async () => {
    const statusLine = (values: readonly string[]): string[] =>
      values.filter((v) => v.startsWith('tui.status_line='))
    await launchWithBuiltInStatusLine(false, true)

    const [off, on] = transports.map((t) => t.options.configOverrides!)
    const [offArgv, onArgv] = vi.mocked(deps.pty.create).mock.calls.map(([c]) => c.argv!)
    expect(statusLine(off)).toEqual([])
    expect(statusLine(offArgv)).toEqual([])
    expect(statusLine(on)).toHaveLength(1)
    expect(statusLine(onArgv)).toEqual(statusLine(on))
    expect(onArgv[onArgv.indexOf(statusLine(on)[0]) - 1]).toBe('-c')
  })

  // CODEX§5
  it("the mark Koloft looks for to end a Codex app-server left by a crash is on every tab's app-server, with the built-in status line on or off", async () => {
    await launchWithBuiltInStatusLine(false, true)

    expect(mocks.crashLeftoverMarkers).toHaveLength(1)
    for (const { options } of transports)
      expect(options.configOverrides).toContain(mocks.crashLeftoverMarkers[0])
  })

  // ADR-0043 CODEX§27 CODEX§30
  it("a background tab's app-server, once Codex trusts the hook, holds its next Bash command while the Mac is busy, for at most 25 s; an owner's tab gets no hold", async () => {
    const reg = path.join(directory, 'reg')
    fs.mkdirSync(reg)
    const file = path.join(directory, 'hold.sh')
    fs.writeFileSync(file, HOLD_SCRIPT)
    deps.holdScript = { file, regDir: reg }
    deps.holdWhileBusy = (tabId) => tabId === 'pty-bg'
    const hold = codexHoldHook('hold')
    const listed = [
      ...REPLY_LANGUAGE_LISTED,
      {
        key: '/<session-flags>/config.toml:pre_tool_use:0:0',
        eventName: 'preToolUse',
        command: hold.command
      }
    ]
    mocks.request.mockImplementation(async (method: string) =>
      method === 'hooks/list' ? hookListing('trusted', listed) : { data: [], nextCursor: null }
    )
    await sessions.launch({ kind: 'codex', cwd: repo })
    await sessions.launch({ kind: 'codex', cwd: repo, tabId: 'pty-bg' })
    const [owner, background] = transports.map((t) => t.options)
    expect(owner.configOverrides!.some((o) => o.startsWith('hooks.PreToolUse='))).toBe(false)
    expect(background.configOverrides).toContain(
      `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${JSON.stringify(hold.command)},timeout=60}]}]`
    )
    expect(hold.command).toMatch(/ 25$/)
    fs.writeFileSync(path.join(reg, BUSY_MARKER), '')
    const kid = spawn('/bin/sh', ['-c', hold.command], {
      env: { PATH: process.env.PATH ?? '', ...background.sessionEnv }
    })
    kid.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }))
    await vi.waitFor(
      () => expect(fs.readdirSync(reg).some((n) => /^pty-bg\.\d+\.held$/.test(n))).toBe(true),
      { timeout: 3000 }
    )
    fs.writeFileSync(path.join(reg, 'pty-bg.free'), '')
    await new Promise((resolve) => kid.on('exit', resolve))
  })

  // CODEX§27 CODEX§15
  it("when Codex does not trust Koloft's reply-language hooks, Koloft writes one trust entry per hook into the config every account home links to and asks again; it asks no more while that config is unchanged", async () => {
    const shared = path.join(directory, '.codex', 'config.toml')
    const home = path.join(directory, 'homes', 'work')
    const [{ key: first }] = REPLY_LANGUAGE_LISTED
    fs.mkdirSync(path.dirname(shared), { recursive: true })
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(
      shared,
      `model = "gpt-5"\n\n[hooks.state."${first}"]\ntrusted_hash = "sha256:old"\n`
    )
    fs.symlinkSync(shared, path.join(home, 'config.toml'))
    vi.mocked(deps.pickHome).mockReturnValue({ account: 'work', home })
    const trustedOnDisk = (): boolean => fs.readFileSync(shared, 'utf8').includes(HOOK_HASH)
    mocks.request.mockImplementation(async (method: string) =>
      method === 'hooks/list'
        ? hookListing(trustedOnDisk() ? 'trusted' : 'modified')
        : { data: [], nextCursor: null }
    )

    await sessions.launch({ kind: 'codex', cwd: repo })
    expect(fs.lstatSync(path.join(home, 'config.toml')).isSymbolicLink()).toBe(true)
    const written = fs.readFileSync(shared, 'utf8')
    expect(written.startsWith('model = "gpt-5"\n')).toBe(true)
    expect(written.split(`[hooks.state."${first}"]\n`)).toHaveLength(2)
    for (const { key } of REPLY_LANGUAGE_LISTED)
      expect(written).toContain(`[hooks.state."${key}"]\ntrusted_hash = "${HOOK_HASH}"\n`)
    expect(transports).toHaveLength(1)

    const asks = (): number =>
      mocks.request.mock.calls.filter(([method]) => method === 'hooks/list').length
    const asked = asks()
    await sessions.launch({ kind: 'codex', cwd: repo })
    expect(asks()).toBe(asked)
  })

  // CODEX§17
  it("an Assist's folder gets an AGENTS.md that tells Codex to keep what the owner teaches it there, so it remembers after a restart or a resume; one already there is kept, and a plain tab's folder gets none", async () => {
    const memory = path.join(repo, 'AGENTS.md')
    await sessions.launch({ kind: 'codex', cwd: repo })
    expect(fs.existsSync(memory)).toBe(false)
    await sessions.launch({ kind: 'codex', cwd: repo, conductor: true, trustFolder: true })
    expect(fs.readFileSync(memory, 'utf8')).toMatch(/memory/)
    fs.writeFileSync(memory, 'Favourite fruit: lychee.\n')
    await sessions.launch({ kind: 'codex', cwd: repo, conductor: true, trustFolder: true })
    expect(fs.readFileSync(memory, 'utf8')).toBe('Favourite fruit: lychee.\n')
  })

  // ADR-0029 CODEX§26
  it('the butler reaches the Workbench browser like any tab, and its Playwright tools ask as any tab’s do', async () => {
    const endpoint = 'ws://127.0.0.1:4100/cdp/' + 'c'.repeat(32)
    vi.mocked(deps.browserEndpoint).mockReturnValue(endpoint)
    const answer = mocks.request.getMockImplementation()!
    mocks.request.mockImplementation(async (method: string, ...rest: unknown[]) =>
      method === 'config/read'
        ? { config: { mcp_servers: { playwright: { command: 'npx', args: ['@playwright/mcp'] } } } }
        : answer(method, ...rest)
    )
    await sessions.launch({ kind: 'codex', cwd: repo, conductor: true })
    expect(transports[0].options.sessionEnv?.KOLOFT_BROWSER_CDP).toBe(endpoint)
    expect(transports[0].options.configOverrides).not.toContain(
      'mcp_servers.playwright.default_tools_approval_mode="approve"'
    )
  })

  // ADR-0028 CODEX§11
  it('remembers whether Koloft launched a session with approvals and the sandbox bypassed, the mode its messages to Claude sessions claim, and a resume of that session bypasses them again through its app-server', async () => {
    const bypassed = await sessions.launch({ kind: 'codex', cwd: repo, permission: 'bypass' })
    const asking = await sessions.launch({ kind: 'codex', cwd: repo })
    expect(sessions.launchedBypassingChecks(bypassed.id)).toBe(true)
    expect(sessions.launchedBypassingChecks(asking.id)).toBe(false)

    bind(0)
    await sessions.stop(bypassed.id)
    const again = await sessions.resume({ sessionId: codexSessionKey(A), cwd: repo })
    expect(sessions.launchedBypassingChecks(again.id)).toBe(true)
    expect(vi.mocked(deps.pty.create).mock.calls[2][0].argv).not.toContain('-a')
    expect(transports[2].options.configOverrides).toEqual(
      expect.arrayContaining(['approval_policy="never"', 'sandbox_mode="danger-full-access"'])
    )
  })

  // CODEX§11
  it('with skip permission prompts on, a new thread starts with approvals and the sandbox off, while a resume keeps the permission its thread started with, which Codex restores itself', async () => {
    let skip = false
    deps.skipPermissions = () => skip
    const asking = await sessions.launch({ kind: 'codex', cwd: repo })
    bind(0, A)
    await sessions.stop(asking.id)

    skip = true
    const skipping = await sessions.launch({ kind: 'codex', cwd: repo })
    expect(vi.mocked(deps.pty.create).mock.calls[1][0].argv!.slice(-4)).toEqual([
      '-a',
      'never',
      '-s',
      'danger-full-access'
    ])
    expect(sessions.launchedBypassingChecks(skipping.id)).toBe(true)
    bind(1, B)
    await sessions.stop(skipping.id)

    const stillAsking = await sessions.resume({ sessionId: codexSessionKey(A), cwd: repo })
    expect(sessions.launchedBypassingChecks(stillAsking.id)).toBe(false)
    expect(transports[2].options.configOverrides).not.toContain('approval_policy="never"')

    skip = false
    const stillSkipping = await sessions.resume({ sessionId: codexSessionKey(B), cwd: repo })
    expect(sessions.launchedBypassingChecks(stillSkipping.id)).toBe(true)
    expect(transports[3].options.configOverrides).toEqual(
      expect.arrayContaining(['approval_policy="never"', 'sandbox_mode="danger-full-access"'])
    )
  })

  // CODEX§14
  it('a scheduled launch hands Codex its task as the first prompt with its model and thinking level, and reports the bind so the run stops counting as starting', async () => {
    const { id } = await sessions.launch({
      kind: 'codex',
      cwd: repo,
      scheduled: true,
      permission: 'bypass',
      model: 'gpt-5.5',
      effort: 'high',
      firstPrompt: '/daily-report now'
    })
    const argv = vi.mocked(deps.pty.create).mock.calls[0][0].argv!
    expect(argv.slice(-9)).toEqual([
      '-a',
      'never',
      '-s',
      'danger-full-access',
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="high"',
      '/daily-report now'
    ])
    const bound = { type: 'bound', key: codexSessionKey(A) }
    expect(deps.events).not.toHaveBeenCalledWith(id, bound)
    bind()
    expect(deps.events).toHaveBeenCalledWith(id, bound)
  })

  it('the app-server kept for history questions holds the quit until it is closed, also with no Codex tab open', async () => {
    expect(sessions.hasProcesses()).toBe(false)
    await sessions.historyRows(repo)
    expect(sessions.hasProcesses()).toBe(true)
    await sessions.stopAll()
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(sessions.hasProcesses()).toBe(false)
  })

  // CODEX§15
  it("a remote tab's sign-in renewal asks an app-server that reads the account's sign-in afresh, not the one kept for its side questions", async () => {
    const home = path.join(directory, 'work-home')
    fs.mkdirSync(home)
    const signIn = (token: string) =>
      fs.writeFileSync(
        path.join(home, 'auth.json'),
        JSON.stringify({ tokens: { access_token: token, account_id: 'acct' } })
      )
    signIn('old')
    mocks.request.mockImplementation(async (method, params) => {
      if (method === 'account/read' && params.refreshToken) signIn('new')
      return { account: {} }
    })
    await sessions.readAccount(home)
    const login = (
      sessions as unknown as { machineLogin(home: string): MachineLogin }
    ).machineLogin(home)
    await expect(login.refreshed('old')).resolves.toMatchObject({ accessToken: 'new' })
    expect(mocks.rpcHomes).toEqual([home, home])
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('cancels launches waiting on availability when shutdown starts and performs no refresh', async () => {
    const gate = deferred<{ id: 'codex'; available: boolean }>()
    vi.mocked(sessions.availability).mockReturnValueOnce(gate.promise)
    const launch = sessions.launch({ kind: 'codex', cwd: repo })
    expect(sessions.hasProcesses()).toBe(true)
    const rejected = expect(launch).rejects.toThrow('shutting down')
    const shutdown = sessions.stopAll()
    gate.resolve({ id: 'codex', available: true })
    await rejected
    await shutdown
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('stops an already-created transport if shutdown happens before PTY creation', async () => {
    const gate = deferred<{ url: string; stop: () => Promise<void> }>()
    const stop = vi.fn(async () => {})
    const created = deferred<void>()
    mocks.create.mockImplementationOnce(() => {
      created.resolve()
      return gate.promise
    })
    const launch = sessions.launch({ kind: 'codex', cwd: repo })
    await created.promise
    const rejected = expect(launch).rejects.toThrow('shutting down')
    const shutdown = sessions.stopAll()
    gate.resolve({ url: 'unix:///test/rpc.sock', stop })
    await rejected
    await shutdown
    expect(stop).toHaveBeenCalledOnce()
    expect(deps.pty.create).not.toHaveBeenCalled()
  })

  it('probes the Codex CLI once and keeps the answer', async () => {
    const fresh = new CodexSessions(path.join(directory, 'probe.json'), deps)
    expect(await fresh.availability()).toMatchObject({
      available: true,
      version: MIN_CODEX_VERSION,
      verified: true
    })
    await fresh.availability()
    expect(mocks.runtime).toHaveBeenCalledTimes(1)
    expect(await fresh.availability({ force: true })).toMatchObject({ available: true })
    expect(mocks.runtime).toHaveBeenCalledTimes(2)
  })

  it('waits a minute before probing again after Codex was not found', async () => {
    vi.useFakeTimers()
    const fresh = new CodexSessions(path.join(directory, 'probe.json'), deps)
    mocks.runtime.mockRejectedValue(new Error('Codex is not installed'))
    expect(await fresh.availability()).toMatchObject({
      available: false,
      reason: 'Codex is not installed'
    })
    vi.advanceTimersByTime(59_000)
    await fresh.availability()
    expect(mocks.runtime).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2_000)
    await fresh.availability()
    expect(mocks.runtime).toHaveBeenCalledTimes(2)
  })

  it('a Codex older than the minimum is updated once, even when two checks ask at the same moment, and is then offered', async () => {
    const fresh = new CodexSessions(path.join(directory, 'probe.json'), deps)
    mocks.runtime.mockResolvedValueOnce(TOO_OLD)
    const [first, second] = await Promise.all([fresh.availability(), fresh.availability()])
    expect(first).toMatchObject({ available: true, version: MIN_CODEX_VERSION })
    expect(second).toBe(first)
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(mocks.update).toHaveBeenCalledWith(TOO_OLD)
    expect(vi.mocked(deps.error).mock.calls[0][0]).toContain(`older than ${MIN_CODEX_VERSION}`)
  })

  it('a Codex the update cannot lift stays unavailable, says to run codex update, and is not updated again', async () => {
    vi.useFakeTimers()
    const fresh = new CodexSessions(path.join(directory, 'probe.json'), deps)
    mocks.runtime.mockResolvedValue(TOO_OLD)
    const reply = await fresh.availability()
    expect(reply).toMatchObject({ available: false })
    expect(reply.reason).toContain('codex update')
    expect(vi.mocked(deps.error).mock.lastCall?.[0]).toContain('codex update')
    vi.advanceTimersByTime(61_000)
    await fresh.availability()
    expect(mocks.runtime).toHaveBeenCalledTimes(3)
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(deps.error).toHaveBeenCalledTimes(2)
  })

  it('gives up on a run that never finishes stopping so the app can quit', async () => {
    const launched = await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    const gate = deferred<void>()
    transports[0].stop.mockReturnValueOnce(gate.promise)
    vi.useFakeTimers()
    let quit = false
    const shutdown = sessions.stopAll(5000).then(() => (quit = true))
    await vi.advanceTimersByTimeAsync(4_900)
    expect(quit).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    await shutdown
    expect(quit).toBe(true)
    expect(sessions.hasTab(launched.id)).toBe(true)
    vi.useRealTimers()
    gate.resolve()
  })

  it('rejects a Claude or a Muse identity at the Codex resume boundary', async () => {
    await expect(sessions.resume({ sessionId: A, cwd: repo })).rejects.toThrow(
      'A Codex session is required'
    )
    await expect(sessions.resume({ sessionId: `muse:local:${A}`, cwd: repo })).rejects.toThrow(
      'A Codex session is required'
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
