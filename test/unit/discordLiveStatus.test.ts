import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SessionStatus } from '../../src/shared/types'
import type { Card } from '../../src/main/discord/cards'
import {
  LiveStatus,
  liveStateOf,
  statusCard,
  TYPING_RENEWED_EVERY_MS
} from '../../src/main/discord/liveStatus'

const WS = '/Users/me/koloft'

function setup() {
  const status = new Map<string, SessionStatus>()
  const asking = new Set<string>()
  const unknown = new Set<string>()
  const openers = new Map<string, { channelId: string; messageId: string }>()
  const conductorChannels = new Map<string, string>()
  const names = new Map<string, string>()
  const edits: { channelId: string; messageId: string; header: string }[] = []
  const typed: string[] = []
  let holdEdits = false
  const held: (() => void)[] = []
  const live = new LiveStatus({
    link: {
      editCard: (channelId: string, messageId: string, card: Card) => {
        edits.push({ channelId, messageId, header: card.header })
        if (!holdEdits) return Promise.resolve()
        return new Promise<void>((resolve) => held.push(resolve))
      },
      typing: async (channelId: string) => void typed.push(channelId)
    },
    openerOf: (tabId) => openers.get(tabId),
    conductorChannelOf: (tabId) => conductorChannels.get(tabId),
    subject: async (tabId) =>
      names.has(tabId) ? { name: names.get(tabId)!, backend: 'claude', workspace: WS } : undefined,
    status: (tabId) => status.get(tabId),
    awaitsInput: (tabId) => asking.has(tabId),
    unknown: (tabId) => unknown.has(tabId)
  })
  const withThread = (tabId: string, name: string, messageId: string): void => {
    names.set(tabId, name)
    openers.set(tabId, { channelId: '10', messageId })
  }
  const releaseEdits = async (): Promise<void> => {
    holdEdits = false
    while (held.length) {
      held.shift()!()
      await settled()
    }
  }
  return {
    live,
    status,
    asking,
    unknown,
    openers,
    conductorChannels,
    names,
    edits,
    typed,
    withThread,
    holdEdits: () => void (holdEdits = true),
    releaseEdits
  }
}

const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const headers = (edits: { header: string }[]): string[] => edits.map((e) => e.header)

afterEach(() => {
  vi.useRealTimers()
})

