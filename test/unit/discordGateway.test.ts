import { describe, it, expect, afterEach } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import { DiscordGateway, INTENTS, type GatewayState } from '../../src/main/discord/gateway'

interface Sent {
  op: number
  d: Record<string, unknown> | number | null
}

const HEARTBEAT_MS = 40
const RETRY_MS = 10

let server: WebSocketServer
let gateway: DiscordGateway | null = null

afterEach(async () => {
  gateway?.stop()
  gateway = null
  for (const client of server.clients) client.terminate()
  await new Promise((r) => server.close(r))
})

async function listen(
  acks = true
): Promise<{ url: string; sockets: WebSocket[]; got: Sent[]; paths: string[] }> {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((r) => server.once('listening', r))
  const sockets: WebSocket[] = []
  const got: Sent[] = []
  const paths: string[] = []
  server.on('connection', (ws, req) => {
    sockets.push(ws)
    paths.push(req.url ?? '')
    ws.on('message', (raw) => {
      const p = JSON.parse(raw.toString()) as Sent
      got.push(p)
      if (p.op === 1 && acks) ws.send(JSON.stringify({ op: 11, d: null, s: null, t: null }))
    })
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: HEARTBEAT_MS }, s: null, t: null }))
  })
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sockets,
    got,
    paths
  }
}

function run(url: string): { states: GatewayState[]; events: string[] } {
  const states: GatewayState[] = []
  const events: string[] = []
  gateway = new DiscordGateway({
    token: 'tok',
    url,
    retryMs: RETRY_MS,
    intentsRetryMs: 60_000,
    onState: (s) => states.push(s),
    onDispatch: (t) => events.push(t)
  })
  gateway.start()
  return { states, events }
}

function dispatch(ws: WebSocket, t: string, d: unknown, s: number): void {
  ws.send(JSON.stringify({ op: 0, t, d, s }))
}

describe('DiscordGateway', () => {
  it('identifies with the token and the message intents after hello, then keeps a heartbeat carrying the last sequence', async () => {
    const { url, sockets, got, paths } = await listen()
    const { states, events } = run(url)
    await expect.poll(() => got.find((p) => p.op === 2)).toBeTruthy()
    expect(paths[0]).toBe('/?v=10&encoding=json')
    expect(got.find((p) => p.op === 2)?.d).toMatchObject({ token: 'tok', intents: INTENTS })
    dispatch(sockets[0], 'READY', { session_id: 's1', resume_gateway_url: url, guilds: [] }, 1)
    await expect.poll(() => states).toContain('ready')
    expect(events).toEqual(['READY'])
    await expect.poll(() => got.some((p) => p.op === 1 && p.d === 1)).toBe(true)
  })

  it('a dropped connection comes back with a resume of the same session at its last sequence, not a second identify', async () => {
    const { url, sockets, got } = await listen()
    const { states } = run(url)
    await expect.poll(() => got.some((p) => p.op === 2)).toBe(true)
    dispatch(sockets[0], 'READY', { session_id: 's1', resume_gateway_url: url, guilds: [] }, 1)
    dispatch(sockets[0], 'MESSAGE_CREATE', {}, 7)
    await expect.poll(() => states).toContain('ready')
    sockets[0].close(4000)
    await expect
      .poll(() => got.find((p) => p.op === 6)?.d)
      .toEqual({
        token: 'tok',
        session_id: 's1',
        seq: 7
      })
    expect(got.filter((p) => p.op === 2)).toHaveLength(1)
  })

  it('an invalid session that cannot be resumed starts over with identify', async () => {
    const { url, sockets, got } = await listen()
    run(url)
    await expect.poll(() => got.some((p) => p.op === 2)).toBe(true)
    dispatch(sockets[0], 'READY', { session_id: 's1', resume_gateway_url: url, guilds: [] }, 1)
    sockets[0].send(JSON.stringify({ op: 9, d: false, s: null, t: null }))
    await expect.poll(() => got.filter((p) => p.op === 2).length).toBe(2)
    expect(got.some((p) => p.op === 6)).toBe(false)
  })

  it('a heartbeat the server never acknowledges drops the connection and resumes', async () => {
    const { url, sockets, got } = await listen(false)
    run(url)
    await expect.poll(() => got.some((p) => p.op === 2)).toBe(true)
    dispatch(sockets[0], 'READY', { session_id: 's1', resume_gateway_url: url, guilds: [] }, 1)
    await expect.poll(() => got.some((p) => p.op === 6), { timeout: 5000 }).toBe(true)
    expect(sockets.length).toBeGreaterThan(1)
  })

  it('close code 4014 reports Message Content off and does not reconnect right away', async () => {
    const { url, sockets, got } = await listen()
    const { states } = run(url)
    await expect.poll(() => got.some((p) => p.op === 2)).toBe(true)
    sockets[0].close(4014)
    await expect.poll(() => states).toContain('intents')
    await new Promise((r) => setTimeout(r, RETRY_MS * 20))
    expect(sockets).toHaveLength(1)
  })

  it('close code 4004 reports a refused token and never reconnects', async () => {
    const { url, sockets, got } = await listen()
    const { states } = run(url)
    await expect.poll(() => got.some((p) => p.op === 2)).toBe(true)
    sockets[0].close(4004)
    await expect.poll(() => states).toContain('token')
    await new Promise((r) => setTimeout(r, RETRY_MS * 20))
    expect(sockets).toHaveLength(1)
  })
})
