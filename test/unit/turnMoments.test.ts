import { describe, expect, it } from 'vitest'
import {
  Moments,
  QUESTION_ASKED,
  TAB_EXITED,
  SESSION_BOUND,
  TURN_ENDED,
  TURN_STARTED
} from '../../src/core/moment'
import { knowPluginStates } from '../../src/core/switches'
import type { AskPayload } from '../../src/shared/sessionEvent'
import type { Turn } from '../../src/shared/turns'
import { PLUGINS } from '../../src/plugins/list'
import { followEachTurn } from '../../src/plugins/sessions/main/sessionHooks'
import { pickDocsOfEachTurn } from '../../src/plugins/workbench/main/sessionHooks'
import { butlerFollowsEachTurn } from '../../src/plugins/butler/main/sessionHooks'
import { cardEachTurnAndQuestion } from '../../src/plugins/inbox/main/sessionHooks'
import { followEachRun } from '../../src/plugins/scheduled-tasks/main/sessionHooks'
import { discordFollowsEachTurn } from '../../src/plugins/discord/main/sessionHooks'

const turn = { reply: 'done', said: [] } as unknown as Turn
const ask = {} as AskPayload

function wired(
  o: { handsOff?: boolean; asksMade?: boolean; askKept?: boolean; butlerTab?: boolean } = {}
): {
  moments: Moments
  calls: string[]
  settle: () => Promise<void>
} {
  const calls: string[] = []
  const say =
    (name: string) =>
    (...args: unknown[]): void =>
      void calls.push([name, ...args.map(String)].join(' '))
  const moments = new Moments(PLUGINS)
  pickDocsOfEachTurn(moments, { turnEnded: async (tabId) => say('docs.turnEnded')(tabId) })
  const turns = followEachTurn(moments, {
    judge: {
      turnEnded: (tabId) => say('judge.turnEnded')(tabId),
      prompted: say('judge.prompted')
    },
    slash: { turnEnded: (tabId) => say('slash.turnEnded')(tabId), bound: say('slash.bound') },
    replies: {
      turnEnded: (tabId) => {
        say('replies.turnEnded')(tabId)
        return !!o.handsOff
      }
    },
    asks: () => (o.asksMade === false ? null : { onAsk: (tabId) => say('asks.onAsk')(tabId) }),
    askBeforeAsksAreMade: say('row shows the ask'),
    askAsItsAgentGaveIt: () => (o.askKept === false ? undefined : ask)
  })
  butlerFollowsEachTurn(moments, {
    butler: () => ({ onBound: say('butler.onBound'), isButlerTab: () => !!o.butlerTab }),
    digest: () => ({
      turnEnded: say('digest.turnEnded'),
      prompted: say('digest.prompted'),
      marked: () => {}
    }),
    tookTheTurn: turns.tookTheTurn,
    asleep: { awakeTabsChanged: say('asleep.awakeTabsChanged'), asks: async () => {} },
    butlerTabChanged: say('answerable synced')
  })
  cardEachTurnAndQuestion(moments, {
    inbox: {
      turnEnded: say('inbox.turnEnded'),
      asked: say('inbox.asked'),
      rebound: say('inbox.rebound'),
      sync: () => {}
    },
    tookTheTurn: turns.tookTheTurn
  })
  followEachRun(
    moments,
    () => ({
      onBound: say('cron.onBound'),
      onPtyExit: () => {},
      onStatus: () => {},
      runStartedIn: () => false
    }),
    () => {}
  )
  discordFollowsEachTurn(moments, {
    relay: () => ({
      turnEnded: (tabId) => say('relay.turnEnded')(tabId),
      stoppedAsking: () => {},
      codexAsked: () => {}
    }),
    typing: () => ({ refresh: say('typing.refresh') }),
    rooms: () => ({
      bound: async (tabId, _key, fresh) => say('rooms.bound')(tabId, await fresh())
    }),
    noTurnsYet: async () => true,
    buttons: () => null,
    askChannelOf: () => undefined,
    pendingAskOf: async () => undefined,
    askUnreadablySoon: () => {}
  })
  return { moments, calls, settle: () => new Promise((resolve) => setTimeout(resolve, 0)) }
}

