import { describe, expect, it, vi } from 'vitest'
import { SessionBackends, type SessionBackend } from '../../src/main/sessionBackends'
import {
  capabilitiesFor,
  effectiveBackend,
  identityOf,
  sessionKey,
  SUPPORTED_PAIRS
} from '@shared/sessionBackend'
import type { BackendId, BackendSessionInfo, BackendSessionRow } from '@shared/types'

function stubBackend(
  id: BackendId,
  rows: () => Promise<BackendSessionRow[]> = async () => [],
  sessions: BackendSessionInfo[] = []
) {
  return {
    id,
    availability: async () => ({ id, available: true }),
    list: () => sessions,
    historyRows: rows,
    create: async () => ({ ok: true as const, id: 'tab', cwd: '/repo' }),
    resume: async () => ({ ok: true as const, id: 'tab', cwd: '/repo' }),
    resumePlan: async () => ({ action: 'unavailable' as const, reason: 'not-found' as const }),
    hasTab: () => false,
    aliveTabFor: () => undefined,
    stop: () => {},
    archive: () => true,
    transcriptExists: () => true,
    observe: () => {},
    occupantOf: () => null,
    accountUsable: () => true,
    trustsFolder: () => true
  } satisfies SessionBackend
}

const row = (id: string, mtime: number): BackendSessionRow => ({
  id,
  title: id,
  cwd: '/repo',
  worktree: 'main',
  running: false,
  invalidCwd: false,
  mtime
})

describe('session backend boundary', () => {
  it('shows the history one method could read when another fails, newest first, and says which failed', async () => {
    const registry = new SessionBackends()
    registry.register(stubBackend('claude', async () => [row('a', 1), row('b', 3)]))
    registry.register(
      stubBackend('codex', async () => {
        throw new Error('app-server gone')
      })
    )
    const unread: BackendId[] = []
    const rows = await registry.historyRows('/repo', (id) => unread.push(id))
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
    expect(unread).toEqual(['codex'])
  })

  it('marks every session and history row with the method it came from and the machine it runs on', async () => {
    const registry = new SessionBackends()
    const session = (tabId: string, remote?: { host: string }): BackendSessionInfo => ({
      tabId,
      sessionId: tabId,
      title: tabId,
      cwd: '/repo',
      treeRoot: '/repo',
      alive: true,
      updatedAt: 1,
      ...(remote ? { remote } : {})
    })
    registry.register(
      stubBackend('claude', async () => [row('a', 1)], [session('t1', { host: 'devbox' })])
    )
    registry.register(stubBackend('codex', async () => [row('b', 2)], [session('t2')]))
    expect(registry.list().map((s) => [s.tabId, s.backendId, s.host])).toEqual([
      ['t1', 'claude', 'ssh'],
      ['t2', 'codex', 'local']
    ])
    const rows = await registry.historyRows('ssh://devbox/repo', () => {})
    expect(rows.map((r) => [r.id, r.backendId, r.host])).toEqual([
      ['b', 'codex', 'ssh'],
      ['a', 'claude', 'ssh']
    ])
  })

  it('fails the history read when no method could read anything', async () => {
    const registry = new SessionBackends()
    registry.register(
      stubBackend('codex', async () => {
        throw new Error('app-server gone')
      })
    )
    await expect(registry.historyRows('/repo', () => {})).rejects.toThrow('app-server gone')
  })

  it('keeps native ids from different backends separate and accepts legacy Claude references', () => {
    const nativeSessionId = '00000000-0000-4000-8000-000000000001'
    const claude = sessionKey({ backendId: 'claude', sourceId: 'local', nativeSessionId })
    const codex = sessionKey({ backendId: 'codex', sourceId: 'local', nativeSessionId })
    expect(claude).not.toBe(codex)
    expect(identityOf(codex)).toEqual({ backendId: 'codex', sourceId: 'local', nativeSessionId })
    expect(identityOf(nativeSessionId).backendId).toBe('claude')
  })

  it('refuses implicit/new unsupported launches before reaching any backend', async () => {
    const registry = new SessionBackends()
    const create = vi.fn(async () => ({ ok: true as const, id: 'tab', cwd: '/repo' }))
    const backend: SessionBackend = { ...stubBackend('codex'), create }
    registry.register(backend)
    await expect(registry.create({ kind: 'codex', cwd: 'ssh://server/repo' })).rejects.toThrow(
      'Codex sessions cannot run on a remote machine yet.'
    )
    await expect(registry.create({ kind: undefined as never, cwd: '/repo' })).resolves.toEqual({
      ok: false,
      code: 'invalid-args'
    })
    expect(create).not.toHaveBeenCalled()
    await expect(registry.create({ kind: 'codex', cwd: '/repo' })).resolves.toMatchObject({
      ok: true
    })
    expect(registry.forSession('codex:local:id')).toBe(backend)
  })
})

describe('capabilitiesFor (what one session can do, from its method and the machine it runs on)', () => {
  it('gives a Claude session on this Mac every capability', () => {
    expect(Object.values(capabilitiesFor('claude', 'local')).every((c) => c === true)).toBe(true)
  })

  it('gives a remote Claude session a Workbench and scheduled tasks but keeps agent open and browser control off', () => {
    const remote = capabilitiesFor('claude', 'ssh')
    expect(remote.workbench).toBe(true)
    expect(remote.scheduledTasks).toBe(true)
    expect(remote.agentOpen).not.toBe(true)
    expect(remote.browserControl).not.toBe(true)
  })

  it('gives a Codex session on this Mac a Workbench, accounts and scheduled tasks, and marks the three-line status line unsupported, citing the ledger section that shows why', () => {
    expect(capabilitiesFor('codex', 'local').workbench).toBe(true)
    expect(capabilitiesFor('codex', 'local').scheduledTasks).toBe(true)
    expect(capabilitiesFor('codex', 'local').accounts).toBe(true)
    expect(capabilitiesFor('codex', 'local').statusline3).toEqual({ unsupported: 'CODEX§8' })
  })

  it('supports every pair but Codex on a remote machine', () => {
    expect(SUPPORTED_PAIRS).toEqual({
      claude: { local: true, ssh: true },
      codex: { local: true, ssh: false }
    })
  })
})

describe('effectiveBackend (what every direct entrance starts on a Mac that may have only one of the two CLIs)', () => {
  const methods = (defaultBackend: BackendId, codex = true) => ({
    defaultBackend,
    enabled: { claude: true, codex }
  })
  const have = (...ids: BackendId[]): ReadonlySet<BackendId> => new Set(ids)

  it('takes the saved default whenever it can run', () => {
    expect(effectiveBackend(methods('claude'), have('claude', 'codex'))).toBe('claude')
    expect(effectiveBackend(methods('codex'), have('claude', 'codex'))).toBe('codex')
  })

  it('starts the only method there is when the default is not installed', () => {
    expect(effectiveBackend(methods('claude'), have('codex'))).toBe('codex')
    expect(effectiveBackend(methods('codex'), have('claude'))).toBe('claude')
  })

  it('ignores an installed method the user switched off', () => {
    expect(effectiveBackend(methods('claude', false), have('codex'))).toBe('claude')
  })

  it('keeps the default when nothing is installed — main refuses it and says why', () => {
    expect(effectiveBackend(methods('codex'), have())).toBe('codex')
  })
})
