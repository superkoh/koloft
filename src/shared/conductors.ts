import type {
  AssistRecord,
  ConductorBinding,
  DiscordChannel,
  DiscordGuild,
  DiscordSettings,
  SessionThread
} from './types'
import { basename } from './preview'
import { isAbsoluteOnHost, parseRemoteKey, remoteCopyText } from './remoteKey'
import { backendIdOf } from './sessionBackend'
import { isRecord } from './workbenchState'

export const GLOBAL_SCOPE = 'global'

const DISCORD_ID_RE = /^\d{1,30}$/

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

export function conductorName(scope: string): string {
  return `${scopeName(scope)} Assist`
}

export function asPeerName(title: string): string {
  return title.replace(/\s+/g, '-')
}

export function peerNamesOf(scope: string): string[] {
  return [asPeerName(conductorName(scope)), asPeerName(`${scopeName(scope)} conductor`)]
}

export function assistTaskName(scope: string, task: string): string {
  return `${conductorName(scope)}-${task}`
}

export function channelLabel(binding: Pick<ConductorBinding, 'channel'>): string {
  return `#${binding.channel.name}`
}

// PLATFORM§39
function discordChannelName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, '-').replace(/\./g, '')
}

function machineName(host: string): string {
  return host.replace(/^.*@/, '').replace(/\./g, '-')
}

export function newChannelName(scope: string): string {
  if (scope === GLOBAL_SCOPE) return 'global'
  const remote = parseRemoteKey(scope)
  const folder = basename(remote?.path ?? scope)
  return discordChannelName(remote ? `${folder}-${machineName(remote.host)}` : folder)
}

export function newChannelTopic(scope: string): string {
  if (scope === GLOBAL_SCOPE) return 'Koloft · global Assist, all workspaces'
  const remote = parseRemoteKey(scope)
  return remote ? remoteCopyText(remote.host, remote.path) : scope
}

const INVITE_PERMISSIONS = 326417615952

export function inviteLink(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&permissions=${INVITE_PERMISSIONS}&scope=bot`
}

export function newChannelGuild(
  bindings: ConductorBinding[],
  guilds: DiscordGuild[],
  ownerId: string | undefined
): string | undefined {
  const owned = guilds.filter((g) => ownerId && g.ownerId === ownerId).map((g) => g.id)
  const bound = bindings.map((b) => b.channel.guildId).find((id) => owned.includes(id))
  return bound ?? owned[0]
}

export function bindingProblem(
  bindings: ConductorBinding[],
  wanted: { id?: string; scope: string; channelId?: string }
): string | undefined {
  const others = bindings.filter((b) => b.id !== wanted.id)
  if (others.some((b) => b.scope === wanted.scope))
    return `${scopeName(wanted.scope)} already has an Assist.`
  const taken = wanted.channelId && others.find((b) => b.channel.channelId === wanted.channelId)
  if (taken) return `That channel is already bound to the ${conductorName(taken.scope)}.`
  return undefined
}

export function keepPinnedScopes<T extends { scope: string }>(items: T[], pinned: string[]): T[] {
  return items.filter((b) => b.scope === GLOBAL_SCOPE || pinned.includes(b.scope))
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
  return records
}

export function sanitizeDiscord(raw: unknown): DiscordSettings {
  const doc = isRecord(raw) ? raw : {}
  const bindings: ConductorBinding[] = []
  for (const item of Array.isArray(doc.bindings) ? doc.bindings : []) {
    const b = cleanBinding(item)
    if (!b || bindings.some((x) => x.id === b.id)) continue
    if (bindingProblem(bindings, { scope: b.scope, channelId: b.channel.channelId })) continue
    bindings.push(b)
  }
  const category = cleanChannel(doc.category)
  return {
    ...(category ? { category } : {}),
    ...(isDiscordId(doc.userId)
      ? {
          userId: doc.userId,
          ...(typeof doc.userName === 'string' ? { userName: doc.userName } : {})
        }
      : {}),
    bindings
  }
}
