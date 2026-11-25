import { describe, expect, it } from 'vitest'
import {
  SessionBackends,
  type SessionBackend,
  type TabExit
} from '../../../../src/core/agent/sessionBackends'
import {
  KEEPS_NO_WORKTREE_RECORDS,
  type WorktreeRecords
} from '../../../../src/core/agent/worktreeRecords'
import { ClaudeBackend, type ClaudeBackendDeps } from '../../../../src/agents/claude/main/backend'
import { storedBackend } from '../../../../src/agents/kit/main/stored'
import { sessionKey } from '@shared/sessionBackend'
import type { BackendId, BackendSessionRow } from '@shared/types'
import { lifecycle } from '../../helpers/sessionBackendStub'

interface SessionsKeptInAStore {
  id: BackendId
  store: { flushSync(): void }
  worktrees: { records: WorktreeRecords }
  rows(workspace: string): BackendSessionRow[]
  threadGone(key: string): boolean
  hasProcesses(): boolean
  stopAll(): Promise<void>
  hasTab(tabId: string): boolean
  aliveTabFor(key: string): string | undefined
  stop(tabId: string, nativeExitCode?: number): Promise<void>
  showsPromptBeforeBind(tabId: string): boolean
}

function sessionsOf(id: BackendId, over: Partial<SessionsKeptInAStore> = {}): SessionsKeptInAStore {
  return {
    id,
    store: { flushSync: () => {} },
    worktrees: { records: KEEPS_NO_WORKTREE_RECORDS },
    rows: () => [],
    threadGone: () => false,
    hasProcesses: () => false,
    stopAll: async () => {},
    hasTab: () => false,
    aliveTabFor: () => undefined,
    stop: async () => {},
    showsPromptBeforeBind: () => false,
    ...over
  }
}

const NONE_OF_ITS_PARTS_IS_ASKED_HERE = {} as ClaudeBackendDeps
const NO_RESUME_IS_PLANNED_HERE = {} as Parameters<typeof storedBackend>[1]
const ITS_OWN_ANSWERS: Parameters<typeof storedBackend>[2] = {
  accountUsable: () => true,
  trustsFolder: () => true,
  turns: async () => [],
  peerNames: () => async () => null,
  runningElsewhere: () => false,
  showsAPanel: async () => undefined
}

