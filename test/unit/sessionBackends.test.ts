import { describe, expect, it, vi } from 'vitest'
import { SessionBackends, type SessionBackend } from '../../src/main/sessionBackends'
import { effectiveBackend, identityOf, sessionKey } from '@shared/sessionBackend'
import type { BackendId } from '@shared/types'

describe('session backend boundary', () => {
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
    const backend: SessionBackend = {
      id: 'codex',
      list: () => [],
      create,
      resume: async () => ({ ok: true, id: 'tab', cwd: '/repo' }),
      archive: () => true,
      transcriptExists: () => true
    }
    registry.register(backend)
    await expect(registry.create({ kind: 'codex', cwd: 'ssh://server/repo' })).resolves.toEqual({
      ok: false,
      code: 'invalid-args'
    })
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

// A1: every direct entrance (context menu, welcome ＋, single-workspace ⌘N,
// Onboarding's Start) launches through this, so it has to answer for a Mac that has
// only one of the two CLIs installed — settings alone cannot tell.
describe('effectiveBackend (what a direct entrance starts)', () => {
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
