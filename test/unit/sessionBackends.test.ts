import { describe, expect, it, vi } from 'vitest'
import { SessionBackends, type SessionBackend } from '../../src/main/sessionBackends'
import { sessionEventFromHook } from '../../src/main/sessionTracker'
import {
  capabilitiesFor,
  effectiveBackend,
  identityOf,
  launchMenus,
  SESSION_BACKENDS,
  sessionKey,
  shownAsInstalled,
  type Capabilities
} from '@shared/sessionBackend'
import type { BackendId, BackendSessionInfo, BackendSessionRow, HostId } from '@shared/types'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'

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
    forgetAvailability: () => {},
    resumePlan: async () => ({ action: 'unavailable' as const, reason: 'not-found' as const }),
    hasTab: () => false,
    workspaceOfTab: () => undefined,
    aliveTabFor: () => undefined,
    stop: () => {},
    archive: () => true,
    adopt: () => {},
    transcriptExists: () => true,
    observe: () => {},
    occupantOf: () => null,
    accountUsable: () => true,
    trustsFolder: () => true,
    turns: async () => [],
    transcriptPlaces: () => undefined,
    permissionClass: () => 'prompting' as const,
    peerNames: () => async () => null,
    runningElsewhere: () => false
  } satisfies SessionBackend
}

const lifecycle = () => ({
  prompted: vi.fn(),
  bound: vi.fn(),
  exited: vi.fn(),
  clearAttention: vi.fn(),
  open: vi.fn(),
  turnEnded: vi.fn(),
  asked: vi.fn()
})

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
    const registry = new SessionBackends(lifecycle())
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
    const registry = new SessionBackends(lifecycle())
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

  it('marks the butler’s session, by its tab or its session id, and never offers the butler’s session from history', async () => {
    const registry = new SessionBackends(lifecycle())
    registry.isButlerSession = (id) => id === 'conductor-tab' || id === 'old-conductor-session'
    const session = (tabId: string, sessionId: string): BackendSessionInfo => ({
      tabId,
      sessionId,
      title: tabId,
      cwd: '/repo',
      treeRoot: '/repo',
      alive: true,
      updatedAt: 1
    })
    registry.register(
      stubBackend('claude', async () => [row('old-conductor-session', 1), row('plain', 2)], [
        session('conductor-tab', 'new'),
        session('t2', 'old-conductor-session'),
        session('t3', 'x')
      ])
    )
    expect(registry.list().map((s) => s.butler)).toEqual([true, true, false])
    expect((await registry.historyRows('/repo', () => {})).map((r) => r.id)).toEqual(['plain'])
  })

  it('fails the history read when no method could read anything', async () => {
    const registry = new SessionBackends(lifecycle())
    registry.register(
      stubBackend('codex', async () => {
        throw new Error('app-server gone')
      })
    )
    await expect(registry.historyRows('/repo', () => {})).rejects.toThrow('app-server gone')
  })

  it('keeps native ids from different backends separate, Muse included, and accepts legacy Claude references', () => {
    const nativeSessionId = '00000000-0000-4000-8000-000000000001'
    const claude = sessionKey({ backendId: 'claude', sourceId: 'local', nativeSessionId })
    const codex = sessionKey({ backendId: 'codex', sourceId: 'local', nativeSessionId })
    expect(claude).not.toBe(codex)
    expect(identityOf(codex)).toEqual({ backendId: 'codex', sourceId: 'local', nativeSessionId })
    const muse = sessionKey({ backendId: 'muse', sourceId: 'local', nativeSessionId })
    expect(identityOf(muse)).toEqual({ backendId: 'muse', sourceId: 'local', nativeSessionId })
    expect(identityOf(nativeSessionId).backendId).toBe('claude')
  })

  it('refuses a launch with no method before reaching any backend, and hands a Codex launch here or on a machine to Codex', async () => {
    const registry = new SessionBackends(lifecycle())
    const create = vi.fn(async () => ({ ok: true as const, id: 'tab', cwd: '/repo' }))
    const backend: SessionBackend = { ...stubBackend('codex'), create }
    registry.register(backend)
    await expect(registry.create({ kind: undefined as never, cwd: '/repo' })).resolves.toEqual({
      ok: false,
      code: 'invalid-args'
    })
    expect(create).not.toHaveBeenCalled()
    await expect(registry.create({ kind: 'codex', cwd: '/repo' })).resolves.toMatchObject({
      ok: true
    })
    await expect(
      registry.create({ kind: 'codex', cwd: 'ssh://server/repo' })
    ).resolves.toMatchObject({ ok: true })
    expect(create).toHaveBeenCalledTimes(2)
    expect(registry.forSession('codex:local:id')).toBe(backend)
    expect(registry.forSession('codex:server:id')).toBe(backend)
  })

  // ADR-0030
  it('refuses a new session whose tool has no usable Koloft account, saying where to add one, before reaching the backend', async () => {
    const registry = new SessionBackends(lifecycle())
    const create = vi.fn(async () => ({ ok: true as const, id: 'tab', cwd: '/repo' }))
    registry.register({ ...stubBackend('codex'), create, accountUsable: () => false })
    await expect(registry.create({ kind: 'codex', cwd: '/repo' })).rejects.toThrow(
      NO_USABLE_ACCOUNT.codex
    )
    expect(create).not.toHaveBeenCalled()
  })
})

