import { describe, expect, it } from 'vitest'
import {
  ATTENTION_CHANGED,
  DIALOG_CLOSED,
  Moments,
  STATE_CHANGED,
  TOOL_DONE,
  TURN_OVER,
  type StateChanged
} from '../../src/core/moment'
import { PLUGINS } from '../../src/plugins/list'
import { followEachState } from '../../src/plugins/sessions/main/sessionHooks'
import { butlerFollowsEachTurn } from '../../src/plugins/butler/main/sessionHooks'
import { cardEachTurnAndQuestion } from '../../src/plugins/inbox/main/sessionHooks'
import { followEachRun } from '../../src/plugins/scheduled-tasks/main/sessionHooks'
import { discordFollowsEachTurn } from '../../src/plugins/discord/main/sessionHooks'

function wired(o: { onDiscord?: boolean; pendingAsk?: string } = {}): {
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
  followEachState(moments, {
    asks: () => ({
      dialogGone: say('asks.dialogGone'),
      toolDone: (tabId) => say('asks.toolDone')(tabId)
    }),
    slash: { turnOver: say('slash.turnOver') },
    attention: {
      stateChanged: ({ tabId, prev, next }: StateChanged) =>
        say('attention.stateChanged')(tabId, prev, next)
    }
  })
  butlerFollowsEachTurn(moments, {
    butler: () => null,
    digest: () => ({ turnEnded: () => {}, prompted: () => {}, marked: say('digest.marked') }),
    tookTheTurn: () => false,
    asleep: { awakeTabsChanged: () => {}, asks: async (tabId) => say('asleep.asks')(tabId) },
    butlerTabChanged: () => {}
  })
  cardEachTurnAndQuestion(moments, {
    inbox: { turnEnded: () => {}, asked: () => {}, rebound: () => {}, sync: say('inbox.sync') },
    tookTheTurn: () => false
  })
  followEachRun(moments, () => ({
    onBound: () => {},
    onPtyExit: () => {},
    onStatus: say('cron.onStatus')
  }))
  discordFollowsEachTurn<string>(moments, {
    relay: () => ({
      turnEnded: () => {},
      stoppedAsking: say('relay.stoppedAsking'),
      codexAsked: say('relay.codexAsked')
    }),
    typing: () => ({ refresh: say('typing.refresh') }),
    rooms: () => null,
    buttons: () => ({ check: async (tabId) => say('buttons.check')(tabId) }),
    noTurnsYet: async () => true,
    askChannelOf: () => (o.onDiscord ? 'channel' : undefined),
    pendingAskOf: async () => o.pendingAsk,
    askUnreadablySoon: say('askUnreadablySoon')
  })
  return { moments, calls, settle: () => new Promise((resolve) => setTimeout(resolve, 0)) }
}

describe('what each plugin does when a session changes state, finishes a tool, ends a turn for good or its marks change', () => {
  it('leaving a question ends the session’s ask before attention marks the new state, a scheduled run reads the same edge after attention, then Discord stops showing the question', () => {
    const { moments, calls } = wired()
    void moments.announce(STATE_CHANGED, { tabId: 't1', prev: 'approval', next: 'waiting' })
    expect(calls).toEqual([
      'asks.dialogGone t1 false',
      'attention.stateChanged t1 approval waiting',
      'cron.onStatus t1 approval waiting',
      'relay.stoppedAsking t1',
      'typing.refresh t1'
    ])
  })

  it('a question on a tab the owner answers on Discord wakes the asleep watch and sends the agent’s question as a card, or a note when it cannot be read', async () => {
    for (const [pendingAsk, sent] of [
      ['allow rm?', 'relay.codexAsked t1 allow rm?'],
      [undefined, 'askUnreadablySoon t1']
    ] as const) {
      const { moments, calls, settle } = wired({ onDiscord: true, pendingAsk })
      void moments.announce(STATE_CHANGED, { tabId: 't1', prev: 'working', next: 'approval' })
      await settle()
      expect(calls).toEqual([
        'attention.stateChanged t1 working approval',
        'asleep.asks t1',
        'cron.onStatus t1 working approval',
        'buttons.check t1',
        'typing.refresh t1',
        sent
      ])
    }
  })

  it('a finished tool ends the session’s ask first when it was the asked call, then the ask buttons look again', () => {
    for (const endsTheAsk of [true, false]) {
      const { moments, calls } = wired()
      void moments.announce(TOOL_DONE, {
        tabId: 't1',
        call: { name: 'AskUserQuestion', input: {} },
        endsTheAsk
      })
      expect(calls).toEqual([
        ...(endsTheAsk ? ['asks.dialogGone t1 false'] : []),
        'asks.toolDone t1',
        'buttons.check t1'
      ])
    }
  })

  it('a Claude Code dialog closed on its screen ends the session’s ask as closed, then the ask buttons look again', () => {
    const { moments, calls } = wired()
    void moments.announce(DIALOG_CLOSED, 't1')
    expect(calls).toEqual(['asks.dialogGone t1 true', 'buttons.check t1'])
  })

  it('a turn over for good reaches slash commands; changed marks reach the away digest before the Inbox', () => {
    const { moments, calls } = wired()
    void moments.announce(TURN_OVER, { tabId: 't1', over: true })
    void moments.announce(ATTENTION_CHANGED, [])
    expect(calls).toEqual(['slash.turnOver t1 true', 'digest.marked', 'inbox.sync'])
  })
})
