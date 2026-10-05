import type { DiscordChannel, DiscordPhase, DiscordStatus } from '@shared/types'
import { DiscordGateway } from './gateway'
import { DiscordHttpError, DiscordRest } from './rest'

export const DISCORD_API_URL = 'https://discord.com/api/v10'
const UNREACHABLE_RETRY_MS = 30_000
const LOCK_RETRY_MS = 30_000
const TEXT_CHANNEL = 0
const FILES_PER_MESSAGE = 10
const BYTES_PER_MESSAGE = 25 * 1024 * 1024
export const BYTES_PER_FILE = 20 * 1024 * 1024

const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg'

export function discordApiUrl(): string | null {
  const override = process.env.KOLOFT_DISCORD_API_URL
  if (override) return override
  return process.env.KOLOFT_TEST_BACKGROUND === '1' ? null : DISCORD_API_URL
}

export function discordGatewayUrl(apiUrl: string): string {
  return apiUrl === DISCORD_API_URL ? DISCORD_GATEWAY_URL : `ws://${new URL(apiUrl).host}`
}

export interface DiscordAttachment {
  filename: string
  size: number
  url: string
}

export interface DiscordMessage {
  id: string
  channelId: string
  authorId: string
  bot: boolean
  content: string
  attachments: DiscordAttachment[]
}

export interface DiscordFile {
  name: string
  data: Buffer
}

export interface DiscordLinkDeps {
  apiUrl: string | null
  readToken(): Promise<string | null>
  takeLock(): boolean
  releaseLock(): void
  owner(): string | undefined
  push(status: DiscordStatus): void
  onMessage(m: DiscordMessage): void
  onReady(): void
  postFailed(channelId: string, error: string): void
}

interface Author {
  id: string
  username: string
  global_name?: string | null
  bot?: boolean
}

interface RawMessage {
  id: string
  channel_id: string
  guild_id?: string
  content: string
  author: Author
  attachments?: DiscordAttachment[]
}

interface Candidate {
  id: string
  name: string
  text: string
  at: number
}

// PLATFORM§39
function filesPerMessage(files: DiscordFile[]): DiscordFile[][] {
  const out: DiscordFile[][] = []
  let bytes = 0
  for (const f of files) {
    const last = out[out.length - 1]
    if (last && last.length < FILES_PER_MESSAGE && bytes + f.data.length <= BYTES_PER_MESSAGE) {
      last.push(f)
      bytes += f.data.length
    } else {
      out.push([f])
      bytes = f.data.length
    }
  }
  return out
}

function messageOf(m: RawMessage): DiscordMessage {
  return {
    id: m.id,
    channelId: m.channel_id,
    authorId: m.author.id,
    bot: m.author.bot === true,
    content: m.content,
    attachments: (m.attachments ?? []).map(({ filename, size, url }) => ({ filename, size, url }))
  }
}

export class DiscordLink {
  private phase: DiscordPhase = 'off'
  private botName?: string
  private applicationId?: string
  private guilds = new Map<string, string>()
  private failing = new Map<string, string>()
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
      failing: Object.fromEntries(this.failing),
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
    this.failing.clear()
    this.candidate = undefined
  }

  stop(): void {
    this.drop()
    this.d.releaseLock()
    this.set('off')
  }

  connect(): Promise<void> {
    this.starting = this.start()
    return this.starting
  }

  private retryIn(ms: number): void {
    this.retry = setTimeout(() => void this.connect(), ms)
  }

  private async start(): Promise<void> {
    this.drop()
    const generation = this.generation
    const apiUrl = this.d.apiUrl
    const token = apiUrl ? await this.d.readToken() : null
    if (generation !== this.generation) return
    if (!apiUrl || !token) return this.set('off')
    if (!this.d.takeLock()) {
      this.set('elsewhere')
      return this.retryIn(LOCK_RETRY_MS)
    }
    this.set('connecting')
    const rest = new DiscordRest(apiUrl, token)
    try {
      const [me, app] = await Promise.all([
        rest.request<{ username: string }>('GET', '/users/@me'),
        rest.request<{ id: string }>('GET', '/oauth2/applications/@me')
      ])
      if (generation !== this.generation) return
      this.botName = me.username
      this.applicationId = app.id
      this.rest = rest
      this.gateway = new DiscordGateway({
        token,
        url: discordGatewayUrl(apiUrl),
        onState: (state) => this.set(state === 'ready' ? 'connected' : state),
        onDispatch: (type, data) => this.onDispatch(type, data)
      })
      this.gateway.start()
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof DiscordHttpError && error.status === 401) return this.set('token')
      this.set('unreachable')
      this.retryIn(UNREACHABLE_RETRY_MS)
    }
  }

  private onDispatch(type: string, data: unknown): void {
    if (type === 'READY') {
      for (const g of (data as { guilds: { id: string }[] }).guilds)
        this.guilds.set(g.id, this.guilds.get(g.id) ?? '')
      this.d.onReady()
    } else if (type === 'GUILD_CREATE') {
      const g = data as { id: string; name: string }
      this.guilds.set(g.id, g.name)
    } else if (type === 'GUILD_DELETE') {
      const g = data as { id: string; unavailable?: boolean }
      if (g.unavailable) return
      this.guilds.delete(g.id)
    } else if (type === 'MESSAGE_CREATE') {
      const m = data as RawMessage
      if (m.author.bot) return
      if (this.d.owner()) return this.d.onMessage(messageOf(m))
      if (!m.guild_id) return
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

  private api(): DiscordRest {
    if (!this.rest) throw new Error('Discord is not connected.')
    return this.rest
  }

  async post(channelId: string, content: string, replyTo?: string): Promise<unknown> {
    try {
      const sent = await this.api().request('POST', `/channels/${channelId}/messages`, {
        content,
        allowed_mentions: { parse: [] },
        ...(replyTo
          ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } }
          : {})
      })
      if (this.failing.delete(channelId)) this.d.push(this.status())
      return sent
    } catch (error) {
      if (error instanceof DiscordHttpError && !this.failing.has(channelId)) {
        this.failing.set(channelId, error.message)
        this.d.push(this.status())
        this.d.postFailed(channelId, error.message)
      }
      throw error
    }
  }

  async upload(channelId: string, files: DiscordFile[], content: string): Promise<void> {
    const api = this.api()
    const sends = filesPerMessage(files).map((batch, i) => {
      const form = new FormData()
      form.append(
        'payload_json',
        JSON.stringify({
          ...(i === 0 && content ? { content } : {}),
          allowed_mentions: { parse: [] },
          attachments: batch.map((f, n) => ({ id: n, filename: f.name }))
        })
      )
      batch.forEach((f, n) =>
        form.append(`files[${n}]`, new Blob([new Uint8Array(f.data)]), f.name)
      )
      return api.request('POST', `/channels/${channelId}/messages`, form)
    })
    await Promise.all(sends)
  }

  react(channelId: string, messageId: string, emoji: string, on: boolean): Promise<unknown> {
    return this.api().request(
      on ? 'PUT' : 'DELETE',
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
    )
  }

  async messages(
    channelId: string,
    after: string | undefined,
    limit: number
  ): Promise<DiscordMessage[]> {
    const query = `limit=${limit}${after ? `&after=${after}` : ''}`
    const list = await this.api().request<RawMessage[]>(
      'GET',
      `/channels/${channelId}/messages?${query}`
    )
    return list.map(messageOf)
  }

  async channels(): Promise<DiscordChannel[]> {
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
