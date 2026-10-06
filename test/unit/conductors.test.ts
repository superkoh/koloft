import { describe, it, expect } from 'vitest'
import {
  bindingProblem,
  GLOBAL_SCOPE,
  keepPinnedBindings,
  sanitizeDiscord
} from '@shared/conductors'
import type { ConductorBinding } from '@shared/types'

function binding(id: string, scope: string, channelId: string): ConductorBinding {
  return {
    id,
    scope,
    backend: 'claude',
    channel: { guildId: '100', channelId, name: `ch-${channelId}` },
    sessionIds: [],
    touched: []
  }
}

describe('bindingProblem', () => {
  const bound = [binding('g', GLOBAL_SCOPE, '1'), binding('a', '/ws/a', '2')]

  it('allows one global conductor only', () => {
    expect(bindingProblem(bound, { scope: GLOBAL_SCOPE, channelId: '9' })).toBe(
      'Global already has a conductor.'
    )
  })

  it('allows one conductor per workspace', () => {
    expect(bindingProblem(bound, { scope: '/ws/a', channelId: '9' })).toBe(
      'a already has a conductor.'
    )
  })

  it('allows one conductor per channel', () => {
    expect(bindingProblem(bound, { scope: '/ws/b', channelId: '2' })).toBe(
      'That channel is already bound to the a conductor.'
    )
  })

  it('lets a conductor keep its own scope and channel when it changes', () => {
    expect(bindingProblem(bound, { id: 'a', scope: '/ws/a', channelId: '2' })).toBeUndefined()
  })
})

describe('sanitizeDiscord', () => {
  it('starts with no bindings', () => {
    expect(sanitizeDiscord(undefined)).toEqual({ bindings: [] })
  })

  it('drops a broken binding, one whose channel has no name, and a second one for a scope or channel already taken', () => {
    const nameless = binding('nameless', '/ws/c', '5')
    const doc = sanitizeDiscord({
      bindings: [
        binding('a', '/ws/a', '1'),
        binding('dup-scope', '/ws/a', '2'),
        binding('dup-channel', '/ws/b', '1'),
        { ...binding('bad', 'relative/path', '3') },
        { ...nameless, channel: { guildId: '100', channelId: '5' } },
        binding('b', '/ws/b', '4')
      ]
    })
    expect(doc.bindings.map((b) => b.id)).toEqual(['a', 'b'])
  })

  it('keeps each session’s thread across a restart, and drops one with no thread id or no session', () => {
    const doc = sanitizeDiscord({
      bindings: [
        {
          ...binding('a', '/ws/a', '1'),
          threads: [
            { threadId: '9', keys: ['k1', 'k2'], lastMessageId: '12' },
            { threadId: 'nope', keys: ['k3'] },
            { threadId: '10', keys: [] }
          ]
        }
      ]
    })
    expect(doc.bindings[0].threads).toEqual([
      { threadId: '9', keys: ['k1', 'k2'], lastMessageId: '12' }
    ])
  })
})

describe('keepPinnedBindings', () => {
  it('drops a workspace binding whose workspace is no longer pinned and keeps the global one', () => {
    const kept = keepPinnedBindings(
      [binding('g', GLOBAL_SCOPE, '1'), binding('a', '/ws/a', '2'), binding('b', '/ws/b', '3')],
      ['/ws/b']
    )
    expect(kept.map((b) => b.id)).toEqual(['g', 'b'])
  })
})