describe('session lifecycle tap (one place turns a bind or an exit into attention)', () => {
  it('raises no exited mark for a tab that ended cleanly less than 30 s ago, and raises it again once 30 s passed or a new session bound there', () => {
    vi.useFakeTimers()
    try {
      const sink = lifecycle()
      const registry = new SessionBackends(sink)
      registry.observe('tab', { type: 'exited', clean: true })
      expect(sink.clearAttention).toHaveBeenCalledWith('tab')
      registry.observe('tab', { type: 'exited', clean: false, title: 'late sweep' })
      expect(sink.exited).not.toHaveBeenCalled()

      registry.observe('tab', { type: 'bound', key: 'next' })
      registry.observe('tab', {
        type: 'exited',
        clean: false,
        title: 'after bind',
        sessionId: 'next-sid'
      })
      expect(sink.exited).toHaveBeenLastCalledWith('tab', {
        title: 'after bind',
        sessionId: 'next-sid'
      })

      registry.observe('other', { type: 'exited', clean: true })
      vi.advanceTimersByTime(30_001)
      registry.observe('other', { type: 'exited', clean: false, title: 'much later' })
      expect(sink.exited).toHaveBeenLastCalledWith('other', { title: 'much later' })
    } finally {
      vi.useRealTimers()
    }
  })

  // CC§14
  it('a dialog recorded in the status log of a session on another machine reaches the lifecycle with its whole question', () => {
    const sink = lifecycle()
    const registry = new SessionBackends(sink)
    const ask = { tool_name: 'Bash', tool_input: { command: 'make' } }
    registry.observe('tab', sessionEventFromHook('ask', undefined, undefined, ask)!)
    expect(sink.asked).toHaveBeenCalledWith('tab', ask)
    expect(sessionEventFromHook('ask', undefined, undefined, undefined)).toBeNull()
  })
})

describe('capabilitiesFor (what one session can do, from its method and the machine it runs on)', () => {
  it('gives a Claude session on this Mac every capability', () => {
    expect(Object.values(capabilitiesFor('claude', 'local')).every((c) => c === true)).toBe(true)
  })

  it('gives a remote Claude session a Workbench, scheduled tasks and the koloft command', () => {
    const remote = capabilitiesFor('claude', 'ssh')
    expect(remote.workbench).toBe(true)
    expect(remote.scheduledTasks).toBe(true)
    expect(remote.agentTools).toBe(true)
  })

  const ROWS_ONLY_SOME_TABS_HAVE: [string, keyof Capabilities, string[]][] = [
    [
      "Koloft's ask hook holds a question until Discord answers it only in a Claude Code tab on this Mac; on a machine the hook only records it and a Discord button presses the key, and other agents have no such hook",
      'askHookWaitsForDiscord',
      ['claude/local']
    ],
    [
      'Koloft sees whether a menu or panel is open in Claude Code on this Mac (its session registry) and in Muse anywhere (its screen); in every other tab a slash command from Discord presses Esc to be safe',
      'panelSeen',
      ['claude/local', 'muse/local', 'muse/ssh']
    ],
    [
      'Koloft follows Claude Code removing its worktree at /exit, and says so when it fails, on this Mac and on a machine, where its tmux passes the title code on; other agents remove no worktree at exit',
      'worktreeRemovalFollowed',
      ['claude/local', 'claude/ssh']
    ],
    [
      'every tab on this Mac drives the Workbench browser, and on a machine only Claude Code does, through a tunnel on its ssh connection and the playwright-cli Koloft installs there; the other agents there are not probed yet',
      'browserControl',
      ['claude/local', 'claude/ssh', 'codex/local', 'muse/local', 'agy/local']
    ]
  ]
  const sharedRowsOf = (backend: BackendId, host: HostId): Partial<Capabilities> =>
    Object.fromEntries(
      Object.entries(capabilitiesFor(backend, host)).filter(
        ([row]) => !ROWS_ONLY_SOME_TABS_HAVE.some(([, only]) => only === row)
      )
    )
  const HOSTS: HostId[] = ['local', 'ssh']

  it('gives a Codex, Muse or Antigravity session on this Mac a Workbench, scheduled tasks, the koloft command and browser control', () => {
    for (const backend of SESSION_BACKENDS)
      expect(sharedRowsOf(backend, 'local')).toEqual(sharedRowsOf('claude', 'local'))
  })

  // CODEX§16
  it('gives a remote Codex, Muse or Antigravity tab what a remote Claude tab has', () => {
    for (const backend of SESSION_BACKENDS)
      expect(sharedRowsOf(backend, 'ssh')).toEqual(sharedRowsOf('claude', 'ssh'))
  })

  // CC§4 CC§11 CC§14
  it.each(ROWS_ONLY_SOME_TABS_HAVE)('%s', (_rule, row, on) => {
    const tabsWithIt = SESSION_BACKENDS.flatMap((backend) =>
      HOSTS.filter((host) => capabilitiesFor(backend, host)[row] === true).map(
        (host) => `${backend}/${host}`
      )
    )
    expect(tabsWithIt).toEqual(on)
  })
})

