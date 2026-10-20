import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { WebSocketServer, type WebSocket } from 'ws'
import { addKeychainEntry, type E2EEnv } from './env'

export const FAKE_BOT = 'koloft-bot'
const FAKE_APPLICATION_ID = '700'
export const FAKE_GUILD = { id: '111', name: 'koloft' }
export const FAKE_GUILD_OWNER = '555'
export const FAKE_CHANNELS = [
  { id: '222', name: 'koloft-all', type: 0 },
  { id: '333', name: 'koloft', type: 0 },
  { id: '444', name: 'Lounge', type: 2 }
]
const HEARTBEAT_MS = 41_250
const FIRST_LIVE_MESSAGE_ID = 5000
export const MESSAGE_CONTENT_LIMITED = 1 << 19
const INTENT_NOT_ALLOWED = 4014
const TEAM_APP = { owner: { id: '800', username: 'team-owner' }, team: { id: '801' } }
const RETRY_AFTER_S = 0.05

export interface FakeChannel {
  id: string
  name: string
  type: number
  parent_id?: string
  topic?: string
}

export interface FakeAuthor {
  id: string
  username: string
  bot?: boolean
}

export interface FakeHistoryMessage {
  id: string
  content: string
  author: FakeAuthor
}

export interface FakeButton {
  label: string
  id: string
}

export interface FakePost {
  id: string
  channelId: string
  content: string
  replyTo?: string
  files: { name: string; text: string; data: Buffer }[]
  card?: boolean
  flags?: number
  buttons?: FakeButton[]
}

interface RawComponent {
  type: number
  content?: string
  label?: string
  custom_id?: string
  components?: RawComponent[]
}

function cardText(components: RawComponent[]): { text: string; buttons: FakeButton[] } {
  const texts: string[] = []
  const buttons: FakeButton[] = []
  const walk = (list: RawComponent[]): void => {
    for (const c of list) {
      if (c.content !== undefined) texts.push(c.content)
      if (c.custom_id) buttons.push({ label: c.label ?? '', id: c.custom_id })
      if (c.components) walk(c.components)
    }
  }
  walk(components)
  return { text: texts.join('\n'), buttons }
}

export interface FakeReaction {
  messageId: string
  emoji: string
  on: boolean
}

export interface FakeCommand {
  name: string
  description: string
  options?: { name: string }[]
}

export interface FakeCallback {
  interactionId: string
  type: number
  data: {
    content?: string
    flags?: number
    components?: RawComponent[]
    custom_id?: string
  }
}

export const SLASH_COMMAND = 2
export const BUTTON_PRESS = 3
export const FORM_SUBMIT = 5
export const OPEN_A_FORM = 9

export function callbackText(c: FakeCallback): string {
  return c.data.components ? cardText(c.data.components).text : (c.data.content ?? '')
}

export interface FakeDiscord {
  identifies: number
  closeOnIdentify: number | null
  appOwner: FakeAuthor | null
  appFlags: number
  refuseAppEdit: boolean
  made: FakeChannel[]
  refuseChannels: boolean
  rateLimitChannelPosts: number
  rateLimited: number
  closeCodes: number[]
  posted: FakePost[]
  refusePostsIn: string[]
  reactions: FakeReaction[]
  edits: FakePost[]
  typing: string[]
  history: Record<string, FakeHistoryMessage[]>
  commands: FakeCommand[]
  callbacks: FakeCallback[]
  press(author: FakeAuthor, button: FakeButton, channelId: string): string
  submit(author: FakeAuthor, formId: string, typed: string, channelId: string): string
  say(
    author: FakeAuthor,
    content: string,
    opts?: { channelId?: string; attachments?: { filename: string; body: string }[] }
  ): string
  interact(
    author: FakeAuthor,
    command: string,
    options: Record<string, string>,
    opts?: { type?: number; channelId?: string }
  ): string
  close(): Promise<void>
}

