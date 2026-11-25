import { describe, expect, it, vi } from 'vitest'
import { SessionBackends, type SessionBackend } from '../../../../src/core/agent/sessionBackends'
import { rowsKeptInMemory } from '../../../../src/agents/kit/main/rowsKeptInMemory'
import { sessionEventFromHook } from '../../../../src/agents/claude/main/sessionTracker'
import {
  capabilitiesFor,
  effectiveBackend,
  identityOf,
  launchMenus,
  messagingOf,
  reachedBySendMessage,
  SESSION_BACKENDS,
  sessionKey,
  shownAsInstalled,
  turnedOffLine,
  type Capabilities
} from '@shared/sessionBackend'
import type { BackendId, BackendSessionInfo, BackendSessionRow, HostId } from '@shared/types'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import { agentManifest } from '@core/agent/registry'
import { coversTerminalWhileResuming } from '../../../../src/renderer/src/agentUi'
import { lifecycle, stubBackend } from '../../helpers/sessionBackendStub'

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
    registry.isKoloftsOwnSession = (id) => id === 'conductor-tab' || id === 'old-conductor-session'
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
    expect(registry.list().map((s) => s.overseer)).toEqual([true, true, false])
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

  it('keeps native ids from different backends separate and accepts legacy Claude references', () => {
    const nativeSessionId = '00000000-0000-4000-8000-000000000001'
    const claude = sessionKey({ backendId: 'claude', sourceId: 'local', nativeSessionId })
    const codex = sessionKey({ backendId: 'codex', sourceId: 'local', nativeSessionId })
    expect(claude).not.toBe(codex)
    expect(identityOf(codex)).toEqual({ backendId: 'codex', sourceId: 'local', nativeSessionId })
    const agy = sessionKey({ backendId: 'agy', sourceId: 'local', nativeSessionId })
    expect(identityOf(agy)).toEqual({ backendId: 'agy', sourceId: 'local', nativeSessionId })
    expect(identityOf(nativeSessionId)?.backendId).toBe('claude')
  })

  it('refuses a launch with no method before reaching any backend, and hands a Codex launch here or on a machine to Codex', async () => {
    const registry = new SessionBackends(lifecycle())
    const create = vi.fn(async () => ({ ok: true as const, id: 'tab', cwd: '/repo' }))
    const backend: SessionBackend = {
      ...stubBackend('codex'),
      create,
      aliveTabFor: (key) => `tab of ${key}`
    }
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
    expect(registry.aliveTabFor('codex:local:id')).toBe('tab of codex:local:id')
    expect(registry.aliveTabFor('codex:server:id')).toBe('tab of codex:server:id')
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

  it('refuses a new session of an agent turned off in Settings ▸ Sessions, whatever started it, but still resumes one', async () => {
    const registry = new SessionBackends(lifecycle())
    const create = vi.fn(async () => ({ ok: true as const, id: 'tab', cwd: '/repo' }))
    registry.register({ ...stubBackend('codex'), create })
    registry.turnedOff = (b) => (b === 'codex' ? turnedOffLine(b) : null)
    await expect(registry.create({ kind: 'codex', cwd: '/repo' })).rejects.toThrow(
      'Codex is turned off in Settings ▸ Sessions'
    )
    expect(create).not.toHaveBeenCalled()
    await expect(
      registry.create({ kind: 'codex', cwd: '/repo', resumeSessionId: 'thread' })
    ).resolves.toMatchObject({ ok: true })
  })

  it('asks whether a panel is open only of the agent that lists a session in that tab, with the screen it was handed, and cannot say for a tab whose session is not listed yet', async () => {
    const registry = new SessionBackends(lifecycle())
    const asked: string[] = []
    const listing = (id: BackendId, tabId: string, alsoHolds?: string): SessionBackend => ({
      ...stubBackend(id, undefined, [
        { tabId, sessionId: `${id}-session`, cwd: '/repo' } as BackendSessionInfo
      ]),
      hasTab: (tab) => tab === tabId || tab === alsoHolds,
      showsAPanel: async (tab, screen) => {
        asked.push(`${id} ${tab} ${screen?.join('|') ?? 'no screen'}`)
        return true
      }
    })
    registry.register(listing('claude', 'tab-c'))
    registry.register(listing('codex', 'tab-x', 'tab-starting'))
    expect(await registry.showsAPanel('tab-x', ['a screen'])).toBe(true)
    expect(await registry.showsAPanel('tab-c')).toBe(true)
    expect(await registry.showsAPanel('tab-starting')).toBeUndefined()
    expect(asked).toEqual(['codex tab-x a screen', 'claude tab-c no screen'])
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
    expect(sink.asked).toHaveBeenCalledWith('tab', ask, expect.any(String))
    expect(sessionEventFromHook('ask', undefined, undefined, undefined)).toBeNull()
  })

  it('every question gets an id of its own: two asked one after the other in one tab differ, the same words included, and so do the questions of two tabs', () => {
    const sink = lifecycle()
    const registry = new SessionBackends(sink)
    const ask = { tool_name: 'Bash', tool_input: { command: 'make' } }
    for (const tab of ['tab', 'tab', 'other', 'tab'])
      registry.observe(tab, { type: 'asked', ask: { ...ask } })
    const ids = sink.asked.mock.calls.map((call): unknown => call[2])
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
  })
})

