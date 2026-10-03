import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { WebSocketServer, type WebSocket } from 'ws'
import type { E2EEnv } from './env'

export const FAKE_BOT = 'koloft-bot'
export const FAKE_APPLICATION_ID = '700'
export const FAKE_GUILD = { id: '111', name: 'koloft' }
export const FAKE_CHANNELS = [
  { id: '222', name: 'koloft-all', type: 0 },
  { id: '333', name: 'koloft', type: 0 },
  { id: '444', name: 'Lounge', type: 2 }
]
const HEARTBEAT_MS = 41_250

export interface FakeDiscord {
  identifies: number
  closeOnIdentify: number | null
  closeCodes: number[]
  say(author: { id: string; username: string; bot?: boolean }, content: string): void
  close(): Promise<void>
}

export async function startFakeDiscord(env: E2EEnv, token = 'fake-token'): Promise<FakeDiscord> {
  const sockets = new Set<WebSocket>()
  let seq = 0
  const fake: FakeDiscord = {
    identifies: 0,
    closeOnIdentify: null,
    closeCodes: [],
    say: (author, content) => {
      for (const ws of sockets)
        ws.send(
          JSON.stringify({
            op: 0,
            t: 'MESSAGE_CREATE',
            s: ++seq,
            d: {
              id: String(1000 + seq),
              channel_id: FAKE_CHANNELS[0].id,
              guild_id: FAKE_GUILD.id,
              content,
              author
            }
          })
        )
    },
    close: async () => {
      for (const ws of sockets) ws.terminate()
      await new Promise((r) => wss.close(r))
      await new Promise((r) => server.close(r))
    }
  }

  const routes: Record<string, () => unknown> = {
    '/users/@me': () => ({ id: '900', username: FAKE_BOT, bot: true }),
    '/oauth2/applications/@me': () => ({ id: FAKE_APPLICATION_ID, bot_public: false }),
    '/gateway/bot': () => ({ url: `ws://127.0.0.1:${port}` }),
    '/users/@me/guilds': () => [FAKE_GUILD],
    [`/guilds/${FAKE_GUILD.id}/channels`]: () => FAKE_CHANNELS
  }
  const server = http.createServer((req, res) => {
    const route = routes[(req.url ?? '').replace(/^\/api\/v10/, '')] as (() => unknown) | undefined
    res.writeHead(route ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(route ? route() : { message: 'no' }))
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
      ws.send(JSON.stringify({ op: 0, t: 'GUILD_CREATE', s: ++seq, d: FAKE_GUILD }))
    })
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: HEARTBEAT_MS }, s: null, t: null }))
  })

  env.launchEnv.KOLOFT_DISCORD_API_URL = `http://127.0.0.1:${port}/api/v10`
  if (token)
    fs.writeFileSync(env.keychainFile, JSON.stringify({ 'koloft-dev-discord-bot': { bot: token } }))
  return fake
}
