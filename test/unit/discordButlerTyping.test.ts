import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SessionStatus } from '../../src/shared/types'
import { ButlerTyping, TYPING_RENEWED_EVERY_MS } from '../../src/main/discord/butlerTyping'

function setup() {
  const status = new Map<string, SessionStatus>()
  const channels = new Map<string, string>()
  const gone = new Set<string>()
  const typed: string[] = []
  const typing = new ButlerTyping({
    link: { typing: async (channelId: string) => void typed.push(channelId) },
    channelOf: (tabId) => channels.get(tabId),
    status: (tabId) => status.get(tabId),
    alive: (tabId) => !gone.has(tabId)
  })
  return { typing, status, channels, gone, typed }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('"Koloft is typing…" shows in the butler’s channel while the butler works', () => {
  it('a working butler types in its channel, renewed before Discord lets it lapse, and stops once its turn ends', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.channels.set('b1', '10')
    t.status.set('b1', 'working')
    t.typing.refresh('b1')
    await vi.advanceTimersByTimeAsync(0)
    expect(t.typed).toEqual(['10'])
    await vi.advanceTimersByTimeAsync(TYPING_RENEWED_EVERY_MS)
    expect(t.typed).toEqual(['10', '10'])
    t.status.set('b1', 'waiting')
    t.typing.refresh('b1')
    await vi.advanceTimersByTimeAsync(TYPING_RENEWED_EVERY_MS * 2)
    expect(t.typed).toEqual(['10', '10'])
  })

  it('a session that is not the butler types nowhere, however it works', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.status.set('s1', 'working')
    t.typing.refresh('s1')
    await vi.advanceTimersByTimeAsync(TYPING_RENEWED_EVERY_MS)
    expect(t.typed).toEqual([])
  })

  it('a "working" that lands after the butler’s terminal is gone starts no typing that nothing would stop', async () => {
    vi.useFakeTimers()
    const t = setup()
    t.channels.set('b1', '10')
    t.typing.forget('b1')
    t.gone.add('b1')
    t.status.set('b1', 'working')
    t.typing.refresh('b1')
    await vi.advanceTimersByTimeAsync(TYPING_RENEWED_EVERY_MS * 2)
    expect(t.typed).toEqual([])
  })
})
