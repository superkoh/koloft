import { describe, it, expect } from 'vitest'
import type { Moment, TabEnded } from '../../../../src/core/moment'
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
    claude: { onPtyExit: say('claude.onPtyExit'), launchEnded: say('claude.launchEnded') },
    tracker: { setAlive: say('tracker.setAlive') },
    storedOwnerOf: () => ({
      stop: async (tabId, code) => say('owner.stop')(tabId, code)
    }),
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

  it('teardown clears attention before Claude Code can mark a crash, and the plugins hear it only after core has marked the tab dead and stopped its session', () => {
    const { lifecycle, calls } = wired()
    lifecycle.emit('teardown', exitOf({ crashed: true, exitCode: 1, left: { treeRoot: '/repo' } }))
    expect(calls).toEqual([
      'attention.clear t1',
      'claude.onPtyExit t1 true',
      'tracker.setAlive t1 false',
      'owner.stop t1 1',
      'claude.launchEnded t1',
      'announce tab-torn-down t1'
    ])
  })

  it('a stored session killed by a signal is stopped with code -1, and a failed stop is a toast', async () => {
    const { lifecycle, calls } = wired({
      storedOwnerOf: () => ({
        stop: async (tabId, code) => {
          calls.push(`owner.stop ${tabId} ${code}`)
          throw new Error('stop failed')
        }
      })
    })
    lifecycle.emit('teardown', exitOf({ exitCode: 0, signal: 15 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toContain('owner.stop t1 -1')
    expect(calls).toContain('toast Error: stop failed')
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