function backendsOf(
  stored: SessionsKeptInAStore[],
  firstAgentTold: (tabId: string, crashed: boolean) => void = () => {}
): SessionBackends {
  const first = new ClaudeBackend(NONE_OF_ITS_PARTS_IS_ASKED_HERE)
  first.tabExited = ({ tabId, crashed }) => firstAgentTold(tabId, crashed)
  const inListOrder: SessionBackend[] = [
    first,
    ...stored.map((sessions) =>
      storedBackend(
        sessions as unknown as Parameters<typeof storedBackend>[0],
        NO_RESUME_IS_PLANNED_HERE,
        ITS_OWN_ANSWERS
      )
    )
  ]
  const backends = new SessionBackends(lifecycle())
  for (const backend of inListOrder.reverse()) backends.register(backend)
  return backends
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

function deferred(): Deferred {
  let resolve = (): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const everyPromiseStepRan = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const exitOf = (tabId: string, over: Partial<TabExit> = {}): TabExit => ({
  tabId,
  exitCode: 0,
  crashed: false,
  ...over
})

const withTabs = (
  id: BackendId,
  tabs: string[],
  said: string[],
  stopped: () => Promise<void> = async () => {}
): SessionsKeptInAStore =>
  sessionsOf(id, {
    hasTab: (tabId) => tabs.includes(tabId),
    stop: (tabId, code) => {
      if (!tabs.includes(tabId)) return Promise.resolve()
      said.push(`${id} stops ${tabId} with ${code}`)
      return stopped()
    }
  })

describe('a tab whose terminal ended, as the agents are told of it', () => {
  it('the first agent of the list hears of every tab, a plain terminal too; then the agent that has the tab ends it, with -1 for a signal and the exit code otherwise; all of it before the call returns', () => {
    const said: string[] = []
    const backends = backendsOf(
      [withTabs('codex', ['t-codex'], said), withTabs('agy', ['t-agy'], said)],
      (tabId, crashed) => said.push(`claude hears ${tabId} ended, crashed ${crashed}`)
    )
    const noFailure = (error: unknown): void => void said.push(`failed ${String(error)}`)

    backends.tabExited(exitOf('t-codex', { signal: 15 }), noFailure)
    expect(said).toEqual([
      'claude hears t-codex ended, crashed false',
      'codex stops t-codex with -1'
    ])

    said.length = 0
    backends.tabExited(exitOf('t-agy', { exitCode: 3, crashed: true }), noFailure)
    expect(said).toEqual(['claude hears t-agy ended, crashed true', 'agy stops t-agy with 3'])

    said.length = 0
    backends.tabExited(exitOf('t-shell'), noFailure)
    expect(said).toEqual(['claude hears t-shell ended, crashed false'])
  })

  it('an agent whose ending of the tab fails later hands that failure to the caller, and one that ends it well hands nothing', async () => {
    const said: string[] = []
    const failures: unknown[] = []
    const backends = backendsOf([
      withTabs('codex', ['t-codex'], said, async () => {
        throw new Error('the app-server would not close')
      }),
      withTabs('agy', ['t-agy'], said)
    ])
    backends.tabExited(exitOf('t-agy'), (error) => failures.push(error))
    backends.tabExited(exitOf('t-codex'), (error) => failures.push(error))
    await everyPromiseStepRan()
    expect(failures.map(String)).toEqual(['Error: the app-server would not close'])
  })

  it('an agent that was not built is passed over: the others still hear of the tab', () => {
    const said: string[] = []
    const backends = backendsOf([withTabs('codex', ['t-codex'], said)], (tabId) =>
      said.push(`claude hears ${tabId} ended`)
    )
    backends.tabExited(exitOf('t-codex', { exitCode: 1 }), () => {})
    backends.tabExited(exitOf('a-tab-of-the-agent-that-was-not-built'), () => {})
    expect(said).toEqual([
      'claude hears t-codex ended',
      'codex stops t-codex with 1',
      'claude hears a-tab-of-the-agent-that-was-not-built ended'
    ])
  })
})

describe('quitting Koloft, as the agents are asked about it', () => {
  it('goes ahead at once when no agent has anything that must end first, and ends nothing', () => {
    const said: string[] = []
    const backends = backendsOf([
      sessionsOf('codex', { stopAll: async () => void said.push('codex ends') }),
      sessionsOf('agy', { stopAll: async () => void said.push('agy ends') })
    ])
    const waits = backends.holdsQuitUntilAgentsEnded(
      () => said.push('quit again'),
      () => said.push('failed')
    )
    expect(waits).toBe(false)
    expect(said).toEqual([])
  })

  it('is held when one agent must be waited for; every agent is then asked to end, once, the one that had nothing too; the app quits again only after all of them ended, and one that fails is named and does not stop the others', async () => {
    const said: string[] = []
    const codexEnded = deferred()
    const agyEnded = deferred()
    const backends = backendsOf([
      sessionsOf('codex', {
        hasProcesses: () => true,
        stopAll: () => {
          said.push('codex ends')
          return codexEnded.promise
        }
      }),
      sessionsOf('agy', {
        stopAll: () => {
          said.push('agy ends')
          return agyEnded.promise
        }
      })
    ])
    const quitAgain = (): void => void said.push('quit again')
    const failed = (backend: BackendId, error: unknown): void =>
      void said.push(`${backend} failed: ${String(error)}`)

    expect(backends.holdsQuitUntilAgentsEnded(quitAgain, failed)).toBe(true)
    expect(backends.holdsQuitUntilAgentsEnded(quitAgain, failed)).toBe(true)
    expect(said).toEqual(['codex ends', 'agy ends'])

    agyEnded.reject(new Error('its tmux would not answer'))
    await everyPromiseStepRan()
    expect(said).toEqual(['codex ends', 'agy ends', 'agy failed: Error: its tmux would not answer'])

    codexEnded.resolve()
    await everyPromiseStepRan()
    expect(said.slice(3)).toEqual(['quit again'])

    expect(backends.holdsQuitUntilAgentsEnded(quitAgain, failed)).toBe(false)
    expect(said).toHaveLength(4)
  })

  it('waits for the last agent as it does for the first', async () => {
    const said: string[] = []
    const agyEnded = deferred()
    const backends = backendsOf([
      sessionsOf('codex', { hasProcesses: () => true }),
      sessionsOf('agy', { stopAll: () => agyEnded.promise })
    ])
    const quitAgain = (): void => void said.push('quit again')
    expect(backends.holdsQuitUntilAgentsEnded(quitAgain, () => {})).toBe(true)
    await everyPromiseStepRan()
    expect(said).toEqual([])
    agyEnded.resolve()
    await everyPromiseStepRan()
    expect(said).toEqual(['quit again'])
  })

  it('an agent that was not built is passed over: the quit is held for the one that is there, and goes ahead when that one has nothing', async () => {
    const said: string[] = []
    let codexHasWork = false
    const backends = backendsOf([
      sessionsOf('codex', {
        hasProcesses: () => codexHasWork,
        stopAll: async () => void said.push('codex ends')
      })
    ])
    const quitAgain = (): void => void said.push('quit again')
    expect(backends.holdsQuitUntilAgentsEnded(quitAgain, () => {})).toBe(false)
    codexHasWork = true
    expect(backends.holdsQuitUntilAgentsEnded(quitAgain, () => {})).toBe(true)
    await everyPromiseStepRan()
    expect(said).toEqual(['codex ends', 'quit again'])
  })

  it('every agent that is there writes down what it still holds in memory, in the order of the list of agents; one that was not built is passed over', () => {
    const said: string[] = []
    const writesDown = (id: BackendId): SessionsKeptInAStore =>
      sessionsOf(id, { store: { flushSync: () => void said.push(`${id} wrote it down`) } })
    backendsOf([writesDown('codex'), writesDown('agy')]).flushSync()
    expect(said).toEqual(['codex wrote it down', 'agy wrote it down'])

    said.length = 0
    backendsOf([writesDown('agy')]).flushSync()
    expect(said).toEqual(['agy wrote it down'])
  })
})

const WORKSPACE = '/repo'

const rowOf = (id: string, over: Partial<BackendSessionRow> = {}): BackendSessionRow => ({
  id,
  title: id,
  cwd: WORKSPACE,
  worktree: 'main',
  running: false,
  invalidCwd: false,
  mtime: 1,
  ...over
})

describe('a workspace that is about to be removed, as the agents are told of it', () => {
  it('each agent’s running tabs and starting tabs there are stopped, each tab once, and the removal waits until every one of them has stopped; a session that is not running, and one in another workspace, are left alone', async () => {
    const said: string[] = []
    const stops = new Map<string, Deferred>()
    const stop = (id: BackendId) => (tabId: string, code?: number) => {
      said.push(`${id} stops ${tabId} with ${code}`)
      const stopped = deferred()
      stops.set(tabId, stopped)
      return stopped.promise
    }
    const backends = backendsOf([
      sessionsOf('codex', {
        rows: (workspace) =>
          workspace === WORKSPACE
            ? [
                rowOf('bound', { running: true }),
                rowOf('bound-again-in-the-same-tab', { running: true }),
                rowOf('t-starting', { pending: true }),
                rowOf('in-history'),
                rowOf('running-with-no-tab', { running: true })
              ]
            : [rowOf('elsewhere', { running: true })],
        aliveTabFor: (key) =>
          ({ bound: 't-bound', 'bound-again-in-the-same-tab': 't-bound', elsewhere: 't-else' })[
            key
          ],
        stop: stop('codex')
      }),
      sessionsOf('agy', {
        rows: (workspace) => (workspace === WORKSPACE ? [rowOf('convo', { running: true })] : []),
        aliveTabFor: (key) => (key === 'convo' ? 't-agy' : undefined),
        stop: stop('agy')
      })
    ])

    let removalMayGoOn = false
    const told = backends.beforeWorkspaceRemoved(WORKSPACE).then(() => (removalMayGoOn = true))
    expect(said).toEqual([
      'codex stops t-bound with undefined',
      'codex stops t-starting with undefined',
      'agy stops t-agy with undefined'
    ])

    stops.get('t-bound')!.resolve()
    stops.get('t-agy')!.resolve()
    await everyPromiseStepRan()
    expect(removalMayGoOn).toBe(false)

    stops.get('t-starting')!.resolve()
    await told
    expect(removalMayGoOn).toBe(true)
  })

  it('a tab that could not be stopped fails the call, so the workspace is not removed over it', async () => {
    const backends = backendsOf([
      sessionsOf('codex', {
        rows: () => [rowOf('t-starting', { pending: true })],
        stop: async () => {
          throw new Error('still starting')
        }
      })
    ])
    await expect(backends.beforeWorkspaceRemoved(WORKSPACE)).rejects.toThrow('still starting')
  })

  it('an agent that was not built is passed over, and with no agent that keeps tabs there is nothing to wait for', async () => {
    const said: string[] = []
    const backends = backendsOf([
      sessionsOf('agy', {
        rows: () => [rowOf('t-starting', { pending: true })],
        stop: async (tabId) => void said.push(`agy stops ${tabId}`)
      })
    ])
    await backends.beforeWorkspaceRemoved(WORKSPACE)
    expect(said).toEqual(['agy stops t-starting'])
    await expect(backendsOf([]).beforeWorkspaceRemoved(WORKSPACE)).resolves.toBeUndefined()
  })
})

describe('whether a tab that has no session yet already shows its prompt', () => {
  it('is yes only when the agent that has the tab says so; an agent that never shows its prompt that early, a tab of nobody’s and a tab of an agent that was not built are all no', () => {
    const showing = sessionsOf('agy', {
      hasTab: (tabId) => tabId.startsWith('t-agy'),
      showsPromptBeforeBind: (tabId) => tabId === 't-agy-at-its-prompt'
    })
    const backends = backendsOf([
      sessionsOf('codex', { hasTab: (tabId) => tabId === 't-codex' }),
      showing
    ])
    expect(backends.showsPromptBeforeBind('t-agy-at-its-prompt')).toBe(true)
    expect(backends.showsPromptBeforeBind('t-agy-still-starting')).toBe(false)
    expect(backends.showsPromptBeforeBind('t-codex')).toBe(false)
    expect(backends.showsPromptBeforeBind('t-shell')).toBe(false)
    expect(backendsOf([sessionsOf('codex')]).showsPromptBeforeBind('t-agy-at-its-prompt')).toBe(
      false
    )
  })
})

describe('whether a session Koloft remembers is still there', () => {
  const keyOf = (backendId: BackendId, nativeSessionId: string): string =>
    sessionKey({ backendId, sourceId: 'local', nativeSessionId })
  const CLAUDE_FOUND = 'a-session-with-a-transcript'
  const CLAUDE_NOT_FOUND = 'a-session-with-no-transcript-left'
  const goneOnes = (id: BackendId): SessionsKeptInAStore =>
    sessionsOf(id, { threadGone: (key) => key.endsWith(':gone') || key.endsWith(':asleep') })

  it('a session among the ones found on disk or running is there, whatever its agent says, so a sleeping tab whose agent no longer lists it is kept; any other is asked of its agent', () => {
    const backends = backendsOf([goneOnes('codex'), goneOnes('agy')])
    const foundOrRunning = new Set([CLAUDE_FOUND, keyOf('codex', 'asleep'), keyOf('agy', 'asleep')])
    const stillThere = (key: string): boolean => backends.sessionStillThere(key, foundOrRunning)

    expect(stillThere(CLAUDE_FOUND)).toBe(true)
    expect(stillThere(CLAUDE_NOT_FOUND)).toBe(false)
    for (const id of ['codex', 'agy'] as const) {
      expect(stillThere(keyOf(id, 'asleep')), id).toBe(true)
      expect(stillThere(keyOf(id, 'listed')), id).toBe(true)
      expect(stillThere(keyOf(id, 'gone')), id).toBe(false)
    }
  })

  it('a session of an agent that was not built counts as still there', () => {
    const backends = backendsOf([goneOnes('codex')])
    expect(backends.sessionStillThere(keyOf('agy', 'gone'), new Set())).toBe(true)
    expect(backends.sessionStillThere(keyOf('codex', 'gone'), new Set())).toBe(false)
  })
})
