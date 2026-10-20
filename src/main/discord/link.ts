import type {
  DiscordChannel,
  DiscordGuild,
  DiscordPhase,
  DiscordStatus,
  DiscordUser
} from '@shared/types'
import { newChannelGuild, NEW_CHANNEL_NAME, NEW_CHANNEL_TOPIC } from '@shared/conductors'
import { distinctName } from '@shared/sessionRoute'
import { DiscordGateway } from './gateway'
import { DiscordHttpError, DiscordRest } from './rest'
import { cardMessages, NO_MENTIONS, type Card } from './cards'

export const DISCORD_API_URL = 'https://discord.com/api/v10'
const UNREACHABLE_RETRY_MS = 30_000
const LOCK_RETRY_MS = 30_000
const NO_OWNED_SERVER =
  'The bot is in no server you own yet. Make a server of your own in Discord, invite the bot to it, then try again.'
const TEXT_CHANNEL = 0
const CATEGORY = 4
const MESSAGE_CONTENT = 1 << 18
const MESSAGE_CONTENT_LIMITED = 1 << 19
const MISSING_PERMISSIONS = 403
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

export { NO_MENTIONS }
export const COMMAND_INTERACTION = 2
export const COMPONENT_INTERACTION = 3
export const FORM_SUBMIT_INTERACTION = 5
const REPLY_TO_INTERACTION = 4
const ONLY_THE_SENDER_SEES_IT = 64

export function privately(content: string): unknown {
  return { type: REPLY_TO_INTERACTION, data: { content, flags: ONLY_THE_SENDER_SEES_IT } }
}

export interface DiscordInteraction {
  id: string
  token: string
  type: number
  channelId: string
  userId: string
  command: string
  options: Record<string, string>
  customId?: string
  fields?: Record<string, string>
}

interface RawComponent {
  custom_id?: string
  value?: unknown
  components?: RawComponent[]
}

interface RawInteraction {
  id: string
  token: string
  type: number
  channel_id?: string
  member?: { user?: { id: string } }
  user?: { id: string }
  data?: {
    name?: string
    custom_id?: string
    options?: { name: string; value?: unknown }[]
    components?: RawComponent[]
  }
}

// PLATFORM§39
function fieldsOf(rows: RawComponent[]): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const row of rows)
    for (const c of row.components ?? [])
      if (c.custom_id && typeof c.value === 'string') fields[c.custom_id] = c.value
  return fields
}

export interface SlashCommandSpec {
  name: string
  description: string
  options?: {
    type: number
    name: string
    description: string
    required?: boolean
    autocomplete?: boolean
  }[]
}

function shapeOf(c: SlashCommandSpec): string {
  return JSON.stringify([
    c.name,
    c.description,
    (c.options ?? []).map((o) => [o.name, o.description, !!o.required, !!o.autocomplete])
  ])
}

export function sameCommand(a: SlashCommandSpec, b: SlashCommandSpec): boolean {
  return shapeOf(a) === shapeOf(b)
}

// PLATFORM§39
export function interactionOf(raw: RawInteraction): DiscordInteraction | null {
  const userId = raw.member?.user?.id ?? raw.user?.id
  const data = raw.data
  const submitted = raw.type === FORM_SUBMIT_INTERACTION
  const pressed = raw.type === COMPONENT_INTERACTION || submitted ? data?.custom_id : undefined
  if (!raw.channel_id || !userId || !data || !(data.name || pressed)) return null
  const options: Record<string, string> = {}
  for (const o of data.options ?? []) options[o.name] = String(o.value ?? '')
  return {
    id: raw.id,
    token: raw.token,
    type: raw.type,
    channelId: raw.channel_id,
    userId,
    command: data.name ?? '',
    options,
    ...(pressed ? { customId: pressed } : {}),
    ...(submitted ? { fields: fieldsOf(data.components ?? []) } : {})
  }
}

