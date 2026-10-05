import WebSocket from 'ws'

export const INTENTS = 1 | 512 | 4096 | 32768

export const TOKEN_REFUSED = 4004
export const INTENT_NOT_ALLOWED = 4014
const SESSION_CANNOT_RESUME = new Set([4007, 4009])
const CLOSE_KEEPING_SESSION = 4000
const NORMAL_CLOSE = 1000
const MAX_RETRY_MS = 60_000
const MAX_HEARTBEAT_MS = 120_000

export type GatewayState = 'connecting' | 'ready' | 'token' | 'intents'

export interface GatewayOptions {
  token: string
  url: string
  onState(state: GatewayState): void
  onDispatch(type: string, data: unknown): void
  retryMs?: number
  intentsRetryMs?: number
}

interface Payload {
  op: number
  d: unknown
  s: number | null
  t: string | null
}

function gatewayAddress(url: string): string {
  const u = new URL(url)
  u.searchParams.set('v', '10')
  u.searchParams.set('encoding', 'json')
  return u.toString()
}

// ADR-0027 PLATFORM§39
export class DiscordGateway {
  private ws: WebSocket | null = null
  private seq: number | null = null
  private sessionId: string | null = null
  private acked = true
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private firstBeat: ReturnType<typeof setTimeout> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private stopped = false
  private readonly retryMs: number
  private readonly intentsRetryMs: number

  constructor(private o: GatewayOptions) {
    this.retryMs = o.retryMs ?? 1000
    this.intentsRetryMs = o.intentsRetryMs ?? 30_000
  }

  start(): void {
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.ws?.close(NORMAL_CLOSE)
    this.ws = null
  }

  private open(): void {
    this.o.onState('connecting')
    const ws = new WebSocket(gatewayAddress(this.o.url))
    this.ws = ws
    ws.on('message', (raw) => this.onPayload(ws, JSON.parse(raw.toString()) as Payload))
    ws.on('close', (code) => this.onClose(ws, code))
    ws.on('error', () => undefined)
  }

  private send(ws: WebSocket, op: number, d: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }))
  }

  private beat(ws: WebSocket): void {
    if (!this.acked) {
      ws.terminate()
      return
    }
    this.acked = false
    this.send(ws, 1, this.seq)
  }

  private onPayload(ws: WebSocket, p: Payload): void {
    if (ws !== this.ws) return
    if (p.s !== null && p.s !== undefined) this.seq = p.s
    if (p.op === 10) {
      const interval = Math.min(
        (p.d as { heartbeat_interval: number }).heartbeat_interval,
        MAX_HEARTBEAT_MS
      )
      this.acked = true
      this.firstBeat = setTimeout(() => {
        this.beat(ws)
        this.heartbeat = setInterval(() => this.beat(ws), interval)
      }, interval * Math.random())
      if (this.sessionId)
        this.send(ws, 6, { token: this.o.token, session_id: this.sessionId, seq: this.seq })
      else
        this.send(ws, 2, {
          token: this.o.token,
          intents: INTENTS,
          properties: { os: process.platform, browser: 'koloft', device: 'koloft' }
        })
    } else if (p.op === 11) {
      this.acked = true
    } else if (p.op === 1) {
      this.send(ws, 1, this.seq)
    } else if (p.op === 7) {
      ws.close(CLOSE_KEEPING_SESSION)
    } else if (p.op === 9) {
      if (!p.d) this.forgetSession()
      ws.close(CLOSE_KEEPING_SESSION)
    } else if (p.op === 0 && p.t) {
      if (p.t === 'READY') this.sessionId = (p.d as { session_id: string }).session_id
      if (p.t === 'READY' || p.t === 'RESUMED') {
        this.failures = 0
        this.o.onState('ready')
      }
      this.o.onDispatch(p.t, p.d)
    }
  }

  private forgetSession(): void {
    this.sessionId = null
    this.seq = null
  }

  private onClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return
    this.clearTimers()
    this.ws = null
    if (this.stopped) return
    if (code === TOKEN_REFUSED) {
      this.o.onState('token')
      return
    }
    if (code === INTENT_NOT_ALLOWED) {
      this.forgetSession()
      this.o.onState('intents')
      this.retry = setTimeout(() => this.open(), this.intentsRetryMs)
      return
    }
    if (SESSION_CANNOT_RESUME.has(code)) this.forgetSession()
    const delay = Math.min(this.retryMs * 2 ** this.failures, MAX_RETRY_MS)
    this.failures++
    this.retry = setTimeout(() => this.open(), delay)
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.firstBeat) clearTimeout(this.firstBeat)
    if (this.retry) clearTimeout(this.retry)
    this.heartbeat = null
    this.firstBeat = null
    this.retry = null
  }
}
