import { describe, expect, it, vi } from 'vitest'
import { SessionBackends, type SessionBackend } from '../../src/main/sessionBackends'
import {
  capabilitiesFor,
  effectiveBackend,
  identityOf,
  sessionKey,
  SUPPORTED_PAIRS
} from '@shared/sessionBackend'
import type { BackendId, SessionRow } from '@shared/types'

function stubBackend(id: BackendId, rows: () => Promise<SessionRow[]> = async () => []) {
  return {
    id,
    availability: async () => ({ id, available: true }),
    list: () => [],
    historyRows: rows,
    create: async () => ({ ok: true as const, id: 'tab', cwd: '/repo' }),
    resume: async () => ({ ok: true as const, id: 'tab', cwd: '/repo' }),
    resumePlan: async () => ({ action: 'unavailable' as const, reason: 'not-found' as const }),
    hasTab: () => false,
    aliveTabFor: () => undefined,
    stop: () => {},
    archive: () => true,
    transcriptExists: () => true,
    observe: () => {}
  } satisfies SessionBackend
}

const row = (id: string, backendId: BackendId, mtime: number): SessionRow => ({
  id,
  backendId,
  host: 'local',
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
    registry.register(
      stubBackend('claude', async () => [row('a', 'claude', 1), row('b', 'claude', 3)])
    )
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

  it('gives a remote Claude session a Workbench but keeps agent open and browser control off', () => {
    const remote = capabilitiesFor('claude', 'ssh')
    expect(remote.workbench).toBe(true)
    expect(remote.agentOpen).not.toBe(true)
    expect(remote.browserControl).not.toBe(true)
  })

  it('marks the three-line status line unsupported for Codex, citing the ledger section that shows why', () => {
    expect(capabilitiesFor('codex', 'local').statusline3).toEqual({ unsupported: 'CODEX§8' })
    expect(capabilitiesFor('codex', 'local').workbench).toEqual({ pending: true })
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