describe('shownAsInstalled (which tools a dialog offers while the installed-tools check is out)', () => {
  it('counts only Claude Code before the first answer, then goes by the answer', () => {
    expect(shownAsInstalled(null, 'claude')).toBe(true)
    expect(shownAsInstalled(null, 'codex')).toBe(false)
    const onlyCodex = [
      { id: 'claude' as const, available: false },
      { id: 'codex' as const, available: true }
    ]
    expect(shownAsInstalled(onlyCodex, 'claude')).toBe(false)
    expect(shownAsInstalled(onlyCodex, 'codex')).toBe(true)
  })
})

const methods = (defaultBackend: BackendId, codex = true) => ({
  defaultBackend,
  enabled: { claude: true, codex, muse: true, agy: true }
})

describe('effectiveBackend (what every direct entrance starts on a Mac that may have only one of the two CLIs)', () => {
  const have = (...ids: BackendId[]): ReadonlySet<BackendId> => new Set(ids)

  it('takes the saved default whenever it can run', () => {
    expect(effectiveBackend(methods('claude'), have('claude', 'codex'))).toBe('claude')
    expect(effectiveBackend(methods('codex'), have('claude', 'codex'))).toBe('codex')
  })

  it('starts the only method there is when the default is not installed', () => {
    expect(effectiveBackend(methods('claude'), have('codex'))).toBe('codex')
    expect(effectiveBackend(methods('codex'), have('claude'))).toBe('claude')
  })

  it('starts the first method that can run when the default cannot and several can', () => {
    expect(effectiveBackend(methods('claude'), have('codex', 'muse'))).toBe('codex')
    expect(effectiveBackend(methods('muse'), have('claude', 'codex'))).toBe('claude')
  })

  it('ignores an installed method the user switched off', () => {
    expect(effectiveBackend(methods('claude', false), have('codex'))).toBe('claude')
  })

  it('keeps the default when nothing is installed — main refuses it and says why', () => {
    expect(effectiveBackend(methods('codex'), have())).toBe('codex')
  })
})

describe('launchMenus (the agents a New session menu offers, by where the workspace is)', () => {
  const only =
    (...ids: BackendId[]) =>
    (b: BackendId): boolean =>
      ids.includes(b)

  it('with only Codex on this Mac, a local workspace offers Codex alone while a remote one offers Claude Code first, then Codex', () => {
    const menus = launchMenus(methods('claude'), only('codex'))
    expect(menus.local).toEqual({ listed: ['codex'], named: null, sole: 'codex' })
    expect(menus.ssh).toEqual({
      listed: ['claude', 'codex'],
      named: ['claude', 'codex'],
      sole: 'claude'
    })
  })

  it('a remote workspace offers Codex, Muse and Antigravity only when this Mac has them, as their tabs need this Mac', () => {
    expect(launchMenus(methods('muse'), only()).ssh).toEqual({
      listed: ['claude'],
      named: null,
      sole: 'claude'
    })
    expect(launchMenus(methods('claude'), only('codex', 'muse', 'agy')).ssh.listed).toEqual([
      'claude',
      'codex',
      'muse',
      'agy'
    ])
  })
})
