import type {
  AssistRecord,
  ButlerSetting,
  ConductorBinding,
  DiscordChannel,
  DiscordGuild,
  DiscordSettings,
  SessionThread
} from './types'
import { DEFAULT_BUTLER_NAME } from './types'
import { basename } from './preview'
import { isAbsoluteOnHost, parseRemoteKey } from './remoteKey'
import { backendIdOf } from './sessionBackend'
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

export function channelLabel(binding: Pick<ConductorBinding, 'channel'>): string {
  return `#${binding.channel.name}`
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
  bindings: ConductorBinding[],
  guilds: DiscordGuild[],
  ownerId: string | undefined
): string | undefined {
  const owned = ownedGuilds(guilds, ownerId).map((g) => g.id)
  const bound = bindings.map((b) => b.channel.guildId).find((id) => owned.includes(id))
  return bound ?? owned[0]
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

function cleanThreads(raw: unknown): SessionThread[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((t: unknown) => {
    if (!isRecord(t) || !isDiscordId(t.threadId)) return []
    const keys = strings(t.keys)
    if (!keys.length) return []
    return [
      {
        threadId: t.threadId,
        keys,
        ...(typeof t.name === 'string' ? { name: t.name } : {}),
        ...(isDiscordId(t.lastMessageId) ? { lastMessageId: t.lastMessageId } : {})
      }
    ]
  })
}

function isScope(scope: unknown): scope is string {
  return typeof scope === 'string' && (scope === GLOBAL_SCOPE || isAbsoluteOnHost(scope))
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

function cleanBinding(raw: unknown): ConductorBinding | null {
  if (!isRecord(raw)) return null
  const { id, scope, lastMessageId } = raw
  const backend = backendIdOf(raw.backend)
  const threads = cleanThreads(raw.threads)
  const channel = cleanChannel(raw.channel)
  if (typeof id !== 'string' || !id || !backend) return null
  if (!isScope(scope)) return null
  if (!channel) return null
  return {
    id,
    scope,
    backend,
    channel,
    touched: strings(raw.touched),
    ...(threads.length ? { threads } : {}),
    ...(isDiscordId(lastMessageId) ? { lastMessageId } : {})
  }
}

function cleanRecord(raw: unknown): AssistRecord | null {
  if (!isRecord(raw) || !isScope(raw.scope)) return null
  const { lastSessionKey } = raw
  return {
    scope: raw.scope,
    sessionIds: strings(raw.sessionIds),
    ...(typeof lastSessionKey === 'string' ? { lastSessionKey } : {})
  }
}

export function sanitizeAssistSessions(raw: unknown, rawDiscord: unknown): AssistRecord[] {
  const records: AssistRecord[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const r = cleanRecord(item)
    if (r && !records.some((x) => x.scope === r.scope)) records.push(r)
  }
  const bindings =
    isRecord(rawDiscord) && Array.isArray(rawDiscord.bindings) ? rawDiscord.bindings : []
  for (const b of bindings) {
    const lifted = cleanRecord(b)
    if (!lifted || (!lifted.sessionIds.length && !lifted.lastSessionKey)) continue
    const at = records.findIndex((x) => x.scope === lifted.scope)
    if (at < 0) {
      records.push(lifted)
      continue
    }
    const kept = records[at]
    records[at] = {
      ...kept,
      sessionIds: [...new Set([...kept.sessionIds, ...lifted.sessionIds])],
      ...(kept.lastSessionKey || !lifted.lastSessionKey
        ? {}
        : { lastSessionKey: lifted.lastSessionKey })
    }
  }
  return records.filter((r) => r.scope === GLOBAL_SCOPE)
}

function lastUsed(bindings: ConductorBinding[]): ConductorBinding | undefined {
  return bindings.reduce<ConductorBinding | undefined>((best, b) => {
    if (!best) return b
    if (!b.lastMessageId) return best
    return !best.lastMessageId || newerSnowflake(b.lastMessageId, best.lastMessageId) ? b : best
  }, undefined)
}

function butlerBinding(bindings: ConductorBinding[]): ConductorBinding | undefined {
  const kept = bindings.find((b) => b.scope === GLOBAL_SCOPE) ?? lastUsed(bindings)
  return kept && { ...kept, scope: GLOBAL_SCOPE }
}

export function sanitizeDiscord(raw: unknown): DiscordSettings {
  const doc = isRecord(raw) ? raw : {}
  const bindings: ConductorBinding[] = []
  for (const item of Array.isArray(doc.bindings) ? doc.bindings : []) {
    const b = cleanBinding(item)
    if (b) bindings.push(b)
  }
  const kept = butlerBinding(bindings)
  const category = cleanChannel(doc.category)
  return {
    ...(category ? { category } : {}),
    ...(isDiscordId(doc.userId)
      ? {
          userId: doc.userId,
          ...(typeof doc.userName === 'string' ? { userName: doc.userName } : {})
        }
      : {}),
    bindings: kept ? [kept] : []
  }
}
