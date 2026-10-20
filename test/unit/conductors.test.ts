import { describe, it, expect } from 'vitest'
import {
  butlerName,
  GLOBAL_SCOPE,
  newChannelGuild,
  peerNamesOf,
  renamedButler,
  sanitizeDiscord
} from '@shared/conductors'
import { buildResetPatch, sanitizeLoadedSettings, sanitizeSettingsPatch } from '@shared/settingsOps'
import type { ConductorBinding } from '@shared/types'

function binding(
  id: string,
  scope: string,
  channelId: string,
  lastMessageId?: string
): ConductorBinding {
  return {
    id,
    scope,
    backend: 'claude',
    channel: { guildId: '100', channelId, name: `ch-${channelId}` },
    touched: [],
    ...(lastMessageId ? { lastMessageId } : {})
  }
}

describe('sanitizeDiscord', () => {
  it('starts with no bindings', () => {
    expect(sanitizeDiscord(undefined)).toEqual({ bindings: [] })
  })

  it('keeps only the global channel once workspaces had channels of their own: the butler listens there alone', () => {
    const doc = sanitizeDiscord({
      bindings: [
        binding('a', '/ws/a', '1', '900'),
        binding('g', GLOBAL_SCOPE, '2', '100'),
        binding('b', '/ws/b', '3')
      ]
    })
    expect(doc.bindings.map((b) => [b.id, b.scope, b.channel.channelId])).toEqual([
      ['g', GLOBAL_SCOPE, '2']
    ])
  })

  it('turns the workspace channel last written in into the butler’s, for an owner who never bound #global', () => {
    const doc = sanitizeDiscord({
      bindings: [
        binding('a', '/ws/a', '1', '1000'),
        binding('b', 'ssh://box/srv/b', '2', '1500000000000000001'),
        binding('c', '/ws/c', '3')
      ]
    })
    expect(doc.bindings).toEqual([{ ...binding('b', GLOBAL_SCOPE, '2', '1500000000000000001') }])
  })

  it('takes the first workspace channel when none was ever written in', () => {
    const doc = sanitizeDiscord({
      bindings: [binding('a', '/ws/a', '1'), binding('b', '/ws/b', '2')]
    })
    expect(doc.bindings.map((b) => [b.id, b.scope])).toEqual([['a', GLOBAL_SCOPE]])
  })

  it('drops a broken binding and one whose channel has no name', () => {
    const doc = sanitizeDiscord({
      bindings: [
        { ...binding('bad', 'relative/path', '3') },
        { ...binding('nameless', GLOBAL_SCOPE, '5'), channel: { guildId: '100', channelId: '5' } }
      ]
    })
    expect(doc.bindings).toEqual([])
  })

  it('keeps each session’s thread across a restart, and drops one with no thread id or no session', () => {
    const doc = sanitizeDiscord({
      bindings: [
        {
          ...binding('g', GLOBAL_SCOPE, '1'),
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

describe('the butler’s name', () => {
  it('is Alfred until the owner picks another, and stays one short line', () => {
    expect(butlerName(undefined)).toBe('Alfred')
    expect(butlerName('   ')).toBe('Alfred')
    expect(butlerName('  Jeeves \n the second ')).toBe('Jeeves the second')
    expect(butlerName('x'.repeat(100))).toHaveLength(40)
  })

  it('other sessions still reach the butler by the names the global Assist had', () => {
    expect(peerNamesOf('Jeeves')).toEqual(['Jeeves', 'Global-Assist', 'Global-conductor'])
  })

  it('a rename keeps every name the butler had before, and survives a save from the window, a restart and a settings reset', () => {
    const once = renamedButler({ name: 'Alfred', formerNames: [] }, ' Jeeves ')
    const back = renamedButler(renamedButler(once, 'Bunter'), 'Alfred')
    expect(once).toEqual({ name: 'Jeeves', formerNames: ['Alfred'] })
    expect(back).toEqual({ name: 'Alfred', formerNames: ['Jeeves', 'Bunter'] })
    expect(sanitizeSettingsPatch({ butler: back })).toEqual({ butler: back })
    expect(buildResetPatch()).not.toHaveProperty('butler')
    expect(sanitizeLoadedSettings({ butler: back }).butler).toEqual(back)
    expect(sanitizeLoadedSettings({ butler: { name: 'Jeeves' } }).butler).toEqual({
      name: 'Jeeves',
      formerNames: []
    })
  })
})

describe('loading settings written before the butler', () => {
  const v038 = {
    discord: {
      userId: '555',
      bindings: [
        {
          ...binding('g', GLOBAL_SCOPE, '1'),
          sessionIds: ['old-1', 'old-2'],
          lastSessionKey: 'old-2'
        },
        { ...binding('a', '/ws/a', '2'), backend: 'codex', sessionIds: ['ws-1'] }
      ]
    }
  }

  it('the global Assist’s conversation becomes the butler’s, and a workspace Assist’s is left behind', () => {
    const s = sanitizeLoadedSettings(v038)
    expect(s.assistSessions).toEqual([
      { scope: GLOBAL_SCOPE, sessionIds: ['old-1', 'old-2'], lastSessionKey: 'old-2' }
    ])
    expect(s.discord.bindings.map((b) => b.id)).toEqual(['g'])
    expect(s.discord.bindings[0]).not.toHaveProperty('sessionIds')
  })

  it('reading the same file again changes nothing, and a record already there keeps its newest session', () => {
    const once = sanitizeLoadedSettings(v038)
    const twice = sanitizeLoadedSettings({ ...v038, assistSessions: once.assistSessions })
    expect(twice.assistSessions).toEqual(once.assistSessions)
    const newer = sanitizeLoadedSettings({
      ...v038,
      assistSessions: [
        { scope: GLOBAL_SCOPE, sessionIds: ['new-1'], lastSessionKey: 'new-1' },
        { scope: '/ws/a', sessionIds: ['ws-2'], lastSessionKey: 'ws-2' }
      ]
    })
    expect(newer.assistSessions).toEqual([
      { scope: GLOBAL_SCOPE, sessionIds: ['new-1', 'old-1', 'old-2'], lastSessionKey: 'new-1' }
    ])
  })

  it('the binding it writes back still has the backend an older Koloft needs to keep it', () => {
    const written = JSON.parse(JSON.stringify(sanitizeLoadedSettings(v038)))
    for (const b of written.discord.bindings) expect(['claude', 'codex']).toContain(b.backend)
    expect(sanitizeDiscord(written.discord).bindings).toHaveLength(1)
  })

  it('the Assist setting is kept as it was, so the owner is not asked to agree to skipping permissions again', () => {
    const s = sanitizeLoadedSettings({
      ...v038,
      assist: { on: false, backend: 'codex' },
      skipPermissions: true
    })
    expect(s.assist).toEqual({ on: false, backend: 'codex' })
    expect(s.skipPermissionsAgreed).toBe(true)
  })

  it('Assist records are left out of a settings reset and of what the window may write', () => {
    expect(buildResetPatch()).not.toHaveProperty('assistSessions')
    expect(sanitizeSettingsPatch({ assistSessions: [], fontSize: 12 })).toEqual({ fontSize: 12 })
  })
})