describe('what each plugin does when a turn starts or ends, a question is asked or a session binds', () => {
  it('a finished turn reaches the Inbox and the butler’s away digest only after sessions core decided whether someone else took it', () => {
    for (const handsOff of [false, true]) {
      const { moments, calls } = wired({ handsOff })
      void moments.announce(TURN_ENDED, { tabId: 't1', turn })
      expect(calls).toEqual([
        'judge.turnEnded t1',
        'slash.turnEnded t1',
        'replies.turnEnded t1',
        'docs.turnEnded t1',
        `digest.turnEnded t1 done ${handsOff}`,
        `inbox.turnEnded t1 done ${handsOff}`,
        'relay.turnEnded t1'
      ])
    }
  })

  it('who took a turn is decided anew each turn, even when the news judge fails first, and forgotten once the tab ends', async () => {
    const moments = new Moments(PLUGINS)
    let handsOff = true
    const turns = followEachTurn(moments, {
      judge: {
        turnEnded: () => {
          throw new Error('the judge broke')
        },
        prompted: () => {}
      },
      slash: { turnEnded: () => {}, bound: () => {} },
      replies: { turnEnded: () => handsOff },
      asks: () => null,
      askBeforeAsksAreMade: () => {},
      askAsItsAgentGaveIt: () => undefined
    })
    const ended = (): Promise<unknown> =>
      moments.announce(TURN_ENDED, { tabId: 't1', turn }).catch(() => undefined)
    await ended()
    expect(turns.tookTheTurn('t1')).toBe(true)
    handsOff = false
    await ended()
    expect(turns.tookTheTurn('t1')).toBe(false)
    handsOff = true
    await ended()
    await moments.announce(TAB_EXITED, {
      tabId: 't1',
      exitCode: 0,
      asleep: false,
      crashed: false,
      sessionGoesOn: false
    })
    expect(turns.tookTheTurn('t1')).toBe(false)
  })

  it('a new turn tells the news judge before the away digest', () => {
    const { moments, calls } = wired()
    void moments.announce(TURN_STARTED, 't1')
    expect(calls).toEqual(['judge.prompted t1', 'digest.prompted t1'])
  })

  it('a question goes to the session’s asks, as its agent gave it, and the Inbox; before the asks exist it shows on its row; with nothing kept for its tab only the Inbox hears', () => {
    for (const [asksMade, askKept, heard] of [
      [true, true, ['asks.onAsk t1', 'inbox.asked t1']],
      [false, true, ['row shows the ask t1', 'inbox.asked t1']],
      [true, false, ['inbox.asked t1']]
    ] as const) {
      const { moments, calls } = wired({ asksMade, askKept })
      void moments.announce(QUESTION_ASKED, { tabId: 't1', id: '1' })
      expect(calls).toEqual(heard)
    }
  })

  it('a bind reaches slash commands, the butler, the Inbox, scheduled runs and Discord; the butler’s own tab also wakes the asleep watch and the answerable marks', async () => {
    for (const butlerTab of [false, true]) {
      const { moments, calls, settle } = wired({ butlerTab })
      void moments.announce(SESSION_BOUND, { tabId: 't1', key: 'k1', idleCompaction: false })
      await settle()
      expect(calls).toEqual([
        'slash.bound t1 k1',
        'butler.onBound t1 k1',
        ...(butlerTab ? ['asleep.awakeTabsChanged', 'answerable synced'] : []),
        'inbox.rebound t1 k1',
        'cron.onBound t1 k1',
        'typing.refresh t1',
        'rooms.bound t1 true'
      ])
    }
  })

  it('a room counts a bind as a new conversation only when it is no idle compaction and the session has no turn yet', async () => {
    const { moments, calls, settle } = wired()
    void moments.announce(SESSION_BOUND, { tabId: 't1', key: 'k1', idleCompaction: true })
    await settle()
    expect(calls).toContain('rooms.bound t1 false')
  })

  it('while Discord is off a bind still reaches its rooms, so a room follows a new conversation started then, but not its typing', async () => {
    const { moments, calls, settle } = wired()
    try {
      knowPluginStates({ discord: { on: false } })
      void moments.announce(SESSION_BOUND, { tabId: 't1', key: 'k1', idleCompaction: false })
      await settle()
    } finally {
      knowPluginStates({})
    }
    expect(calls).toContain('rooms.bound t1 true')
    expect(calls).not.toContain('typing.refresh t1')
  })
})