describe('a session’s Discord opener card follows its sidebar light', () => {
  it('each light has its own state: a question or approval is "needs you", a turn that ended is "done", a long rest is "idle", and a Codex session Koloft cannot read is "unknown"', () => {
    expect(liveStateOf('working', false, false)).toBe('working')
    expect(liveStateOf('approval', false, false)).toBe('needs-you')
    expect(liveStateOf('waiting', true, false)).toBe('needs-you')
    expect(liveStateOf('idle', true, false)).toBe('needs-you')
    expect(liveStateOf('waiting', false, false)).toBe('turn-done')
    expect(liveStateOf('idle', false, false)).toBe('idle')
    expect(liveStateOf('working', false, true)).toBe('unknown')
    expect(liveStateOf(undefined, false, false)).toBeUndefined()
  })

  it('the card names the session, says its state with the moment it began as a Discord timestamp that counts up by itself, keeps where it runs, and never rings', () => {
    const card = statusCard(
      { name: 'fix-login', backend: 'codex', workspace: WS },
      'working',
      90_500
    )
    expect(card.header).toBe('🔄 **fix-login** · working, started <t:90:R>')
    expect(card.body).toBe('-# koloft · Codex')
    expect(card.silent).toBe(true)
    expect(statusCard({ name: 'a', backend: 'claude' }, 'unknown', 0).header).toBe(
      '⚪ **a** · status unknown'
    )
  })

  it('a state change edits the opener of the session’s thread, in the conductor channel; a session with no thread is not touched', async () => {
    const t = setup()
    t.withThread('t1', 'fix-login', '101')
    t.names.set('t2', 'no-thread')
    t.status.set('t1', 'working')
    t.status.set('t2', 'working')
    await t.live.refresh('t1')
    await t.live.refresh('t2')
    await settled()
    expect(t.edits).toEqual([
      {
        channelId: '10',
        messageId: '101',
        header: expect.stringMatching(/^🔄 \*\*fix-login\*\* · working/)
      }
    ])
  })

  it('a change that shows nothing new sends no edit, and an idle session keeps the moment its turn ended', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    const t = setup()
    t.withThread('t1', 'a', '101')
    t.status.set('t1', 'waiting')
    await t.live.refresh('t1')
    await t.live.refresh('t1')
    vi.setSystemTime(1_240_000)
    t.status.set('t1', 'idle')
    await t.live.refresh('t1')
    await settled()
    expect(headers(t.edits)).toEqual([
      '✅ **a** · turn done <t:1000:R>',
      '💤 **a** · idle, done <t:1000:R>'
    ])
  })

  it('while an edit is on its way, only the newest state follows it, and one the card already shows is skipped', async () => {
    const t = setup()
    t.withThread('t1', 'a', '101')
    t.holdEdits()
    t.status.set('t1', 'working')
    await t.live.refresh('t1')
    t.status.set('t1', 'approval')
    await t.live.refresh('t1')
    t.status.set('t1', 'waiting')
    await t.live.refresh('t1')
    expect(t.edits).toHaveLength(1)
    await t.releaseEdits()
    expect(headers(t.edits).map((h) => h.split(' · ')[1])).toEqual([
      expect.stringMatching(/^working/),
      expect.stringMatching(/^turn done/)
    ])
  })

  it('a thread opened later, or a Codex session going unreadable, updates the card; a session change that alters neither name nor readability does not', async () => {
    const t = setup()
    t.names.set('t1', 'a')
    t.status.set('t1', 'approval')
    await t.live.refresh('t1')
    expect(t.edits).toEqual([])
    t.openers.set('t1', { channelId: '10', messageId: '101' })
    await t.live.refresh('t1')
    t.live.sessionChanged('t1', 'a', false)
    await settled()
    t.live.sessionChanged('t1', 'a', false)
    t.unknown.add('t1')
    t.live.sessionChanged('t1', 'a', true)
    await settled()
    await settled()
    expect(headers(t.edits)).toEqual([
      expect.stringMatching(/^❓ \*\*a\*\* · needs you/),
      '⚪ **a** · status unknown'
    ])
  })

  it('a closed tab turns its card to "closed" even after its session left the list, and a refresh still in flight cannot turn it back', async () => {
    const t = setup()
    t.withThread('t1', 'a', '101')
    t.status.set('t1', 'working')
    await t.live.refresh('t1')
    t.names.delete('t1')
    const late = t.live.refresh('t1')
    t.live.closed('t1')
    t.live.forget('t1')
    await late
    await settled()
    expect(headers(t.edits).map((h) => h.split(' · ')[1])).toEqual([
      expect.stringMatching(/^working/),
      expect.stringMatching(/^closed/)
    ])
  })

  it('an edit Discord refuses is not counted as shown, so the same state is sent again next time', async () => {
    const t = setup()
    t.withThread('t1', 'a', '101')
    let refuse = true
    const live = new LiveStatus({
      link: {
        editCard: async (_c: string, _m: string, card: Card) => {
          t.edits.push({ channelId: _c, messageId: _m, header: card.header })
          if (refuse) throw new Error('Discord answered 404')
        },
        typing: async () => undefined
      },
      openerOf: (tabId) => t.openers.get(tabId),
      conductorChannelOf: () => undefined,
      subject: async () => ({ name: 'a', backend: 'claude' }),
      status: () => 'waiting',
      awaitsInput: () => false,
      unknown: () => false
    })
    await live.refresh('t1')
    await settled()
    refuse = false
    await live.refresh('t1')
    await settled()
    expect(t.edits).toHaveLength(2)
  })
})

describe('"Koloft is typing…" shows while a session or a conductor works', () => {
  it('a working session types in its own thread and a working conductor in its channel, renewed before Discord lets it lapse, and both stop once the work ends', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.withThread('t1', 'a', '101')
    t.conductorChannels.set('c1', '10')
    t.status.set('t1', 'working')
    t.status.set('c1', 'working')
    await t.live.refresh('t1')
    await t.live.refresh('c1')
    await vi.advanceTimersByTimeAsync(0)
    expect(t.typed).toEqual(['101', '10'])
    await vi.advanceTimersByTimeAsync(TYPING_RENEWED_EVERY_MS)
    expect(t.typed).toEqual(['101', '10', '101', '10'])
    t.status.set('t1', 'waiting')
    await t.live.refresh('t1')
    t.live.closed('c1')
    await vi.advanceTimersByTimeAsync(TYPING_RENEWED_EVERY_MS * 2)
    expect(t.typed).toHaveLength(4)
  })

  it('a session with no thread of its own types nowhere, and a Codex session Koloft cannot read does not type', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.names.set('t1', 'a')
    t.status.set('t1', 'working')
    await t.live.refresh('t1')
    t.withThread('t2', 'b', '102')
    t.status.set('t2', 'working')
    t.unknown.add('t2')
    await t.live.refresh('t2')
    await vi.advanceTimersByTimeAsync(TYPING_RENEWED_EVERY_MS)
    expect(t.typed).toEqual([])
  })
})
