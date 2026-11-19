import { describe, expect, it } from 'vitest'
import {
  Moments,
  TAB_EXITED,
  TAB_FORGOTTEN,
  TAB_TORN_DOWN,
  type TabEnded
} from '../../src/core/moment'
import { PLUGINS } from '../../src/plugins/list'
import { forgetAsksOfEndedTabs } from '../../src/plugins/sessions/main/sessionHooks'
import { butlerLetsGoOfEndedTabs } from '../../src/plugins/butler/main/sessionHooks'
import { closeOutEachEndedRun } from '../../src/plugins/scheduled-tasks/main/sessionHooks'
import {
  closeRoomsOfEndedTabs,
  type EndedTabParts
} from '../../src/plugins/discord/main/sessionHooks'
import { forgetSecretAsksOfEndedTabs } from '../../src/plugins/passwords/main/sessionHooks'

function wired(over: Partial<EndedTabParts> = {}): { moments: Moments; calls: string[] } {
  const calls: string[] = []
  const say =
    (name: string) =>
    (...args: unknown[]): void =>
      void calls.push([name, ...args.map(String)].join(' '))
  const moments = new Moments(PLUGINS)
  forgetAsksOfEndedTabs(moments, {
    slash: { closed: say('slash.closed') },
    asks: () => ({ forget: say('asks.forget') })
  })
  butlerLetsGoOfEndedTabs(moments, {
    butler: () => ({ onPtyExit: say('butler.onPtyExit') }),
    digest: () => ({ forget: say('digest.forget') })
  })
  closeOutEachEndedRun(moments, () => ({
    onPtyExit: (tabId, left) => say('cron.onPtyExit')(tabId, left?.treeRoot)
  }))
  closeRoomsOfEndedTabs(moments, {
    typing: () => ({ forget: say('typing.forget') }),
    relay: () => ({ forget: say('relay.forget') }),
    buttons: () => ({ forget: say('buttons.forget') }),
    rooms: () => ({
      forget: say('rooms.forget'),
      stopped: say('rooms.stopped'),
      closed: say('rooms.closed')
    }),
    ...over
  })
  forgetSecretAsksOfEndedTabs(moments, () => ({ forget: say('secrets.forget') }))
  return { moments, calls }
}

const exitOf = (over: Partial<TabEnded> = {}): TabEnded => ({
  tabId: 't1',
  exitCode: 0,
  asleep: false,
  crashed: false,
  sessionGoesOn: false,
  ...over
})

describe('what each plugin lets go of when a tab ends', () => {
  it('an exit makes what the session was asking, the butler digest, each Discord part and a password ask forget the tab, and a closed tab closes its room', () => {
    const { moments, calls } = wired()
    void moments.announce(TAB_EXITED, exitOf())
    expect(calls).toEqual([
      'slash.closed t1',
      'asks.forget t1',
      'digest.forget t1',
      'typing.forget t1',
      'relay.forget t1',
      'buttons.forget t1',
      'rooms.closed t1',
      'secrets.forget t1'
    ])
  })

  it('a room only forgets a tab whose session goes on (asleep, restarting or Koloft quitting), and is marked stopped when its session stopped unexpectedly', () => {
    for (const [over, room] of [
      [{ sessionGoesOn: true, unexpected: true }, 'rooms.forget t1'],
      [{ unexpected: true }, 'rooms.stopped t1'],
      [{}, 'rooms.closed t1']
    ] as const) {
      const { moments, calls } = wired()
      void moments.announce(TAB_EXITED, exitOf(over))
      expect(calls.filter((c) => c.startsWith('rooms.'))).toEqual([room])
    }
  })

  it('a Discord part that fails to forget the tab still lets its room close and the other plugins forget it', async () => {
    const { moments, calls } = wired({
      relay: () => ({
        forget: () => {
          throw new Error('relay broke')
        }
      })
    })
    await expect(moments.announce(TAB_EXITED, exitOf())).rejects.toThrow('relay broke')
    expect(calls).toContain('rooms.closed t1')
    expect(calls).toContain('secrets.forget t1')
  })

  it('a Discord part made after the subscription still hears exits', () => {
    let relay: { forget: (tabId: string) => void } | null = null
    const { moments, calls } = wired({ relay: () => relay })
    void moments.announce(TAB_EXITED, exitOf({ tabId: 'early' }))
    relay = { forget: (tabId) => void calls.push(`late relay.forget ${tabId}`) }
    void moments.announce(TAB_EXITED, exitOf({ tabId: 'late' }))
    expect(calls).toContain('late relay.forget late')
  })

  it('a teardown tells the butler and the scheduled run that held the tab', () => {
    const { moments, calls } = wired()
    void moments.announce(TAB_TORN_DOWN, exitOf({ left: { treeRoot: '/repo' } }))
    expect(calls).toEqual(['butler.onPtyExit t1', 'cron.onPtyExit t1 /repo'])
  })

  it('a sleeping tab closed for good is told to the butler', () => {
    const { moments, calls } = wired()
    void moments.announce(TAB_FORGOTTEN, 't1')
    expect(calls).toEqual(['butler.onPtyExit t1'])
  })
})