describe('capabilitiesFor (what one session can do, from its method and the machine it runs on)', () => {
  it('gives a Claude session on this Mac every capability', () => {
    expect(Object.values(capabilitiesFor('claude', 'local')).every((c) => c === true)).toBe(true)
  })

  const ROWS_ONLY_SOME_TABS_HAVE: [string, keyof Capabilities, string[]][] = [
    [
      "Koloft's ask hook holds a question until Discord answers it only in a Claude Code tab on this Mac; on a machine the hook only records it and a Discord button presses the key, and other agents have no such hook",
      'askHookWaitsForDiscord',
      ['claude/local']
    ],
    [
      'Koloft follows Claude Code removing its worktree at /exit, and says so when it fails, on this Mac and on a machine, where its tmux passes the title code on; other agents remove no worktree at exit',
      'worktreeRemovalFollowed',
      ['claude/local', 'claude/ssh']
    ],
    [
      'every tab on this Mac drives the Workbench browser, and on a machine only Claude Code does, through a tunnel on its ssh connection and the playwright-cli Koloft installs there; the other agents there are not probed yet',
      'browserControl',
      ['claude/local', 'claude/ssh', 'codex/local', 'agy/local']
    ]
  ]
  const HOSTS: HostId[] = ['local', 'ssh']

  it('holds no row that every kind of tab has: each row is listed above with the reason some tabs lack it', () => {
    expect(Object.keys(capabilitiesFor('claude', 'local')).sort()).toEqual(
      ROWS_ONLY_SOME_TABS_HAVE.map(([, row]) => row).sort()
    )
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

describe('coversTerminalWhileResuming (which resuming tabs get the "Resuming" cover over their terminal)', () => {
  // CODEX§9 AGY§5
  it('covers a Claude Code or Antigravity tab, and never a Codex one, whose question before it binds the cover would hide, nor a plain terminal', () => {
    const kinds = [...SESSION_BACKENDS, 'shell'] as const
    expect(kinds.filter(coversTerminalWhileResuming)).toEqual(['claude', 'agy'])
  })
})

describe('passedOnMessageShowsAsFromAnotherSession (the flag in each agent’s manifest that picks a half sentence of its prompt)', () => {
  // CC§13 CODEX§17 AGY§15 AGY§16
  it('is yes for exactly the agents Koloft reaches through their own channel for messages between sessions, on this Mac and on a machine', () => {
    const saysYes = SESSION_BACKENDS.filter(
      (b) => agentManifest(b).flags.passedOnMessageShowsAsFromAnotherSession
    )
    for (const remote of [false, true])
      expect(SESSION_BACKENDS.filter((b) => messagingOf(b, remote) === 'peerLine')).toEqual(saysYes)
  })
})

describe('koloft help on how sessions talk to each other', () => {
  // CC§13
  it('gets its line on an agent’s own message tool from exactly the agents whose sessions Koloft leaves to that tool, so the line and the names beside it cannot part', () => {
    const addsTheLine = SESSION_BACKENDS.filter((b) =>
      Object.hasOwn(agentManifest(b).slotAdditions, 'koloft-help-own-message-tool')
    )
    const addsTheExcept = SESSION_BACKENDS.filter((b) =>
      Object.hasOwn(agentManifest(b).slotAdditions, 'koloft-help-send-but-own-message-tool')
    )
    const leftToItsOwnTool = SESSION_BACKENDS.filter(reachedBySendMessage)
    expect(addsTheLine).toEqual(leftToItsOwnTool)
    expect(addsTheExcept).toEqual(leftToItsOwnTool)
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
  enabled: { claude: true, codex, agy: true }
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
    expect(effectiveBackend(methods('claude'), have('codex', 'agy'))).toBe('codex')
    expect(effectiveBackend(methods('agy'), have('claude', 'codex'))).toBe('claude')
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

  it('a remote workspace offers Codex and Antigravity only when this Mac has them, as their tabs need this Mac', () => {
    expect(launchMenus(methods('agy'), only()).ssh).toEqual({
      listed: ['claude'],
      named: null,
      sole: 'claude'
    })
    expect(launchMenus(methods('claude'), only('codex', 'agy')).ssh.listed).toEqual([
      'claude',
      'codex',
      'agy'
    ])
  })
})

describe('whether work a session started still runs after its turn ended', () => {
  it('is asked of the backend that owns the tab, and a tab no backend owns has none', async () => {
    const registry = new SessionBackends(lifecycle())
    registry.register({
      ...stubBackend('claude'),
      hasTab: (tabId) => tabId === 'busy',
      workStillRunning: async () => true
    })
    registry.register({ ...stubBackend('codex'), hasTab: (tabId) => tabId === 'done' })
    expect(await registry.workStillRunning('busy')).toBe(true)
    expect(await registry.workStillRunning('done')).toBe(false)
    expect(await registry.workStillRunning('nobodys')).toBe(false)
  })
})

describe('the rows every agent gives for a workspace', () => {
  const rowsOf = (id: BackendId): Pick<SessionBackend, 'rowsPass' | 'members' | 'usedFolders'> =>
    rowsKeptInMemory({
      rows: () => [
        {
          id: `${id}-row`,
          title: id,
          cwd: '/repo',
          worktree: 'main',
          running: true,
          invalidCwd: false,
          mtime: 1
        }
      ],
      members: () => new Set([`${id}-row`]),
      localHistoryFolders: async () => [
        { path: `/used-by-${id}`, sessions: 1, mtime: 1, agents: {} }
      ]
    })

  it('are asked for in the order of the list of agents, whatever order the agents were registered in, each marked with its agent; an agent that is not there is left out', async () => {
    const registry = new SessionBackends(lifecycle())
    const inRegistrationOrder: BackendId[] = [...SESSION_BACKENDS].reverse()
    for (const id of inRegistrationOrder) registry.register({ ...stubBackend(id), ...rowsOf(id) })
    const now = () => ({
      bindings: new Map<string, string>(),
      running: new Set<string>(),
      hidden: () => false
    })
    const place = { path: '/repo', realPath: '/repo', worktreeDirs: async () => [] }
    const asked = await registry.rows
      .rowsPass({ everywhere: true, bindings: new Map() })
      .in(place, now)
    expect(asked.map((answer) => answer.kept.map((r) => r.backendId))).toEqual(
      SESSION_BACKENDS.map((id) => [id])
    )
    expect((await registry.rows.usedFolders()).map((f) => f.path)).toEqual(
      SESSION_BACKENDS.map((id) => `/used-by-${id}`)
    )

    const withoutTheFirst = new SessionBackends(lifecycle())
    for (const id of SESSION_BACKENDS.slice(1))
      withoutTheFirst.register({ ...stubBackend(id), ...rowsOf(id) })
    expect([...withoutTheFirst.rows.members()]).toEqual(
      SESSION_BACKENDS.slice(1).map((id) => `${id}-row`)
    )
  })
})
