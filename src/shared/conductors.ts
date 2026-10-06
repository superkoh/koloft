import type { ConductorBinding, DiscordSettings, SessionThread } from './types'
import { basename } from './preview'
import { isAbsoluteOnHost, parseRemoteKey } from './remoteKey'
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
  return `${scopeName(scope)} conductor`
}

export function channelLabel(binding: Pick<ConductorBinding, 'channel'>): string {
  return `#${binding.channel.name}`
}

export function bindingProblem(
  bindings: ConductorBinding[],
  wanted: { id?: string; scope: string; channelId: string }
): string | undefined {
  const others = bindings.filter((b) => b.id !== wanted.id)
  if (others.some((b) => b.scope === wanted.scope))
    return `${scopeName(wanted.scope)} already has a conductor.`
  const taken = others.find((b) => b.channel.channelId === wanted.channelId)
  if (taken) return `That channel is already bound to the ${scopeName(taken.scope)} conductor.`
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
        ...(isDiscordId(t.lastMessageId) ? { lastMessageId: t.lastMessageId } : {})
      }
    ]
  })
}

function cleanBinding(raw: unknown): ConductorBinding | null {
  if (!isRecord(raw)) return null
  const { id, scope, channel, lastSessionKey, lastMessageId } = raw
  const backend = backendIdOf(raw.backend)
  const threads = cleanThreads(raw.threads)
  if (typeof id !== 'string' || !id || !backend) return null
  if (typeof scope !== 'string' || (scope !== GLOBAL_SCOPE && !isAbsoluteOnHost(scope))) return null
  if (
    !isRecord(channel) ||
    !isDiscordId(channel.guildId) ||
    !isDiscordId(channel.channelId) ||
    typeof channel.name !== 'string'
  )
    return null
  return {
    id,
    scope,
    backend,
    channel: { guildId: channel.guildId, channelId: channel.channelId, name: channel.name },
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
  return {
    ...(isDiscordId(doc.userId)
      ? {
          userId: doc.userId,
          ...(typeof doc.userName === 'string' ? { userName: doc.userName } : {})
        }
      : {}),
    bindings
  }
}