export interface DiscordLinkDeps {
  apiUrl: string | null
  readToken(): Promise<string | null>
  takeLock(): boolean
  releaseLock(): void
  owner(): string | undefined
  foundAppOwner(owner: DiscordUser): void
  push(status: DiscordStatus): void
  onMessage(m: DiscordMessage): void
  onInteraction(i: DiscordInteraction): void
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

interface RawApplication {
  id: string
  flags?: number
  owner?: { id: string; username: string }
  team?: unknown
}

interface RawChannel {
  id: string
  name: string
  type: number
}

export interface NewChannel {
  channel: DiscordChannel
  category: DiscordChannel
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
  private appOwner?: DiscordUser
  private guilds = new Map<string, DiscordGuild>()
  private registered = new Set<string>()
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
      guilds: [...this.guilds.values()].filter((g) => g.name),
      ...(this.appOwner ? { appOwner: this.appOwner } : {}),
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
    this.appOwner = undefined
    this.guilds.clear()
    this.registered.clear()
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
        rest.request<RawApplication>('GET', '/oauth2/applications/@me')
      ])
      if (generation !== this.generation) return
      this.botName = me.username
      this.applicationId = app.id
      if (app.owner && !app.team) {
        this.appOwner = { id: app.owner.id, name: app.owner.username }
        this.d.foundAppOwner(this.appOwner)
      }
      await this.turnOnMessageContent(rest, app.flags ?? 0)
      if (generation !== this.generation) return
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

  // PLATFORM§39
  private async turnOnMessageContent(rest: DiscordRest, flags: number): Promise<void> {
    if (flags & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED)) return
    await rest
      .request('PATCH', '/applications/@me', { flags: flags | MESSAGE_CONTENT_LIMITED })
      .catch(() => undefined)
  }

  private onDispatch(type: string, data: unknown): void {
    if (type === 'READY') {
      for (const g of (data as { guilds: { id: string }[] }).guilds)
        this.guilds.set(g.id, this.guilds.get(g.id) ?? { id: g.id, name: '' })
      this.d.onReady()
    } else if (type === 'GUILD_CREATE') {
      const g = data as { id: string; name: string; owner_id?: string }
      this.guilds.set(g.id, { id: g.id, name: g.name, ownerId: g.owner_id })
    } else if (type === 'GUILD_DELETE') {
      const g = data as { id: string; unavailable?: boolean }
      if (g.unavailable) return
      this.guilds.delete(g.id)
    } else if (type === 'INTERACTION_CREATE') {
      const i = interactionOf(data as RawInteraction)
      if (i) this.d.onInteraction(i)
      return
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

  post(channelId: string, content: string, replyTo?: string): Promise<unknown> {
    return this.postMessage(channelId, {
      content,
      allowed_mentions: NO_MENTIONS,
      ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {})
    })
  }

  async card(channelId: string, card: Card): Promise<string[]> {
    const ids: string[] = []
    for (const message of cardMessages(card)) {
      const sent = (await this.postMessage(channelId, message)) as { id?: string } | undefined
      if (sent?.id) ids.push(sent.id)
    }
    return ids
  }

  // PLATFORM§39
  async editCard(channelId: string, messageId: string, card: Card): Promise<void> {
    const [message] = cardMessages(card)
    await this.api().request('PATCH', `/channels/${channelId}/messages/${messageId}`, message)
  }

  // PLATFORM§39
  async typing(channelId: string): Promise<void> {
    await this.api().request('POST', `/channels/${channelId}/typing`)
  }

  private async postMessage(channelId: string, body: unknown): Promise<unknown> {
    try {
      const sent = await this.api().request('POST', `/channels/${channelId}/messages`, body)
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
          allowed_mentions: NO_MENTIONS,
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

  respond(i: DiscordInteraction, body: unknown): Promise<unknown> {
    return this.api().request('POST', `/interactions/${i.id}/${i.token}/callback`, body)
  }

  // PLATFORM§39
  async registerCommands(guildIds: string[], commands: SlashCommandSpec[]): Promise<void> {
    const appId = this.applicationId
    const api = this.rest
    if (!appId || !api) return
    for (const guildId of guildIds) {
      if (this.registered.has(guildId)) continue
      this.registered.add(guildId)
      const route = `/applications/${appId}/guilds/${guildId}/commands`
      try {
        const there = await api.request<SlashCommandSpec[]>('GET', route)
        const missing = commands.filter((c) => !there.some((t) => sameCommand(t, c)))
        await Promise.all(missing.map((c) => api.request('POST', route, c)))
      } catch {
        this.registered.delete(guildId)
      }
    }
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
          .request<RawChannel[]>('GET', `/guilds/${g.id}/channels`)
          .then((list) =>
            list
              .filter((c) => c.type === TEXT_CHANNEL)
              .map((c) => ({ guildId: g.id, channelId: c.id, name: c.name }))
          )
      )
    )
    return lists.flat()
  }

  // PLATFORM§39
  async newChannel(
    bound: DiscordChannel | undefined,
    saved: DiscordChannel | undefined
  ): Promise<NewChannel> {
    await this.starting
    const api = this.api()
    const guildId = newChannelGuild(bound, [...this.guilds.values()], this.d.owner())
    if (!guildId) throw new Error(NO_OWNED_SERVER)
    const route = `/guilds/${guildId}/channels`
    const there = await api.request<RawChannel[]>('GET', route)
    const botName = this.botName ?? 'Koloft'
    const categories = there.filter((c) => c.type === CATEGORY)
    const make = (body: unknown): Promise<RawChannel> =>
      api.request<RawChannel>('POST', route, body).catch((error: unknown) => {
        if (error instanceof DiscordHttpError && error.status === MISSING_PERMISSIONS)
          throw new CannotMakeChannels()
        throw error
      })
    const category =
      categories.find((c) => c.id === saved?.channelId) ??
      categories.find((c) => c.name === botName) ??
      (await make({ name: botName, type: CATEGORY }))
    const taken = there.filter((c) => c.type === TEXT_CHANNEL).map((c) => c.name)
    const made = await make({
      name: distinctName(NEW_CHANNEL_NAME, taken),
      type: TEXT_CHANNEL,
      parent_id: category.id,
      topic: NEW_CHANNEL_TOPIC
    })
    return {
      channel: { guildId, channelId: made.id, name: made.name },
      category: { guildId, channelId: category.id, name: category.name }
    }
  }
}

export class CannotMakeChannels extends Error {
  constructor() {
    super(
      'The bot is not allowed to make channels yet. Invite it again to give it that permission — the channels you already bound keep working.'
    )
  }
}
