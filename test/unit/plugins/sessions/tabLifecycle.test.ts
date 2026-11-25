import { describe, it, expect } from 'vitest'
import { SessionBackends } from '../../../../src/core/agent/sessionBackends'
import type { Moment, TabEnded } from '../../../../src/core/moment'
import {
  lifecycle as nothingListensToTheSessions,
  stubBackend
} from '../../helpers/sessionBackendStub'
import {
  TabLifecycle,
  subscribeTabSubsystems,
  type TabSubsystems
} from '../../../../src/plugins/sessions/main/tabLifecycle'

function wired(over: Partial<TabSubsystems> = {}): { lifecycle: TabLifecycle; calls: string[] } {
  const calls: string[] = []
  const say =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push([name, ...args.map(String)].join(' '))
    }
  const lifecycle = new TabLifecycle()
  subscribeTabSubsystems(lifecycle, {
    attention: {
      clear: say('attention.clear'),
      tabStopping: say('attention.tabStopping')
    },
    backends: {
      tabExited: ({ tabId, exitCode, signal, crashed }) =>
        say('backends.tabExited')(
          tabId,
          `code ${exitCode}`,
          `signal ${signal}`,
          `crashed ${crashed}`
        )
    },
    toast: say('toast'),
    workspaces: () => ({
      sessionsChanged: say('workspaces.sessionsChanged')
    }),
    announce: <T>(moment: Moment<T>, m: T) => {
      const tabId = typeof m === 'string' ? m : (m as TabEnded).tabId
      calls.push(`announce ${moment.name} ${tabId}`)
    },
    ...over
  })
  return { lifecycle, calls }
}

const exitOf = (over: Partial<TabEnded> = {}): TabEnded => ({
  tabId: 't1',
  exitCode: 0,
  asleep: false,
  crashed: false,
  sessionGoesOn: false,
  ...over
})

describe('TabLifecycle', () => {
  it('a tab whose process is being stopped, to close, restart or sleep, tells attention whether it restarts, and then the plugins', () => {
    for (const restarting of [false, true]) {
      const { lifecycle, calls } = wired()
      lifecycle.emit('stopping', 't1', restarting)
      expect(calls).toEqual([`attention.tabStopping t1 ${restarting}`, 'announce tab-stopping t1'])
    }
  })

  it('teardown clears attention before any agent can mark a crash, and the plugins hear it only after the agents were told how the tab’s terminal ended', () => {
    const { lifecycle, calls } = wired()
    lifecycle.emit(
      'teardown',
      exitOf({ crashed: true, exitCode: 1, signal: 15, left: { treeRoot: '/repo' } })
    )
    expect(calls).toEqual([
      'attention.clear t1',
      'backends.tabExited t1 code 1 signal 15 crashed true',
      'announce tab-torn-down t1'
    ])
  })

  it('an agent whose ending of the tab fails some time after it was told is a toast, and the plugins have heard of the teardown by then', async () => {
    const backends = new SessionBackends(nothingListensToTheSessions())
    backends.register({
      ...stubBackend('codex'),
      tabExited: async () => {
        throw new Error('stop failed')
      }
    })
    const { lifecycle, calls } = wired({ backends })
    lifecycle.emit('teardown', exitOf())
    expect(calls).toEqual(['attention.clear t1', 'announce tab-torn-down t1'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.slice(2)).toEqual(['toast Error: stop failed'])
  })

  it('a tab put to sleep or woken refreshes the workspaces list', () => {
    const { lifecycle, calls } = wired()
    lifecycle.emit('slept')
    lifecycle.emit('woken')
    expect(calls).toEqual(['workspaces.sessionsChanged', 'workspaces.sessionsChanged'])
  })

  it('a sleeping tab closed for good is announced to the plugins before the workspaces list refreshes', () => {
    const { lifecycle, calls } = wired()
    lifecycle.emit('forgotten', 't1')
    expect(calls).toEqual(['announce tab-forgotten t1', 'workspaces.sessionsChanged'])
  })
})
