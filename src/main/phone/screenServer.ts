import crypto from 'crypto'
import http from 'http'
import type net from 'net'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { PHONE_KEYS, type PhoneDevice, type PhoneKey, type PhoneKind } from './device'
import { SCREEN_PAGE } from './screenPage'

const SKIP_FRAMES_WHILE_A_VIEWER_LAGS_BYTES = 4 * 1024 * 1024
const LONGEST_LIVE_TEXT = 64

export interface LiveInput {
  t: 'touch' | 'key' | 'text'
  phase?: unknown
  x?: unknown
  y?: unknown
  key?: unknown
  text?: unknown
}

export function applyLiveInput(device: PhoneDevice, m: LiveInput): void {
  if (m.t === 'touch') {
    const { phase, x, y } = m
    if (phase !== 'down' && phase !== 'move' && phase !== 'up') return
    if (typeof x !== 'number' || typeof y !== 'number' || !(x >= 0 && x <= 1 && y >= 0 && y <= 1))
      return
    device.touch(
      { x: Math.round(x * device.screen.width), y: Math.round(y * device.screen.height) },
      phase
    )
  } else if (m.t === 'key' && PHONE_KEYS.includes(m.key as PhoneKey)) {
    device.keyLive(m.key as PhoneKey)
  } else if (m.t === 'text' && typeof m.text === 'string' && m.text.length <= LONGEST_LIVE_TEXT) {
    device.typeLive(m.text)
  }
}

export class PhoneScreen {
  private clients = new Set<WebSocket>()
  private stopFrames: (() => void) | null = null
  private device: PhoneDevice | null = null
  private note = 'Starting…'

  private constructor(
    readonly url: string,
    private kind: PhoneKind,
    private server: http.Server,
    private wss: WebSocketServer
  ) {}

  static open(kind: PhoneKind): Promise<PhoneScreen> {
    const token = crypto.randomBytes(24).toString('hex')
    const page = `/${token}/`
    const server = http.createServer((req, res) => {
      if (req.url !== page) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(SCREEN_PAGE)
    })
    const wss = new WebSocketServer({ noServer: true })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo
        const screen = new PhoneScreen(`http://127.0.0.1:${port}${page}`, kind, server, wss)
        server.on('upgrade', (req, socket, head) => {
          if (req.url !== `${page}ws`) {
            socket.destroy()
            return
          }
          wss.handleUpgrade(req, socket, head, (ws) => screen.join(ws))
        })
        resolve(screen)
      })
    })
  }

  private join(ws: WebSocket): void {
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary || !this.device) return
      try {
        applyLiveInput(this.device, JSON.parse(String(raw)) as LiveInput)
      } catch {}
    })
    ws.on('close', () => {
      this.clients.delete(ws)
      if (this.clients.size === 0) this.pauseFrames()
    })
    this.clients.add(ws)
    ws.send(this.hello())
    this.playFrames()
  }

  private hello(): string {
    return JSON.stringify({ kind: this.kind, note: this.note })
  }

  setNote(note: string): void {
    this.note = note
    const hello = this.hello()
    for (const ws of this.clients) ws.send(hello)
  }

  attach(device: PhoneDevice): void {
    this.device = device
    this.playFrames()
  }

  private playFrames(): void {
    if (!this.device || this.stopFrames || this.clients.size === 0) return
    this.stopFrames = this.device.frames((image) => {
      for (const ws of this.clients)
        if (ws.readyState === ws.OPEN && ws.bufferedAmount < SKIP_FRAMES_WHILE_A_VIEWER_LAGS_BYTES)
          ws.send(image)
    })
  }

  private pauseFrames(): void {
    this.stopFrames?.()
    this.stopFrames = null
  }

  close(): void {
    this.pauseFrames()
    this.device = null
    // PLATFORM§19
    for (const ws of this.clients) ws.close()
    this.clients.clear()
    this.wss.close()
    this.server.close()
  }
}
