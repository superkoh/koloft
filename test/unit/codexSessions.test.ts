import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexSessions, type CodexSessionDeps } from '../../src/main/codexSessions'
import { codexSessionKey, type WorktreeResource } from '../../src/main/sessionStore'
import type { CodexTransportOptions } from '../../src/main/codexTransport'
import { SessionRuntime } from '../../src/main/sessionRuntime'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  runtime: vi.fn()
}))
vi.mock('../../src/main/codexRuntime', () => ({ resolveCodexRuntime: mocks.runtime }))
vi.mock('../../src/main/codexTransport', () => ({
  createCodexTransport: mocks.create,
  CodexRpc: class {
    request = mocks.request
    close = mocks.close
  }
}))

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
let directory: string
let repo: string
let other: string
let sessions: CodexSessions
let deps: CodexSessionDeps
let transports: { options: CodexTransportOptions; stop: ReturnType<typeof vi.fn> }[]

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
  repo = path.join(directory, 'repo')
  other = path.join(directory, 'other')
  fs.mkdirSync(repo)
  fs.mkdirSync(other)
  transports = []
  mocks.create.mockImplementation(async (options: CodexTransportOptions) => {
    const stop = vi.fn(async () => {})
    transports.push({ options, stop })
    return { url: 'unix:///test/rpc.sock', stop }
  })
  mocks.request.mockResolvedValue({ data: [], nextCursor: null })
  mocks.close.mockResolvedValue(undefined)
  mocks.runtime.mockResolvedValue({
    binary: '/fixture/codex',
    env: {},
    version: '0.153.4',
    verified: true
  })
  let tab = 0
  deps = {
    pty: {
      create: vi.fn(() => ({ id: `pty-${++tab}` })),
      kill: vi.fn(),
      clearResumeIntent: vi.fn()
    } as unknown as CodexSessionDeps['pty'],
    runtime: new SessionRuntime(),
    projectInfo: (p) => ({ root: p.startsWith(repo) ? repo : other, treeRoot: p }),
    changed: vi.fn(),
    attention: vi.fn(),
    error: vi.fn()
  }
  sessions = new CodexSessions(path.join(directory, 'sessions.json'), deps)
  vi.spyOn(sessions, 'availability').mockResolvedValue({ id: 'codex', available: true })
})

afterEach(async () => {
  vi.useRealTimers()
  await sessions.stopAll()
  vi.restoreAllMocks()
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

  it('replaces membership on native new while keeping the former history available', async () => {
    await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    bind(0, B, repo, 2)
    expect(sessions.members().has(codexSessionKey(A))).toBe(false)
    expect(sessions.members().has(codexSessionKey(B))).toBe(true)
    expect(sessions.rows(repo).some((row) => row.id === codexSessionKey(A))).toBe(true)
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

  it('reports an unexpected exit after confirmed stop without immediately clearing the alert', async () => {
    const launched = await sessions.launch({ kind: 'codex', cwd: repo })
    bind()
    vi.mocked(deps.attention).mockClear()
    await sessions.stop(launched.id, 1)
    expect(deps.attention).toHaveBeenLastCalledWith(launched.id, 'exited')
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

  it('cancels launches waiting on availability when shutdown starts and performs no refresh', async () => {
    const gate = deferred<{ id: 'codex'; available: boolean }>()
    vi.mocked(sessions.availability).mockReturnValueOnce(gate.promise)
    const launch = sessions.launch({ kind: 'codex', cwd: repo })
    expect(sessions.hasRuns()).toBe(true)
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
      version: '0.153.4',
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

  it('rejects a Claude or remote identity at the Codex resume boundary', async () => {
    await expect(sessions.resume({ sessionId: A, cwd: repo })).rejects.toThrow('local Codex')
    await expect(sessions.resume({ sessionId: `codex:ssh:${A}`, cwd: repo })).rejects.toThrow(
      'local Codex'
    )
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
