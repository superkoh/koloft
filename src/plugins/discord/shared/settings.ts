import { GLOBAL_SCOPE } from '@shared/conductors'
import { isRecord, stringsIn } from '@shared/workbenchState'
import { isDiscordId, newerSnowflake } from './channels'
import type { DiscordChannel, DiscordSettings, SessionRoom } from './types'

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
  raw: Record<string, unknown>
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
        raw
      }
    ]
  })
}

export function butlerSessionsInOldBindings(rawDiscord: unknown): Record<string, unknown>[] {
  return legacyBindings(rawDiscord)
    .filter((b) => b.scope === GLOBAL_SCOPE)
    .map((b) => b.raw)
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
  const rooms = cleanRooms(doc.rooms)
  return {
    ...(category ? { category } : {}),
    ...(isDiscordId(doc.userId)
      ? {
          userId: doc.userId,
          ...(typeof doc.userName === 'string' ? { userName: doc.userName } : {})
        }
      : {}),
    ...boundChannel(doc),
    ...(doc.oldThreadsArchived === true ? { oldThreadsArchived: true } : {}),
    ...(rooms.length ? { rooms } : {})
  }
}

function cleanRooms(raw: unknown): SessionRoom[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((r: unknown) => {
    if (!isRecord(r) || !isDiscordId(r.threadId) || typeof r.name !== 'string') return []
    const keys = stringsIn(r.keys)
    if (!keys.length) return []
    return [
      {
        threadId: r.threadId,
        keys,
        name: r.name,
        ...(isDiscordId(r.lastMessageId) ? { lastMessageId: r.lastMessageId } : {}),
        ...(r.putDown === true ? { putDown: true as const } : {})
      }
    ]
  })
}
