import { describe, it, expect } from 'vitest'
import {
  bindingProblem,
  GLOBAL_SCOPE,
  keepPinnedScopes,
  newChannelGuild,
  newChannelName,
  sanitizeDiscord
} from '@shared/conductors'
import { buildResetPatch, sanitizeLoadedSettings, sanitizeSettingsPatch } from '@shared/settingsOps'
import type { ConductorBinding } from '@shared/types'

function binding(id: string, scope: string, channelId: string): ConductorBinding {
  return {
    id,
    scope,
    backend: 'claude',
    channel: { guildId: '100', channelId, name: `ch-${channelId}` },
    touched: []
  }
}

describe('bindingProblem', () => {
  const bound = [binding('g', GLOBAL_SCOPE, '1'), binding('a', '/ws/a', '2')]

  it('allows one global conductor only', () => {
    expect(bindingProblem(bound, { scope: GLOBAL_SCOPE, channelId: '9' })).toBe(
      'Global already has an Assist.'
    )
  })

  it('allows one conductor per workspace', () => {
    expect(bindingProblem(bound, { scope: '/ws/a', channelId: '9' })).toBe(
      'a already has an Assist.'
    )
  })

  it('allows one conductor per channel', () => {
    expect(bindingProblem(bound, { scope: '/ws/b', channelId: '2' })).toBe(
      'That channel is already bound to the a Assist.'
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
            { threadId: '9', keys: ['k1', 'k2'], name: 'Fix login', lastMessageId: '12' },
            { threadId: 'nope', keys: ['k3'] },
            { threadId: '10', keys: [] }
          ]
        }
      ]
    })
    expect(doc.bindings[0].threads).toEqual([
      { threadId: '9', keys: ['k1', 'k2'], name: 'Fix login', lastMessageId: '12' }
    ])
  })
})

describe('the server a new channel goes in', () => {
  const guilds = [
    { id: '1', name: 'someone else’s', ownerId: '999' },
    { id: '2', name: 'mine', ownerId: '555' },
    { id: '3', name: 'also mine', ownerId: '555' }
  ]

  it('is a server the owner owns, never one the bot was only invited to', () => {
    expect(newChannelGuild([], guilds, '555')).toBe('2')
    expect(newChannelGuild([], guilds.slice(0, 1), '555')).toBeUndefined()
    expect(newChannelGuild([], guilds, undefined)).toBeUndefined()
  })

  it('is the owned server a channel is already bound in', () => {
    expect(newChannelGuild([binding('g', GLOBAL_SCOPE, '1')], guilds, '555')).toBe('2')
    const inThree = {
      ...binding('g', GLOBAL_SCOPE, '1'),
      channel: { guildId: '3', channelId: '1', name: 'x' }
    }
    expect(newChannelGuild([inThree], guilds, '555')).toBe('3')
  })
})

describe('a new channel’s name', () => {
  it('is #global for the global Assist and the folder name for a workspace, written the way Discord stores it', () => {
    expect(newChannelName(GLOBAL_SCOPE)).toBe('global')
    expect(newChannelName('/Users/me/My Project.v2 项目')).toBe('my-projectv2-项目')
  })

  it('adds the machine for a remote workspace, without the user and with its dots as hyphens', () => {
    expect(newChannelName('ssh://me@devbox.lan/home/me/ws-b')).toBe('ws-b-devbox-lan')
    expect(newChannelName('ssh://box/srv/api')).toBe('api-box')
  })
})

describe('loading settings written before Assist records existed', () => {
  const v038 = {
    discord: {
      userId: '555',
      bindings: [
        {
          ...binding('g', GLOBAL_SCOPE, '1'),
          sessionIds: ['old-1', 'old-2'],
          lastSessionKey: 'old-2'
        },
        { ...binding('a', '/ws/a', '2'), backend: 'codex', sessionIds: [] }
      ]
    }
  }

  it('moves each binding’s sessions to its scope’s Assist record, one to one, and the binding keeps its Discord parts', () => {
    const s = sanitizeLoadedSettings(v038)
    expect(s.assistSessions).toEqual([
      { scope: GLOBAL_SCOPE, sessionIds: ['old-1', 'old-2'], lastSessionKey: 'old-2' }
    ])
    expect(s.discord.bindings.map((b) => b.id)).toEqual(['g', 'a'])
    expect(s.discord.bindings[0]).not.toHaveProperty('sessionIds')
  })

  it('reading the same file again changes nothing, and a record already there keeps its newest session', () => {
    const once = sanitizeLoadedSettings(v038)
    const twice = sanitizeLoadedSettings({ ...v038, assistSessions: once.assistSessions })
    expect(twice.assistSessions).toEqual(once.assistSessions)
    const newer = sanitizeLoadedSettings({
      ...v038,
      assistSessions: [{ scope: GLOBAL_SCOPE, sessionIds: ['new-1'], lastSessionKey: 'new-1' }]
    })
    expect(newer.assistSessions).toEqual([
      { scope: GLOBAL_SCOPE, sessionIds: ['new-1', 'old-1', 'old-2'], lastSessionKey: 'new-1' }
    ])
  })

  it('every binding it writes back still has the backend an older Koloft needs to keep it', () => {
    const written = JSON.parse(JSON.stringify(sanitizeLoadedSettings(v038)))
    for (const b of written.discord.bindings) expect(['claude', 'codex']).toContain(b.backend)
    expect(sanitizeDiscord(written.discord).bindings).toHaveLength(2)
  })

  it('Assist records are left out of a settings reset and of what the window may write', () => {
    expect(buildResetPatch()).not.toHaveProperty('assistSessions')
    expect(sanitizeSettingsPatch({ assistSessions: [], fontSize: 12 })).toEqual({ fontSize: 12 })
  })
})

describe('keepPinnedScopes', () => {
  it('drops a workspace binding whose workspace is no longer pinned and keeps the global one', () => {
    const kept = keepPinnedScopes(
      [binding('g', GLOBAL_SCOPE, '1'), binding('a', '/ws/a', '2'), binding('b', '/ws/b', '3')],
      ['/ws/b']
    )
    expect(kept.map((b) => b.id)).toEqual(['g', 'b'])
  })
})
