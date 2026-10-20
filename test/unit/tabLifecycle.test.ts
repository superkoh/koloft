import { describe, it, expect } from 'vitest'
import {
  TabLifecycle,
  subscribeTabSubsystems,
  type TabExit,
  type TabSubsystems
} from '../../src/main/tabLifecycle'

function wired(over: Partial<TabSubsystems> = {}): { lifecycle: TabLifecycle; calls: string[] } {
  const calls: string[] = []
  const say =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push([name, ...args.map(String)].join(' '))
    }
  const lifecycle = new TabLifecycle()
  subscribeTabSubsystems(lifecycle, {
    slash: { closed: say('slash.closed') },
    attention: { clear: say('attention.clear') },
    claude: { onPtyExit: say('claude.onPtyExit') },
    tracker: { setAlive: say('tracker.setAlive') },
    storedOwnerOf: () => ({
      stop: async (tabId, code) => say('owner.stop')(tabId, code)
    }),
    toast: say('toast'),
    typing: () => ({ forget: say('typing.forget') }),
    relay: () => ({ forget: say('relay.forget') }),
    buttons: () => ({ forget: say('buttons.forget') }),
    secrets: () => ({ forget: say('secrets.forget') }),
    workspaces: () => ({
      launchEnded: say('workspaces.launchEnded'),
      onTrackerUpdate: say('workspaces.onTrackerUpdate')
    }),
    cron: () => ({ onPtyExit: (tabId, left) => say('cron.onPtyExit')(tabId, left?.treeRoot) }),
    butler: () => ({ onPtyExit: say('butler.onPtyExit') }),
    ...over
  })
  return { lifecycle, calls }
}

const exitOf = (over: Partial<TabExit> = {}): TabExit => ({
  tabId: 't1',
  exitCode: 0,
  asleep: false,
  crashed: false,
  ...over
})

describe('TabLifecycle', () => {
  it('an exit, asleep or not, makes each Discord part forget the tab', () => {
    for (const asleep of [false, true]) {
      const { lifecycle, calls } = wired()
      lifecycle.emit('exit', exitOf({ asleep }))
      expect(calls).toEqual([
        'slash.closed t1',
        'typing.forget t1',
        'relay.forget t1',
        'buttons.forget t1',
        'secrets.forget t1'
      ])
    }
  })

  it('teardown clears attention before Claude Code can mark a crash, and tells the butler whether the tab only fell asleep', () => {
    const { lifecycle, calls } = wired()
    lifecycle.emit('teardown', exitOf({ crashed: true, exitCode: 1, left: { treeRoot: '/repo' } }))
    expect(calls).toEqual([
      'attention.clear t1',
      'claude.onPtyExit t1 true',
      'tracker.setAlive t1 false',
      'owner.stop t1 1',
      'workspaces.launchEnded t1',
      'cron.onPtyExit t1 /repo',
      'butler.onPtyExit t1 false'
    ])
    lifecycle.emit('teardown', exitOf({ asleep: true }))
    expect(calls.at(-1)).toBe('butler.onPtyExit t1 true')
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

  it('a Discord part made after the subscription still hears exits', () => {
    let relay: { forget: (tabId: string) => void } | null = null
    const { lifecycle, calls } = wired({ relay: () => relay })
    lifecycle.emit('exit', exitOf({ tabId: 'early' }))
    relay = { forget: (tabId) => calls.push(`late relay.forget ${tabId}`) }
    lifecycle.emit('exit', exitOf({ tabId: 'late' }))
    expect(calls).toContain('late relay.forget late')
  })

  it('a tab put to sleep or woken refreshes the workspaces list', () => {
    const { lifecycle, calls } = wired()
    lifecycle.emit('slept')
    lifecycle.emit('woken')
    expect(calls).toEqual(['workspaces.onTrackerUpdate', 'workspaces.onTrackerUpdate'])
  })

  it('a sleeping tab closed for good ends its butler task and refreshes the workspaces list', () => {
    const { lifecycle, calls } = wired()
    lifecycle.emit('forgotten', 't1')
    expect(calls).toEqual(['butler.onPtyExit t1 false', 'workspaces.onTrackerUpdate'])
  })
})
