import type { ConductorBinding, DiscordChannel, DiscordSettings, SessionThread } from './types'
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

export function channelLabel(binding: Pick<ConductorBinding, 'channel'>): string {
  return `#${binding.channel.name}`
}

// PLATFORM§39
export function discordChannelName(raw: string): string {
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

export function freeChannelName(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name
  let n = 2
  while (taken.includes(`${name}-${n}`)) n++
  return `${name}-${n}`
}

export function newChannelTopic(scope: string): string {
  if (scope === GLOBAL_SCOPE) return 'Koloft · global Assist, all workspaces'
  const remote = parseRemoteKey(scope)
  return remote ? remoteCopyText(remote.host, remote.path) : scope
}

export function newChannelGuild(
  bindings: ConductorBinding[],
  guildIds: string[]
): string | undefined {
  return bindings[0]?.channel.guildId ?? guildIds[0]
}

export function bindingProblem(
  bindings: ConductorBinding[],
  wanted: { id?: string; scope: string; channelId: string }
): string | undefined {
  const others = bindings.filter((b) => b.id !== wanted.id)
  if (others.some((b) => b.scope === wanted.scope))
    return `${scopeName(wanted.scope)} already has an Assist.`
  const taken = others.find((b) => b.channel.channelId === wanted.channelId)
  if (taken) return `That channel is already bound to the ${conductorName(taken.scope)}.`
  return undefined
}

export function keepPinnedBindings(
  bindings: ConductorBinding[],
  pinned: string[]
): ConductorBinding[] {
  return bindings.filter((b) => b.scope === GLOBAL_SCOPE || pinned.includes(b.scope))
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
  const { id, scope, lastSessionKey, lastMessageId } = raw
  const backend = backendIdOf(raw.backend)
  const threads = cleanThreads(raw.threads)
  const channel = cleanChannel(raw.channel)
  if (typeof id !== 'string' || !id || !backend) return null
  if (typeof scope !== 'string' || (scope !== GLOBAL_SCOPE && !isAbsoluteOnHost(scope))) return null
  if (!channel) return null
  return {
    id,
    scope,
    backend,
    channel,
    sessionIds: strings(raw.sessionIds),
    touched: strings(raw.touched),
    ...(threads.length ? { threads } : {}),
    ...(typeof lastSessionKey === 'string' ? { lastSessionKey } : {}),
    ...(isDiscordId(lastMessageId) ? { lastMessageId } : {})
  }
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
