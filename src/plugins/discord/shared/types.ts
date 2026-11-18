export interface DiscordChannel {
  guildId: string
  channelId: string
  name: string
}

export interface DiscordSettings {
  userId?: string
  userName?: string
  channel?: DiscordChannel
  lastMessageId?: string
  category?: DiscordChannel
  oldThreadsArchived?: true
  rooms?: SessionRoom[]
}

export interface SessionRoom {
  threadId: string
  keys: string[]
  name: string
  lastMessageId?: string
  putDown?: true
}

export type DiscordPhase =
  'off' | 'connecting' | 'connected' | 'token' | 'intents' | 'unreachable' | 'elsewhere'

export interface DiscordStatus {
  phase: DiscordPhase
  botName?: string
  applicationId?: string
  guilds: DiscordGuild[]
  appOwner?: DiscordUser
  failing: Record<string, string>
  candidate?: { name: string; text: string; at: number }
}

export interface DiscordGuild {
  id: string
  name: string
  ownerId?: string
}

export interface DiscordUser {
  id: string
  name: string
}

export const DISCORD_OFF: DiscordStatus = { phase: 'off', guilds: [], failing: {} }

export type ConductorSaveResult =
  { ok: true } | { ok: false; error: string; cannotMakeChannels?: boolean }
