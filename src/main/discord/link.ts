import type { DiscordChannelChoice, DiscordPhase, DiscordStatus } from '@shared/types'
import { DiscordGateway } from './gateway'
import { DiscordHttpError, DiscordRest } from './rest'

export const DISCORD_API_URL = 'https://discord.com/api/v10'
const UNREACHABLE_RETRY_MS = 30_000
const TEXT_CHANNEL = 0

export interface DiscordLinkDeps {
  apiUrl: string
  readToken(): Promise<string | null>
  takeLock(): boolean
  releaseLock(): void
  owner(): string | undefined
  push(status: DiscordStatus): void
}

interface Author {
  id: string
  username: string
  global_name?: string | null
  bot?: boolean
}

interface Candidate {
  id: string
  name: string
  text: string
  at: number
}

export class DiscordLink {
  private phase: DiscordPhase = 'off'
  private botName?: string
  private applicationId?: string
  private guilds = new Map<string, string>()
  private candidate?: Candidate
  private rest: DiscordRest | null = null
  private gateway: DiscordGateway | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private starting: Promise<void> = Promise.resolve()

  constructor(private d: DiscordLinkDeps) {}

  status(): DiscordStatus {
    return {
      phase: this.phase,
      botName: this.botName,
      applicationId: this.applicationId,
      guildNames: [...this.guilds.values()].filter(Boolean),
      ...(this.candidate
        ? {
            candidate: {
              name: this.candidate.name,
              text: this.candidate.text,
              at: this.candidate.at
            }
          }
        : {})
    }
  }

  private set(phase: DiscordPhase): void {
    this.phase = phase
    this.d.push(this.status())
  }

  private drop(): void {
    this.generation++
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.gateway?.stop()
    this.gateway = null
    this.rest = null
    this.botName = undefined
    this.applicationId = undefined
    this.guilds.clear()
    this.candidate = undefined
  }

  stop(): void {
    this.drop()
    this.d.releaseLock()
  }

  connect(): Promise<void> {
    this.starting = this.start()
    return this.starting
  }

  private async start(): Promise<void> {
    this.drop()
    const generation = this.generation
    const token = await this.d.readToken()
    if (generation !== this.generation) return
    if (!token) return this.set('off')
    if (!this.d.takeLock()) return this.set('elsewhere')
    this.set('connecting')
    const rest = new DiscordRest(this.d.apiUrl, token)
    try {
      const me = await rest.request<{ username: string }>('GET', '/users/@me')
      const app = await rest.request<{ id: string }>('GET', '/oauth2/applications/@me')
      const { url } = await rest.request<{ url: string }>('GET', '/gateway/bot')
      if (generation !== this.generation) return
      this.botName = me.username
      this.applicationId = app.id
      this.rest = rest
      this.gateway = new DiscordGateway({
        token,
        url,
        onState: (state) => this.set(state === 'ready' ? 'connected' : state),
        onDispatch: (type, data) => this.onDispatch(type, data)
      })
      this.gateway.start()
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof DiscordHttpError && error.status === 401) return this.set('token')
      this.set('unreachable')
      this.retry = setTimeout(() => void this.connect(), UNREACHABLE_RETRY_MS)
    }
  }

  private onDispatch(type: string, data: unknown): void {
    if (type === 'READY') {
      for (const g of (data as { guilds: { id: string }[] }).guilds)
        this.guilds.set(g.id, this.guilds.get(g.id) ?? '')
    } else if (type === 'GUILD_CREATE') {
      const g = data as { id: string; name: string }
      this.guilds.set(g.id, g.name)
    } else if (type === 'GUILD_DELETE') {
      const g = data as { id: string; unavailable?: boolean }
      if (g.unavailable) return
      this.guilds.delete(g.id)
    } else if (type === 'MESSAGE_CREATE') {
      const m = data as { guild_id?: string; content: string; author: Author }
      if (m.author.bot || !m.guild_id || this.d.owner()) return
      this.candidate = {
        id: m.author.id,
        name: m.author.global_name || m.author.username,
        text: m.content,
        at: Date.now()
      }
    } else return
    this.d.push(this.status())
  }

  pair(isMe: boolean): { id: string; name: string } | null {
    const picked = this.candidate
    this.candidate = undefined
    this.d.push(this.status())
    return isMe && picked ? { id: picked.id, name: picked.name } : null
  }

  async channels(): Promise<DiscordChannelChoice[]> {
    await this.starting
    const rest = this.rest
    if (!rest) return []
    const guilds = await rest.request<{ id: string }[]>('GET', '/users/@me/guilds')
    const lists = await Promise.all(
      guilds.map((g) =>
        rest
          .request<{ id: string; name: string; type: number }[]>('GET', `/guilds/${g.id}/channels`)
          .then((list) =>
            list
              .filter((c) => c.type === TEXT_CHANNEL)
              .map((c) => ({ guildId: g.id, channelId: c.id, name: c.name }))
          )
      )
    )
    return lists.flat()
  }
}
