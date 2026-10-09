import { describe, it, expect, afterEach } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { DiscordHttpError, DiscordRest } from '../../src/main/discord/rest'

const LIMIT_PER_CHANNEL = 5
const RETRY_AFTER_S = 0.2

let server: http.Server

afterEach(async () => {
  await new Promise((r) => server.close(r))
})

async function fakeDiscord(
  answer: (req: http.IncomingMessage, body: string) => { status: number; json: unknown }
): Promise<string> {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const { status, json } = answer(req, body)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(json))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('DiscordRest', () => {
  it('sends the bot token, and a burst past the per-channel limit waits retry_after and arrives whole and in order', async () => {
    const delivered: string[] = []
    const auth = new Set<string | undefined>()
    let refusedAt = 0
    let used = 0
    const url = await fakeDiscord((req, body) => {
      auth.add(req.headers.authorization)
      if (used >= LIMIT_PER_CHANNEL && Date.now() - refusedAt < RETRY_AFTER_S * 1000)
        return { status: 429, json: { retry_after: RETRY_AFTER_S } }
      if (used >= LIMIT_PER_CHANNEL) used = 0
      used++
      if (used === LIMIT_PER_CHANNEL) refusedAt = Date.now()
      delivered.push((JSON.parse(body) as { content: string }).content)
      return { status: 200, json: { id: String(delivered.length) } }
    })
    const rest = new DiscordRest(url, 'tok')
    const texts = Array.from({ length: 8 }, (_, i) => `part ${i + 1}`)
    await Promise.all(
      texts.map((content) => rest.request('POST', '/channels/9/messages', { content }))
    )
    expect(delivered).toEqual(texts)
    expect([...auth]).toEqual(['Bot tok'])
  })

  it('edits to a channel’s messages wait in a queue of their own, so a held-up edit never holds back a post there', async () => {
    let release: () => void = () => undefined
    const editHeld = new Promise<void>((r) => (release = r))
    const order: string[] = []
    server = http.createServer((req, res) => {
      const done = (): void => {
        order.push(req.method!)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      }
      if (req.method === 'PATCH') void editHeld.then(done)
      else done()
      req.resume()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const rest = new DiscordRest(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      'tok'
    )
    const edit = rest.request('PATCH', '/channels/9/messages/1', { components: [] })
    await rest.request('POST', '/channels/9/messages', { content: 'reply' })
    release()
    await edit
    expect(order).toEqual(['POST', 'PATCH'])
  })

  it('a refused token surfaces as a 401 error and the queue keeps going for the next call', async () => {
    let calls = 0
    const url = await fakeDiscord(() =>
      ++calls === 1 ? { status: 401, json: {} } : { status: 200, json: { username: 'bot' } }
    )
    const rest = new DiscordRest(url, 'tok')
    const first = rest.request('GET', '/users/@me')
    const second = rest.request('GET', '/users/@me')
    await expect(first).rejects.toMatchObject({ status: 401 })
    await expect(first).rejects.toBeInstanceOf(DiscordHttpError)
    await expect(second).resolves.toEqual({ username: 'bot' })
  })
})