const MESSAGE_ROUTE = /^\/channels\/(\d+)\/messages$/
const ONE_MESSAGE_ROUTE = /^\/channels\/(\d+)\/messages\/(\d+)$/
const TYPING_ROUTE = /^\/channels\/(\d+)\/typing$/
const COMMANDS_ROUTE = /^\/applications\/\d+\/guilds\/\d+\/commands$/
const CALLBACK_ROUTE = /^\/interactions\/(\d+)\/[^/]+\/callback$/
const REACTION_ROUTE = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/
const ATTACHMENT_ROUTE = /^\/attachments\/(.+)$/

function bodyOf(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

async function postOf(id: string, channelId: string, req: http.IncomingMessage): Promise<FakePost> {
  const raw = await bodyOf(req)
  const type = req.headers['content-type'] ?? ''
  if (!type.startsWith('multipart/form-data')) {
    const json = JSON.parse(raw.toString()) as {
      content?: string
      flags?: number
      components?: RawComponent[]
      message_reference?: { message_id: string }
    }
    const card = json.components ? cardText(json.components) : undefined
    return {
      id,
      channelId,
      content: card ? card.text : (json.content ?? ''),
      replyTo: json.message_reference?.message_id,
      files: [],
      ...(card ? { card: true, buttons: card.buttons } : {}),
      ...(json.flags === undefined ? {} : { flags: json.flags })
    }
  }
  const form = await new Request('http://fake/', {
    method: 'POST',
    headers: { 'content-type': type },
    body: new Uint8Array(raw)
  }).formData()
  const payload = JSON.parse(String(form.get('payload_json'))) as { content?: string }
  const files: FakePost['files'] = []
  for (const [key, value] of form.entries())
    if (key.startsWith('files[') && typeof value !== 'string') {
      const data = Buffer.from(await value.arrayBuffer())
      files.push({ name: value.name, text: data.toString('utf8'), data })
    }
  return { id, channelId, content: payload.content ?? '', files }
}

export async function startFakeDiscord(env: E2EEnv, token = 'fake-token'): Promise<FakeDiscord> {
  const sockets = new Set<WebSocket>()
  const attachments = new Map<string, string>()
  let seq = 0
  let nextId = FIRST_LIVE_MESSAGE_ID
  const fake: FakeDiscord = {
    identifies: 0,
    closeOnIdentify: null,
    appOwner: null,
    appFlags: MESSAGE_CONTENT_LIMITED,
    refuseAppEdit: false,
    made: [],
    refuseChannels: false,
    rateLimitChannelPosts: 0,
    rateLimited: 0,
    closeCodes: [],
    posted: [],
    refusePostsIn: [],
    reactions: [],
    edits: [],
    typing: [],
    history: {},
    commands: [],
    callbacks: [],
    press: (author, button, channelId) => {
      const id = String(++nextId)
      for (const ws of sockets)
        ws.send(
          JSON.stringify({
            op: 0,
            t: 'INTERACTION_CREATE',
            s: ++seq,
            d: {
              id,
              token: `token-${id}`,
              type: BUTTON_PRESS,
              channel_id: channelId,
              guild_id: FAKE_GUILD.id,
              member: { user: author },
              data: { custom_id: button.id, component_type: 2 }
            }
          })
        )
      return id
    },
    submit: (author, formId, typed, channelId) => {
      const id = String(++nextId)
      for (const ws of sockets)
        ws.send(
          JSON.stringify({
            op: 0,
            t: 'INTERACTION_CREATE',
            s: ++seq,
            d: {
              id,
              token: `token-${id}`,
              type: FORM_SUBMIT,
              channel_id: channelId,
              guild_id: FAKE_GUILD.id,
              member: { user: author },
              data: {
                custom_id: formId,
                components: [
                  { type: 1, components: [{ type: 4, custom_id: 'value', value: typed }] }
                ]
              }
            }
          })
        )
      return id
    },
    interact: (author, command, options, opts = {}) => {
      const id = String(++nextId)
      for (const ws of sockets)
        ws.send(
          JSON.stringify({
            op: 0,
            t: 'INTERACTION_CREATE',
            s: ++seq,
            d: {
              id,
              token: `token-${id}`,
              type: opts.type ?? SLASH_COMMAND,
              channel_id: opts.channelId ?? FAKE_CHANNELS[0].id,
              guild_id: FAKE_GUILD.id,
              member: { user: author },
              data: {
                name: command,
                options: Object.entries(options).map(([name, value]) => ({
                  name,
                  value,
                  type: 3
                }))
              }
            }
          })
        )
      return id
    },
    say: (author, content, opts = {}) => {
      const id = String(++nextId)
      const listed = (opts.attachments ?? []).map((a) => {
        const key = `${id}/${a.filename}`
        attachments.set(key, a.body)
        return {
          id: `${id}0`,
          filename: a.filename,
          size: Buffer.byteLength(a.body),
          url: `http://127.0.0.1:${port}/attachments/${key}`
        }
      })
      for (const ws of sockets)
        ws.send(
          JSON.stringify({
            op: 0,
            t: 'MESSAGE_CREATE',
            s: ++seq,
            d: {
              id,
              channel_id: opts.channelId ?? FAKE_CHANNELS[0].id,
              guild_id: FAKE_GUILD.id,
              content,
              author,
              attachments: listed
            }
          })
        )
      return id
    },
    close: async () => {
      for (const ws of sockets) ws.terminate()
      await new Promise((r) => wss.close(r))
      await new Promise((r) => server.close(r))
    }
  }

  const routes: Record<string, () => unknown> = {
    '/users/@me': () => ({ id: '900', username: FAKE_BOT, bot: true }),
    '/oauth2/applications/@me': () => ({
      id: FAKE_APPLICATION_ID,
      bot_public: false,
      flags: fake.appFlags,
      ...(fake.appOwner ? { owner: fake.appOwner, team: null } : TEAM_APP)
    }),
    '/users/@me/guilds': () => [FAKE_GUILD]
  }

  const answer = async (req: http.IncomingMessage): Promise<{ status: number; body?: unknown }> => {
    const url = new URL(req.url ?? '/', 'http://fake')
    const route = url.pathname.replace(/^\/api\/v10/, '')
    if (route === '/applications/@me' && req.method === 'PATCH') {
      const { flags } = JSON.parse((await bodyOf(req)).toString()) as { flags: number }
      if (fake.refuseAppEdit)
        return { status: 403, body: { message: 'Missing Access', code: 50001 } }
      fake.appFlags = flags
      return { status: 200, body: { id: FAKE_APPLICATION_ID, flags } }
    }
    if (route === `/guilds/${FAKE_GUILD.id}/channels` && req.method === 'GET')
      return { status: 200, body: [...FAKE_CHANNELS, ...fake.made] }
    if (route === `/guilds/${FAKE_GUILD.id}/channels` && req.method === 'POST') {
      const asked = JSON.parse((await bodyOf(req)).toString()) as Omit<FakeChannel, 'id'>
      if (fake.rateLimitChannelPosts > 0) {
        fake.rateLimitChannelPosts--
        fake.rateLimited++
        return {
          status: 429,
          body: { message: 'You are being rate limited.', retry_after: RETRY_AFTER_S }
        }
      }
      if (fake.refuseChannels)
        return { status: 403, body: { message: 'Missing Permissions', code: 50013 } }
      const made = { ...asked, id: String(++nextId) }
      fake.made.push(made)
      return { status: 201, body: made }
    }
    const attachment = ATTACHMENT_ROUTE.exec(route)
    if (attachment) return { status: 200, body: attachments.get(attachment[1]) ?? '' }
    if (COMMANDS_ROUTE.test(route) && req.method === 'GET')
      return { status: 200, body: fake.commands }
    if (COMMANDS_ROUTE.test(route) && req.method === 'POST') {
      const command = JSON.parse((await bodyOf(req)).toString()) as FakeCommand
      fake.commands = [...fake.commands.filter((c) => c.name !== command.name), command]
      return { status: 201, body: command }
    }
    const callback = CALLBACK_ROUTE.exec(route)
    if (callback && req.method === 'POST') {
      const body = JSON.parse((await bodyOf(req)).toString()) as Omit<FakeCallback, 'interactionId'>
      fake.callbacks.push({ interactionId: callback[1], ...body })
      return { status: 204 }
    }
    const reaction = REACTION_ROUTE.exec(route)
    if (reaction) {
      fake.reactions.push({
        messageId: reaction[2],
        emoji: decodeURIComponent(reaction[3]),
        on: req.method === 'PUT'
      })
      return { status: 204 }
    }
    const edited = ONE_MESSAGE_ROUTE.exec(route)
    if (edited && req.method === 'PATCH') {
      fake.edits.push(await postOf(edited[2], edited[1], req))
      return { status: 200, body: { id: edited[2] } }
    }
    const typing = TYPING_ROUTE.exec(route)
    if (typing && req.method === 'POST') {
      fake.typing.push(typing[1])
      return { status: 204 }
    }
    const message = MESSAGE_ROUTE.exec(route)
    if (message && req.method === 'POST' && fake.refusePostsIn.includes(message[1])) {
      await bodyOf(req)
      return { status: 403, body: { message: 'Missing Permissions', code: 50013 } }
    }
    if (message && req.method === 'POST') {
      const id = String(++nextId)
      fake.posted.push(await postOf(id, message[1], req))
      return { status: 200, body: { id } }
    }
    if (message) {
      const after = url.searchParams.get('after')
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const list = (fake.history[message[1]] ?? [])
        .filter((m) => !after || BigInt(m.id) > BigInt(after))
        .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
        .slice(0, limit)
        .map((m) => ({ ...m, channel_id: message[1], attachments: [] }))
      return { status: 200, body: list }
    }
    const fixed = routes[route]
    return fixed ? { status: 200, body: fixed() } : { status: 404, body: { message: 'no' } }
  }

  const server = http.createServer((req, res) => {
    void answer(req).then(({ status, body }) => {
      if (body === undefined) {
        res.writeHead(status)
        res.end()
      } else if (typeof body === 'string') {
        res.writeHead(status, { 'Content-Type': 'application/octet-stream' })
        res.end(body)
      } else {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port

  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('close', (code) => {
      sockets.delete(ws)
      fake.closeCodes.push(code)
    })
    ws.on('message', (raw) => {
      const p = JSON.parse(raw.toString()) as { op: number }
      if (p.op === 1) ws.send(JSON.stringify({ op: 11, d: null, s: null, t: null }))
      if (p.op !== 2) return
      fake.identifies++
      if (fake.closeOnIdentify) return ws.close(fake.closeOnIdentify)
      if (!(fake.appFlags & MESSAGE_CONTENT_LIMITED)) return ws.close(INTENT_NOT_ALLOWED)
      ws.send(
        JSON.stringify({
          op: 0,
          t: 'READY',
          s: ++seq,
          d: {
            session_id: 'fake-session',
            resume_gateway_url: `ws://127.0.0.1:${port}`,
            user: { id: '900', username: FAKE_BOT },
            guilds: [{ id: FAKE_GUILD.id, unavailable: true }]
          }
        })
      )
      ws.send(
        JSON.stringify({
          op: 0,
          t: 'GUILD_CREATE',
          s: ++seq,
          d: { ...FAKE_GUILD, owner_id: FAKE_GUILD_OWNER }
        })
      )
    })
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: HEARTBEAT_MS }, s: null, t: null }))
  })

  env.launchEnv.KOLOFT_DISCORD_API_URL = `http://127.0.0.1:${port}/api/v10`
  if (token) addKeychainEntry(env, 'koloft-dev-discord-bot', 'bot', token)
  return fake
}
