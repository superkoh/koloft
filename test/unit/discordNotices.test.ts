import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ConductorBinding } from '../../src/shared/types'
import {
  NOTICE_COALESCE_MS,
  noticeChannel,
  noticeKindOf,
  Notices
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

afterEach(() => vi.useRealTimers())

describe('Discord notices: which session state change reaches which channel', () => {
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

  it('"finished" goes only to a conductor that touched the session; "waiting" and "closed" go to any conductor whose scope holds it', () => {
    const subject = { key: 's1', name: 'fix-login', workspace: WS }
    const untouched = [binding(WS, '10')]
    expect(noticeChannel(untouched, subject, 'finished')).toBeUndefined()
    expect(noticeChannel(untouched, subject, 'waiting')).toBe('10')
    expect(noticeChannel(untouched, subject, 'closed')).toBe('10')
    expect(noticeChannel([binding(WS, '10', ['s1'])], subject, 'finished')).toBe('10')
  })

  it('a session outside a workspace conductor’s scope reaches only the global conductor, and with no conductor in scope nothing is sent', () => {
    const subject = { key: 's1', name: 'other', workspace: '/Users/me/elsewhere' }
    expect(noticeChannel([binding(WS, '10')], subject, 'waiting')).toBeUndefined()
    expect(noticeChannel([binding(WS, '10'), binding('global', '20')], subject, 'waiting')).toBe(
      '20'
    )
  })

  it('when the global and the workspace conductor both cover it, only the workspace channel gets it', () => {
    const subject = { key: 's1', name: 'fix-login', workspace: WS }
    const both = [binding('global', '20', ['s1']), binding(WS, '10', ['s1'])]
    expect(noticeChannel(both, subject, 'waiting')).toBe('10')
    expect(noticeChannel(both, subject, 'finished')).toBe('10')
    expect(
      noticeChannel([binding('global', '20', ['s1']), binding(WS, '10')], subject, 'finished')
    ).toBe('20')
  })

  it('notices for one channel within a second go out as one message, in order; a conductor’s own session gives none, nor a turn a slash command Koloft typed is running', async () => {
    vi.useFakeTimers()
    const post = vi.fn()
    const names: Record<string, string> = {
      a: 'alpha',
      b: 'beta',
      c: 'gamma',
      d: 'conductor',
      e: 'epsilon'
    }
    const notices = new Notices({
      bindings: () => [binding(WS, '10', ['a', 'e'])],
      commandRunning: (tabId) => tabId === 'e',
      post,
      subject: (tabId) => ({
        key: tabId,
        name: names[tabId],
        workspace: WS,
        conductor: tabId === 'd' ? 'b1' : undefined
      }),
      peerName: async () => null,
      awaitsInput: () => false,
      detail: async () => 'npm test'
    })
    notices.onStatus('a', 'working', 'waiting')
    notices.onStatus('e', 'working', 'waiting')
    notices.onStatus('b', 'working', 'approval')
    notices.onStatus('d', 'working', 'approval')
    await vi.advanceTimersByTimeAsync(0)
    notices.closed('c')
    notices.closed('d')
    expect(post).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(NOTICE_COALESCE_MS)
    expect(post.mock.calls).toEqual([
      ['10', '🔔 alpha finished.\n❓ beta is waiting for you: npm test\n⏹ gamma closed.']
    ])
    notices.started('10', 'docs-links', WS, 'codex')
    vi.advanceTimersByTime(NOTICE_COALESCE_MS)
    expect(post.mock.calls[1]).toEqual(['10', '▶ Started docs-links (koloft, Codex)'])
  })

  it('a session started under a name is called by that name, not by its title, and still by it once it has closed and has no name left', async () => {
    vi.useFakeTimers()
    const post = vi.fn()
    let live = true
    const notices = new Notices({
      bindings: () => [binding(WS, '10', ['a', 'b'])],
      post,
      subject: (tabId) => ({
        key: tabId,
        name: tabId === 'a' ? 'Koloft started you because the session' : 'beta',
        workspace: WS
      }),
      peerName: async (tabId) => (tabId === 'a' && live ? 'helper-1a2b3c' : null),
      awaitsInput: () => false,
      commandRunning: () => false,
      detail: async () => undefined
    })
    notices.onStatus('a', 'working', 'waiting')
    notices.onStatus('b', 'working', 'waiting')
    await vi.advanceTimersByTimeAsync(0)
    live = false
    notices.closed('a')
    notices.forget('a')
    await vi.advanceTimersByTimeAsync(NOTICE_COALESCE_MS)
    expect(post.mock.calls).toEqual([
      ['10', '🔔 helper-1a2b3c finished.\n🔔 beta finished.\n⏹ helper-1a2b3c closed.']
    ])
  })

  it('a session that already left the list when its terminal exits is still announced as closed, once, in its conductor’s channel', async () => {
    vi.useFakeTimers()
    const post = vi.fn()
    const listed = new Set(['a'])
    const notices = new Notices({
      bindings: () => [binding('global', '20'), binding(WS, '10')],
      post,
      subject: (tabId) =>
        listed.has(tabId) ? { key: tabId, name: 'alpha', workspace: WS } : undefined,
      peerName: async () => null,
      awaitsInput: () => false,
      commandRunning: () => false,
      detail: async () => undefined
    })
    notices.onStatus('a', undefined, 'idle')
    listed.delete('a')
    notices.closed('a')
    notices.closed('a')
    notices.forget('a')
    notices.closed('a')
    await vi.advanceTimersByTimeAsync(NOTICE_COALESCE_MS)
    expect(post.mock.calls).toEqual([['10', '⏹ alpha closed.']])
  })
})
