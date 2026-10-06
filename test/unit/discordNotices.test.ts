import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ConductorBinding } from '../../src/shared/types'
import type { Card } from '../../src/main/discord/cards'
import {
  ANSWER_IN_THE_THREAD,
  noticeBinding,
  noticeKindOf,
  Notices,
  REPLY_FOLLOWS_THE_TURN_MS,
  type NoticeDeps,
  type NoticeSubject
} from '../../src/main/discord/notices'

const WS = '/Users/me/koloft'

function binding(scope: string, channelId: string, touched: string[] = []): ConductorBinding {
  return {
    id: `b-${channelId}`,
    scope,
    backend: 'claude',
    channel: { guildId: '1', channelId, name: channelId },
    sessionIds: [],
    touched
  }
}

function subject(tabId: string, name: string, over: Partial<NoticeSubject> = {}): NoticeSubject {
  return { tabId, key: tabId, name, backend: 'claude', workspace: WS, ...over }
}

function shown(card: Card): string {
  return [card.header, card.body, card.footer].filter(Boolean).join('\n')
}

function setup(over: Partial<NoticeDeps> = {}) {
  const cards: [string, string][] = []
  const archived: string[] = []
  const deps: NoticeDeps = {
    bindings: () => [binding(WS, '10', ['a', 'b', 'c', 'e'])],
    place: async (_b, s) => `thread-${s.key}`,
    hasThread: () => false,
    card: (channelId, card) => void cards.push([channelId, shown(card)]),
    archive: (threadId) => void archived.push(threadId),
    withButtons: (_t, view, card) => ({
      ...card,
      footer: `${card.footer ?? ''} [${view.choices.map((c) => c.label).join('|')}]`
    }),
    subject: (tabId) => subject(tabId, tabId),
    shownName: async () => null,
    awaitsInput: () => false,
    commandRunning: () => false,
    dialog: async () => undefined,
    ...over
  }
  return { notices: new Notices(deps), cards, archived }
}

afterEach(() => vi.useRealTimers())

describe('Discord notices: which session state change reaches which conductor', () => {
  it('a turn that ends is "finished", a dialog is "waiting", and a fresh session settling is nothing', () => {
    expect(noticeKindOf('working', 'waiting', false)).toBe('finished')
    expect(noticeKindOf('approval', 'waiting', false)).toBe('finished')
    expect(noticeKindOf('working', 'approval', false)).toBe('waiting')
    expect(noticeKindOf(undefined, 'waiting', false)).toBeUndefined()
    expect(noticeKindOf('waiting', 'idle', false)).toBeUndefined()
    expect(noticeKindOf('waiting', 'working', false)).toBeUndefined()
  })

  it('a turn that stops to ask the owner for input is "waiting", not "finished"', () => {
    expect(noticeKindOf('working', 'waiting', true)).toBe('waiting')
  })

  it('"finished" goes only to a conductor that touched the session or whose session already has a thread; "waiting" and "closed" go to any conductor whose scope holds it', () => {
    const s = { key: 's1', workspace: WS }
    const untouched = [binding(WS, '10')]
    const channel = (b?: ConductorBinding): string | undefined => b?.channel.channelId
    expect(channel(noticeBinding(untouched, s, 'finished'))).toBeUndefined()
    expect(channel(noticeBinding(untouched, s, 'finished', true))).toBe('10')
    expect(channel(noticeBinding(untouched, s, 'waiting'))).toBe('10')
    expect(channel(noticeBinding(untouched, s, 'closed'))).toBe('10')
    expect(channel(noticeBinding([binding(WS, '10', ['s1'])], s, 'finished'))).toBe('10')
  })

  it('a session outside a workspace conductor’s scope reaches only the global conductor, and with no conductor in scope nothing is sent', () => {
    const s = { key: 's1', workspace: '/Users/me/elsewhere' }
    expect(noticeBinding([binding(WS, '10')], s, 'waiting')).toBeUndefined()
    expect(
      noticeBinding([binding(WS, '10'), binding('global', '20')], s, 'waiting')?.channel.channelId
    ).toBe('20')
  })

  it('when the global and the workspace conductor both cover it, only the workspace conductor gets it', () => {
    const s = { key: 's1', workspace: WS }
    const both = [binding('global', '20', ['s1']), binding(WS, '10', ['s1'])]
    expect(noticeBinding(both, s, 'waiting')?.channel.channelId).toBe('10')
    expect(noticeBinding(both, s, 'finished')?.channel.channelId).toBe('10')
    expect(
      noticeBinding([binding('global', '20', ['s1']), binding(WS, '10')], s, 'finished')?.channel
        .channelId
    ).toBe('20')
  })
})

