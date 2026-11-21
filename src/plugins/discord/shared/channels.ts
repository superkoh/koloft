import type { DiscordChannel, DiscordGuild } from './types'

const DISCORD_ID_RE = /^\d{1,30}$/

export function isDiscordId(value: unknown): value is string {
  return typeof value === 'string' && DISCORD_ID_RE.test(value)
}

export function newerSnowflake(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b)
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
