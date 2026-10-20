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
import type { DiscordChannel } from '@shared/types'

function channel(channelId: string, guildId = '100'): DiscordChannel {
  return { guildId, channelId, name: `ch-${channelId}` }
}

function oldBinding(id: string, scope: string, channelId: string, lastMessageId?: string) {
  return {
    id,
    scope,
    backend: 'claude',
    channel: channel(channelId),
    touched: [],
    ...(lastMessageId ? { lastMessageId } : {})
  }
}

describe('sanitizeDiscord', () => {
  it('starts with no channel', () => {
    expect(sanitizeDiscord(undefined)).toEqual({})
  })

  it('keeps the butler’s channel, the last message it read and that the old threads were archived, across a restart', () => {
    expect(
      sanitizeDiscord({
        userId: '555',
        channel: channel('2'),
        lastMessageId: '90',
        oldThreadsArchived: true
      })
    ).toEqual({
      userId: '555',
      channel: channel('2'),
      lastMessageId: '90',
      oldThreadsArchived: true
    })
  })

  it('drops a channel with no name', () => {
    expect(sanitizeDiscord({ channel: { guildId: '100', channelId: '5' } })).toEqual({})
  })
})

describe('loading the bindings an older Koloft wrote', () => {
  it('keeps only the global channel once workspaces had channels of their own: the butler listens there alone', () => {
    const doc = sanitizeDiscord({
      bindings: [
        oldBinding('a', '/ws/a', '1', '900'),
        oldBinding('g', GLOBAL_SCOPE, '2', '100'),
        oldBinding('b', '/ws/b', '3')
      ]
    })
    expect(doc).toEqual({ channel: channel('2'), lastMessageId: '100' })
  })

  it('turns the workspace channel last written in into the butler’s, for an owner who never bound #global', () => {
    const doc = sanitizeDiscord({
      bindings: [
        oldBinding('a', '/ws/a', '1', '1000'),
        oldBinding('b', 'ssh://box/srv/b', '2', '1500000000000000001'),
        oldBinding('c', '/ws/c', '3')
      ]
    })
    expect(doc).toEqual({ channel: channel('2'), lastMessageId: '1500000000000000001' })
  })

  it('takes the first workspace channel when none was ever written in', () => {
    const doc = sanitizeDiscord({
      bindings: [oldBinding('a', '/ws/a', '1'), oldBinding('b', '/ws/b', '2')]
    })
    expect(doc.channel).toEqual(channel('1'))
  })

  it('drops a binding whose channel has no name', () => {
    const doc = sanitizeDiscord({
      bindings: [
        { ...oldBinding('g', GLOBAL_SCOPE, '5'), channel: { guildId: '100', channelId: '5' } }
      ]
    })
    expect(doc).toEqual({})
  })

  it('a channel already saved the new way wins over old bindings beside it', () => {
    const doc = sanitizeDiscord({
      channel: channel('7'),
      bindings: [oldBinding('g', GLOBAL_SCOPE, '2')]
    })
    expect(doc.channel).toEqual(channel('7'))
  })
})

describe('the server a new channel goes in', () => {
  const guilds = [
    { id: '1', name: 'someone else’s', ownerId: '999' },
    { id: '2', name: 'mine', ownerId: '555' },
    { id: '3', name: 'also mine', ownerId: '555' }
  ]

  it('is a server the owner owns, never one the bot was only invited to', () => {
    expect(newChannelGuild(undefined, guilds, '555')).toBe('2')
    expect(newChannelGuild(undefined, guilds.slice(0, 1), '555')).toBeUndefined()
    expect(newChannelGuild(undefined, guilds, undefined)).toBeUndefined()
  })

  it('is the owned server the butler’s channel is already in', () => {
    expect(newChannelGuild(channel('1', '2'), guilds, '555')).toBe('2')
    expect(newChannelGuild(channel('1', '3'), guilds, '555')).toBe('3')
    expect(newChannelGuild(channel('1', '1'), guilds, '555')).toBe('2')
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
          ...oldBinding('g', GLOBAL_SCOPE, '1'),
          sessionIds: ['old-1', 'old-2'],
          lastSessionKey: 'old-2'
        },
        { ...oldBinding('a', '/ws/a', '2'), backend: 'codex', sessionIds: ['ws-1'] }
      ]
    }
  }

  it('the global Assist’s conversation becomes the butler’s, and a workspace Assist’s is left behind', () => {
    const s = sanitizeLoadedSettings(v038)
    expect(s.butlerSession).toEqual({ sessionIds: ['old-1', 'old-2'], lastSessionKey: 'old-2' })
    expect(s.discord).toEqual({ userId: '555', channel: channel('1') })
  })

  it('the Assist records of the release before this one become the butler’s conversation, and are not written back', () => {
    const s = sanitizeLoadedSettings({
      ...v038,
      assistSessions: [
        { scope: GLOBAL_SCOPE, sessionIds: ['new-1'], lastSessionKey: 'new-1' },
        { scope: '/ws/a', sessionIds: ['ws-2'], lastSessionKey: 'ws-2' }
      ]
    })
    expect(s.butlerSession).toEqual({
      sessionIds: ['new-1', 'old-1', 'old-2'],
      lastSessionKey: 'new-1'
    })
    expect(s).not.toHaveProperty('assistSessions')
  })

  it('reading the file it writes back changes nothing', () => {
    const once = JSON.parse(JSON.stringify(sanitizeLoadedSettings(v038)))
    const twice = sanitizeLoadedSettings(once)
    expect(twice.butlerSession).toEqual(once.butlerSession)
    expect(twice.discord).toEqual(once.discord)
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

  it('the butler’s conversation is left out of a settings reset and of what the window may write', () => {
    expect(buildResetPatch()).not.toHaveProperty('butlerSession')
    expect(sanitizeSettingsPatch({ butlerSession: { sessionIds: [] }, fontSize: 12 })).toEqual({
      fontSize: 12
    })
  })
})