describe('Discord notices: what each session’s thread gets', () => {
  it('each session’s notice goes as a card into its own thread; a conductor’s own session gives none, nor a turn a slash command Koloft typed is running', async () => {
    vi.useFakeTimers()
    const { notices, cards } = setup({
      commandRunning: (tabId) => tabId === 'e',
      subject: (tabId) => subject(tabId, tabId, { conductor: tabId === 'd' ? 'b1' : undefined })
    })
    notices.turnEnded('a', 'All done.')
    notices.onStatus('a', 'working', 'waiting')
    notices.onStatus('e', 'working', 'waiting')
    notices.onStatus('d', 'working', 'approval')
    notices.closed('d')
    notices.closed('c')
    await vi.advanceTimersByTimeAsync(0)
    expect([...cards].sort()).toEqual([
      ['thread-a', '🔔 **a** finished.\nAll done.'],
      ['thread-c', '⏹ **c** closed.']
    ])
  })

  it('"finished" carries the turn’s reply whether it arrives before or after the turn ends; with none in time it goes without one', async () => {
    vi.useFakeTimers()
    const { notices, cards } = setup()
    notices.onStatus('a', 'working', 'waiting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(cards).toEqual([])
    notices.turnEnded('a', 'Late reply.')
    await vi.advanceTimersByTimeAsync(0)
    notices.onStatus('b', 'working', 'waiting')
    await vi.advanceTimersByTimeAsync(REPLY_FOLLOWS_THE_TURN_MS)
    expect(cards).toEqual([
      ['thread-a', '🔔 **a** finished.\nLate reply.'],
      ['thread-b', '🔔 **b** finished.']
    ])
  })

  it('the reply of a turn a slash command ran is not shown with a later "finished"', async () => {
    vi.useFakeTimers()
    let running = true
    const { notices, cards } = setup({ commandRunning: () => running })
    notices.turnEnded('a', 'What /review printed.')
    notices.onStatus('a', 'working', 'waiting')
    await vi.advanceTimersByTimeAsync(0)
    running = false
    notices.onStatus('a', 'approval', 'waiting')
    await vi.advanceTimersByTimeAsync(REPLY_FOLLOWS_THE_TURN_MS)
    expect(cards).toEqual([['thread-a', '🔔 **a** finished.']])
  })

  it('a reply from a turn that went on working is not shown with the next turn’s "finished"', async () => {
    vi.useFakeTimers()
    const { notices, cards } = setup()
    notices.turnEnded('a', 'Old reply.')
    notices.onStatus('a', 'waiting', 'working')
    notices.onStatus('a', 'working', 'waiting')
    await vi.advanceTimersByTimeAsync(REPLY_FOLLOWS_THE_TURN_MS)
    expect(cards).toEqual([['thread-a', '🔔 **a** finished.']])
  })

  it('"waiting" shows the question with its buttons, and says it can be answered right there only inside a thread', async () => {
    vi.useFakeTimers()
    const dialog = {
      text: 'Which?\n1. A\n2. B',
      choices: [
        { label: '1. A', reply: '1', style: 'secondary' as const },
        { label: '2. B', reply: '2', style: 'secondary' as const }
      ]
    }
    const { notices, cards } = setup({
      dialog: async () => dialog,
      place: async (b, s) => (s.key === 'a' ? `thread-a` : b.channel.channelId)
    })
    notices.onStatus('a', 'working', 'approval')
    notices.onStatus('b', 'working', 'approval')
    await vi.advanceTimersByTimeAsync(0)
    expect(cards).toEqual([
      [
        'thread-a',
        `❓ **a** is waiting for you.\nWhich?\n1. A\n2. B\n${ANSWER_IN_THE_THREAD} [1. A|2. B]`
      ],
      ['10', '❓ **b** is waiting for you.\nWhich?\n1. A\n2. B\n [1. A|2. B]']
    ])
  })

  it('a session is called by the name it is shown under, and still by it once it has closed and has no name left', async () => {
    vi.useFakeTimers()
    let live = true
    const { notices, cards } = setup({
      subject: (tabId) =>
        subject(tabId, tabId === 'a' ? 'Koloft started you because the session' : 'beta'),
      shownName: async (tabId) => (tabId === 'a' && live ? 'helper-1a2b3c' : null)
    })
    notices.turnEnded('a', '')
    notices.onStatus('a', 'working', 'waiting')
    await vi.advanceTimersByTimeAsync(0)
    live = false
    notices.closed('a')
    notices.forget('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(cards).toEqual([
      ['thread-a', '🔔 **helper-1a2b3c** finished.'],
      ['thread-a', '⏹ **helper-1a2b3c** closed.']
    ])
  })

  it('a session that already left the list when its terminal exits is still announced as closed, once, and its thread is put away', async () => {
    vi.useFakeTimers()
    const listed = new Set(['a'])
    const { notices, cards, archived } = setup({
      bindings: () => [binding('global', '20'), binding(WS, '10')],
      subject: (tabId) => (listed.has(tabId) ? subject(tabId, 'alpha') : undefined)
    })
    notices.onStatus('a', undefined, 'idle')
    listed.delete('a')
    notices.closed('a')
    notices.closed('a')
    notices.forget('a')
    notices.closed('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(cards).toEqual([['thread-a', '⏹ **alpha** closed.']])
    expect(archived).toEqual(['thread-a'])
  })
})
