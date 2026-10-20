import type {
  ButlerSession,
  ButlerSetting,
  DiscordChannel,
  DiscordGuild,
  DiscordSettings
} from './types'
import { DEFAULT_BUTLER_NAME } from './types'
import { basename } from './preview'
import { parseRemoteKey } from './remoteKey'
import { isRecord } from './workbenchState'

export const GLOBAL_SCOPE = 'global'

const DISCORD_ID_RE = /^\d{1,30}$/

const BUTLER_NAME_MAX_CHARS = 40

export function isDiscordId(value: unknown): value is string {
  return typeof value === 'string' && DISCORD_ID_RE.test(value)
}

export function newerSnowflake(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b)
}

export function scopeName(scope: string): string {
  if (scope === GLOBAL_SCOPE) return 'Global'
  return basename(parseRemoteKey(scope)?.path ?? scope)
}

export function butlerName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  return name.slice(0, BUTLER_NAME_MAX_CHARS) || DEFAULT_BUTLER_NAME
}

export function butlerSetting(name: string, formerNames: string[]): ButlerSetting {
  return { name, formerNames: [...new Set(formerNames)].filter((n) => n !== name) }
}

export function butlerNames(b: ButlerSetting): string[] {
  return [b.name, ...b.formerNames]
}

export function renamedButler(current: ButlerSetting, typed: string): ButlerSetting {
  return butlerSetting(butlerName(typed), [...current.formerNames, current.name])
}

export function butlerTitle(name: string): string {
  return `${name} · Butler`
}

export function asPeerName(title: string): string {
  return title.replace(/\s+/g, '-')
}

const OLD_BUTLER_PEER_NAMES = ['Global-Assist', 'Global-conductor']

export function peerNamesOf(name: string): string[] {
  return [asPeerName(name), ...OLD_BUTLER_PEER_NAMES]
}

export function assistTaskName(name: string, task: string): string {
  return `${name}-${task}`
}

export function setUpWith(name: string): string {
  return `Set up with ${name}`
}

export function channelLabel(channel: DiscordChannel): string {
  return `#${channel.name}`
}

export const NEW_CHANNEL_NAME = 'global'

export const NEW_CHANNEL_TOPIC = 'Koloft · your butler, for all workspaces'

const INVITE_PERMISSIONS = 326417615952

export function inviteLink(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&permissions=${INVITE_PERMISSIONS}&scope=bot`
}

export function ownedGuilds(guilds: DiscordGuild[], ownerId: string | undefined): DiscordGuild[] {
  return guilds.filter((g) => ownerId && g.ownerId === ownerId)
}

export function newChannelGuild(
  bound: DiscordChannel | undefined,
  guilds: DiscordGuild[],
  ownerId: string | undefined
): string | undefined {
  const owned = ownedGuilds(guilds, ownerId).map((g) => g.id)
  return bound && owned.includes(bound.guildId) ? bound.guildId : owned[0]
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

function cleanChannel(raw: unknown): DiscordChannel | null {
  if (
    !isRecord(raw) ||
    !isDiscordId(raw.guildId) ||
    !isDiscordId(raw.channelId) ||
    typeof raw.name !== 'string'
  )
    return null
  return { guildId: raw.guildId, channelId: raw.channelId, name: raw.name }
}

interface LegacyBinding {
  scope: unknown
  channel: DiscordChannel
  lastMessageId?: string
  sessionIds: string[]
  lastSessionKey?: string
}

function legacyBindings(rawDiscord: unknown): LegacyBinding[] {
  const list = isRecord(rawDiscord) && Array.isArray(rawDiscord.bindings) ? rawDiscord.bindings : []
  return list.flatMap((raw: unknown) => {
    const channel = isRecord(raw) && cleanChannel(raw.channel)
    if (!isRecord(raw) || !channel) return []
    return [
      {
        scope: raw.scope,
        channel,
        ...(isDiscordId(raw.lastMessageId) ? { lastMessageId: raw.lastMessageId } : {}),
        ...cleanSession(raw)
      }
    ]
  })
}

function cleanSession(raw: Record<string, unknown>): ButlerSession {
  const { lastSessionKey } = raw
  return {
    sessionIds: strings(raw.sessionIds),
    ...(typeof lastSessionKey === 'string' ? { lastSessionKey } : {})
  }
}

function mergedSessions(sessions: ButlerSession[]): ButlerSession {
  const lastSessionKey = sessions.find((s) => s.lastSessionKey)?.lastSessionKey
  return {
    sessionIds: [...new Set(sessions.flatMap((s) => s.sessionIds))],
    ...(lastSessionKey ? { lastSessionKey } : {})
  }
}

export function sanitizeButlerSession(
  raw: unknown,
  legacyAssistSessions: unknown,
  rawDiscord: unknown
): ButlerSession {
  const legacy = Array.isArray(legacyAssistSessions) ? legacyAssistSessions : []
  return mergedSessions([
    ...(isRecord(raw) ? [cleanSession(raw)] : []),
    ...legacy.filter((r) => isRecord(r) && r.scope === GLOBAL_SCOPE).map(cleanSession),
    ...legacyBindings(rawDiscord).filter((b) => b.scope === GLOBAL_SCOPE)
  ])
}

function lastUsed(bindings: LegacyBinding[]): LegacyBinding | undefined {
  return bindings.reduce<LegacyBinding | undefined>((best, b) => {
    if (!best) return b
    if (!b.lastMessageId) return best
    return !best.lastMessageId || newerSnowflake(b.lastMessageId, best.lastMessageId) ? b : best
  }, undefined)
}

function boundChannel(
  doc: Record<string, unknown>
): Pick<DiscordSettings, 'channel' | 'lastMessageId'> {
  const channel = cleanChannel(doc.channel)
  if (channel)
    return {
      channel,
      ...(isDiscordId(doc.lastMessageId) ? { lastMessageId: doc.lastMessageId } : {})
    }
  const bindings = legacyBindings(doc)
  const kept = bindings.find((b) => b.scope === GLOBAL_SCOPE) ?? lastUsed(bindings)
  return kept
    ? {
        channel: kept.channel,
        ...(kept.lastMessageId ? { lastMessageId: kept.lastMessageId } : {})
      }
    : {}
}

export function sanitizeDiscord(raw: unknown): DiscordSettings {
  const doc = isRecord(raw) ? raw : {}
  const category = cleanChannel(doc.category)
  return {
    ...(category ? { category } : {}),
    ...(isDiscordId(doc.userId)
      ? {
          userId: doc.userId,
          ...(typeof doc.userName === 'string' ? { userName: doc.userName } : {})
        }
      : {}),
    ...boundChannel(doc),
    ...(doc.oldThreadsArchived === true ? { oldThreadsArchived: true } : {})
  }
}
