import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import http from 'http'
import os from 'os'
import path from 'path'
import WebSocket, { WebSocketServer } from 'ws'
import { BROWSER_TAB_ENV } from '@shared/browserTabEnv'
import { CODEX_TMP_DIR, ownedByThisRun } from './leftovers'
import { sharedProcessTable, type ProcessRow } from './processTable'
import { envMs } from './sessionRuntime'

export type CodexFrame = Record<string, unknown>

export interface CodexProcessOptions {
  binary: string
  cwd: string
  env?: NodeJS.ProcessEnv
  sessionEnv?: Record<string, string>
  configOverrides?: readonly string[]
  args?: string[]
  timeoutMs?: number
  maxFrameBytes?: number
}

export interface CodexUpstream {
  readonly ready: Promise<void>
  readonly limit: number
  write(raw: string | Buffer): void
  stop(): Promise<void>
}

export type CodexUpstreamFactory = (
  frame: (read: ReadFrame) => void,
  failure: (error: Error) => void
) => CodexUpstream

export interface CodexTransportOptions extends CodexProcessOptions {
  upstream?: CodexUpstreamFactory
  skillRoots?: string[]
  onFrame(direction: 'client' | 'server', frame: CodexFrame): void
  observes?(direction: 'client' | 'server', head: CodexFrameHead): boolean
  onDisconnect?(): void
  onError?(error: Error): void
}

const DEFAULT_TIMEOUT = 15_000
export const DEFAULT_MAX_FRAME = 32 * 1024 * 1024
export const TUI_STALLED_AFTER_MS = 30_000
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// CODEX§10
export function codexEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides }
  const runtime = new Set([
    'CODEX_APP_TOOLS_PIPE_PATH',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'CODEX_MCP_NODE_PATH',
    'CODEX_PERMISSION_PROFILE',
    'CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE',
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
    'CODEX_SHELL',
    'CODEX_CI',
    'CLAUDECODE',
    'CLAUDE_EFFORT',
    'AI_AGENT',
    'TERM_SESSION_ID',
    ...BROWSER_TAB_ENV
  ])
  for (const key of Object.keys(env)) {
    if (runtime.has(key) || key.startsWith('KOLOFT_') || key.startsWith('CLAUDE_CODE_'))
      delete env[key]
  }
  return env
}

export interface CodexFrameHead {
  method?: string
  replyTo?: string | number
}

export interface ReadFrame {
  raw: Buffer
  head: CodexFrameHead
  parse(): CodexFrame
}

const NEWLINE = 0x0a
const HEAD_PEEK_BYTES = 256
// CODEX§1
const FRAME_HEAD =
  /^\{(?:"method":"([^"\\]*)"|"id":(?:(\d+)|"([^"\\]*)"),(?:"method":"([^"\\]*)"|"(?:result|error)"))/

function parseFrame(text: string): CodexFrame {
  const frame: unknown = JSON.parse(text)
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('Codex sent a non-object protocol frame')
  }
  return frame as CodexFrame
}

export function readFrame(line: Buffer): ReadFrame | undefined {
  let parsed: CodexFrame | undefined
  const parse = (): CodexFrame => (parsed ??= parseFrame(line.toString()))
  const m = FRAME_HEAD.exec(line.toString('utf8', 0, HEAD_PEEK_BYTES))
  if (m) {
    const method = m[1] ?? m[4]
    return {
      raw: line,
      head: method !== undefined ? { method } : { replyTo: m[2] !== undefined ? +m[2] : m[3] },
      parse
    }
  }
  const text = line.toString()
  if (!text.trim()) return undefined
  parsed = parseFrame(text)
  return { raw: line, head: headOf(parsed), parse }
}

// CODEX§20
function questionThatWaitsForTheOwner({ raw, head, parse }: ReadFrame): Buffer {
  if (head.method !== 'item/tool/requestUserInput') return raw
  const frame = parse()
  const params = frame.params as Record<string, unknown> | undefined
  if (!params || (params.isBlocking === true && params.autoResolutionMs == null)) return raw
  return Buffer.from(
    JSON.stringify({ ...frame, params: { ...params, isBlocking: true, autoResolutionMs: null } })
  )
}

function headOf({ id, method }: Record<string, unknown>): CodexFrameHead {
  if (typeof method === 'string') return { method }
  return typeof id === 'string' || typeof id === 'number' ? { replyTo: id } : {}
}

async function processRows(): Promise<ProcessRow[]> {
  const table = await sharedProcessTable.fresh()
  if (!table) throw new Error('Could not read the process table')
  return table.rows
}

const processObservers = new Set<(rows: ProcessRow[]) => void>()
let processSampling = false
// CODEX§5
const PROCESS_SAMPLE_MS = envMs('KOLOFT_CODEX_PROCESS_SAMPLE_MS', 5000)

function watchProcesses(observer: (rows: ProcessRow[]) => void): () => void {
  processObservers.add(observer)
  if (!processSampling) {
    processSampling = true
    const sample = async (): Promise<void> => {
      const watchingWhenTheLookBegan = [...processObservers]
      const table = await sharedProcessTable.eachRound(PROCESS_SAMPLE_MS)
      if (table) for (const receive of watchingWhenTheLookBegan) receive(table.rows)
      if (processObservers.size)
        setTimeout(() => {
          void sample()
        }, PROCESS_SAMPLE_MS).unref()
      else processSampling = false
    }
    void sample()
  }
  return () => {
    processObservers.delete(observer)
  }
}

function signal(pid: number, value: NodeJS.Signals): void {
  try {
    process.kill(pid, value)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

class CodexProcess implements CodexUpstream {
  readonly child: ChildProcessWithoutNullStreams
  readonly ready: Promise<void>
  private tail: Buffer[] = []
  private tailBytes = 0
  private stopping?: Promise<void>
  private failed = false
  private exited = false
  private owned = new Map<number, string>()
  private unwatch?: () => void

  constructor(
    readonly options: CodexProcessOptions,
    private frame: (read: ReadFrame) => void,
    private failure: (error: Error) => void
  ) {
    const configArgs = (options.configOverrides ?? []).flatMap((value) => ['-c', value])
    this.child = spawn(options.binary, options.args ?? ['app-server', '--stdio', ...configArgs], {
      cwd: options.cwd,
      env: { ...codexEnvironment(options.env), ...options.sessionEnv },
      detached: true,
      stdio: 'pipe'
    })
    this.ready = new Promise((resolve, reject) => {
      this.child.once('spawn', () => {
        this.unwatch = watchProcesses((rows) => {
          this.ownedProcesses(rows)
        })
        resolve()
      })
      this.child.once('error', reject)
    })
    void this.ready.catch(() => {})
    this.child.on('error', (error) => this.fail(error))
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.stdout.on('error', (error) => this.fail(error))
    this.child.stderr.resume()
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.failed || this.stopping) return
      try {
        let start = 0
        let newline: number
        while ((newline = chunk.indexOf(NEWLINE, start)) !== -1) {
          const piece = chunk.subarray(start, newline)
          const raw = this.tail.length ? Buffer.concat([...this.tail, piece]) : piece
          this.tail = []
          this.tailBytes = 0
          start = newline + 1
          if (raw.length > this.limit) throw new Error('Codex frame exceeds the size limit')
          const read = readFrame(raw)
          if (read) this.frame(read)
        }
        if (start < chunk.length) {
          this.tail.push(chunk.subarray(start))
          this.tailBytes += chunk.length - start
        }
        if (this.tailBytes > this.limit) throw new Error('Codex frame exceeds the size limit')
      } catch (error) {
        this.fail(asError(error))
      }
    })
    this.child.stdout.on('end', () => {
      if (!this.stopping && Buffer.concat(this.tail).toString().trim())
        this.fail(new Error('Codex exited with an incomplete protocol frame'))
    })
    this.child.on('exit', (code, sig) => {
      this.exited = true
      if (!this.stopping)
        this.fail(new Error(`Codex app-server exited (${sig ?? code ?? 'unknown'})`))
    })
  }

  get limit(): number {
    return this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME
  }

  private fail(error: Error): void {
    if (this.failed || this.stopping) return
    this.failed = true
    this.failure(error)
  }

  write(raw: string | Buffer): void {
    if (this.stopping || this.failed || this.exited) throw new Error('Codex connection is closed')
    if (this.child.stdin.writableLength + Buffer.byteLength(raw) > this.limit * 2) {
      throw new Error('Codex input queue exceeds the size limit')
    }
    this.child.stdin.write(raw)
    this.child.stdin.write('\n')
  }

  stop(): Promise<void> {
    if (!this.stopping)
      this.stopping = this.stopOwnedProcesses().catch((error) => {
        this.stopping = undefined
        if (this.child.pid)
          this.unwatch = watchProcesses((rows) => {
            this.ownedProcesses(rows)
          })
        throw error
      })
    return this.stopping
  }

  private async stopOwnedProcesses(): Promise<void> {
    await this.ready.catch(() => {})
    this.unwatch?.()
    const root = this.child.pid
    if (!root) return
    const findOwned = async (): Promise<ProcessRow[]> => this.ownedProcesses(await processRows())
    // CODEX§5
    let alive = await findOwned()
    this.child.stdin.end()
    for (const phase of ['SIGTERM', 'SIGKILL'] as const) {
      if (alive.length) {
        if (alive.some((row) => row.pgid === root)) signal(-root, phase)
        for (const row of alive) if (row.pgid !== root) signal(row.pid, phase)
      }
      const deadline = Date.now() + (phase === 'SIGTERM' ? 1200 : 2000)
      while (alive.length && Date.now() < deadline) {
        await sleep(40)
        alive = await findOwned()
      }
      if (!alive.length) {
        this.child.stdout.destroy()
        this.child.stderr.destroy()
        return
      }
    }
    throw new Error('Could not confirm that the Codex run stopped')
  }

  private ownedProcesses(rows: ProcessRow[]): ProcessRow[] {
    const root = this.child.pid
    if (!root) return []
    const current = new Map(rows.map((row) => [row.pid, row]))
    for (const [pid, started] of this.owned) {
      if (current.get(pid)?.started !== started) this.owned.delete(pid)
    }
    for (const row of rows) {
      if (row.pgid === root || (!this.exited && row.pid === root))
        this.owned.set(row.pid, row.started)
    }
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        if (this.owned.has(row.ppid) && !this.owned.has(row.pid)) {
          this.owned.set(row.pid, row.started)
          changed = true
        }
      }
    }
    return rows.filter(
      (row) => this.owned.get(row.pid) === row.started && !row.state.startsWith('Z')
    )
  }
}

export const KOLOFT_INITIALIZE = {
  clientInfo: { name: 'koloft', title: 'Koloft', version: '1' },
  capabilities: { experimentalApi: true }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

function sendRequest<K>(
  pending: Map<K, PendingRequest>,
  id: K,
  method: string,
  params: unknown,
  timeoutMs: number,
  write: (raw: string) => void
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Codex RPC timed out: ${method}`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    try {
      write(JSON.stringify({ id, method, params }))
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      reject(asError(error))
    }
  })
}

function settleRequest<K>(pending: Map<K, PendingRequest>, id: K, parse: () => CodexFrame): void {
  const request = pending.get(id)
  if (!request) return
  const frame = parse()
  pending.delete(id)
  clearTimeout(request.timer)
  if (frame.error) {
    const error = frame.error as { message?: string; code?: number }
    request.reject(new Error(error.message ?? `Codex RPC error ${error.code ?? ''}`))
  } else request.resolve(frame.result)
}

function rejectAll<K>(pending: Map<K, PendingRequest>, error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject(error)
  }
  pending.clear()
}

const OWN_REQUEST_ID_PREFIX = 'koloft-'

export interface CodexTransport {
  url: string
  stop(): Promise<void>
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
}

export async function createCodexTransport(
  options: CodexTransportOptions
): Promise<CodexTransport> {
  const directory = await fs.mkdtemp(path.join(CODEX_TMP_DIR, `koloft-cx-${ownedByThisRun('')}`))
  await fs.chmod(directory, 0o700)
  const socketPath = path.join(directory, 'rpc.sock')
  const server = http.createServer((_req, res) => {
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxFrameBytes ?? DEFAULT_MAX_FRAME
  })
  let client: WebSocket | undefined
  let accepted = false
  let stopping: Promise<void> | undefined
  const pending: Buffer[] = []
  let pendingBytes = 0
  let tuiTookAFrameAt = 0
  const own = new Map<string, PendingRequest>()
  const report = (error: Error): void => {
    try {
      options.onError?.(error)
    } catch {}
  }
  const observe = (direction: 'client' | 'server', { head, parse }: ReadFrame): void => {
    if (options.observes && !options.observes(direction, head)) return
    const frame = parse()
    try {
      options.onFrame(direction, frame)
    } catch (error) {
      report(asError(error))
    }
  }
  const stop = (): Promise<void> => {
    if (!stopping)
      stopping = (async () => {
        rejectAll(own, new Error('Codex connection is closed'))
        client?.terminate()
        server.closeAllConnections()
        await Promise.all([
          upstream.stop(),
          new Promise<void>((resolve) => server.close(() => resolve())),
          new Promise<void>((resolve) => wss.close(() => resolve()))
        ])
        await fs.rm(directory, { recursive: true, force: true })
      })().catch((error) => {
        stopping = undefined
        throw error
      })
    return stopping
  }
  const fail = (error: Error): void => {
    report(error)
    void stop().catch(report)
  }
  const request = (
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_TIMEOUT
  ): Promise<unknown> =>
    sendRequest(own, `${OWN_REQUEST_ID_PREFIX}${randomUUID()}`, method, params, timeoutMs, (raw) =>
      upstream.write(raw)
    )
  const upstreamOf: CodexUpstreamFactory =
    options.upstream ?? ((frame, failure) => new CodexProcess(options, frame, failure))
  const upstream = upstreamOf((read) => {
    const { replyTo } = read.head
    // CODEX§1
    if (typeof replyTo === 'string' && replyTo.startsWith(OWN_REQUEST_ID_PREFIX)) {
      settleRequest(own, replyTo, read.parse)
      return
    }
    const raw = questionThatWaitsForTheOwner(read)
    observe('server', read)
    if (client?.readyState === WebSocket.OPEN) {
      // CODEX§1
      if (client.bufferedAmount === 0) tuiTookAFrameAt = Date.now()
      else if (
        client.bufferedAmount > upstream.limit * 2 &&
        Date.now() - tuiTookAFrameAt > TUI_STALLED_AFTER_MS
      )
        throw new Error('Codex output queue exceeds the size limit')
      client.send(raw, { binary: false }, (error) => {
        if (error) fail(error)
        else tuiTookAFrameAt = Date.now()
      })
    } else if (!accepted) {
      pendingBytes += raw.length
      if (pendingBytes > upstream.limit * 2)
        throw new Error('Codex output queue exceeds the size limit')
      pending.push(raw)
    }
  }, fail)
  server.on('error', fail)
  wss.on('error', fail)
  server.on('upgrade', (req, socket, head) => {
    if (accepted || stopping) {
      socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      accepted = true
      client = ws
      ws.on('error', fail)
      ws.on('message', (bytes, binary) => {
        try {
          if (binary) throw new Error('Codex protocol requires text frames')
          const raw = bytes as Buffer
          const read = readFrame(raw)
          if (!read) return
          const line = raw.includes(NEWLINE) ? JSON.stringify(read.parse()) : raw
          observe('client', read)
          // CODEX§1
          upstream.write(line)
          // CODEX§17
          if (read.head.method === 'initialized' && options.skillRoots)
            request('skills/extraRoots/set', { extraRoots: options.skillRoots }).catch((err) =>
              console.error('[koloft] Codex did not take the koloft skill:', err)
            )
        } catch (error) {
          fail(asError(error))
        }
      })
      ws.on('close', () => {
        void stop()
          .then(() => {
            try {
              options.onDisconnect?.()
            } catch (error) {
              report(asError(error))
            }
          })
          .catch(report)
      })
      for (const raw of pending) ws.send(raw, { binary: false })
      pending.length = 0
    })
  })
  try {
    await upstream.ready
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await fs.chmod(socketPath, 0o600)
    // CODEX§9
    return { url: `unix://${socketPath}`, stop, request }
  } catch (error) {
    await stop().catch(report)
    throw error
  }
}

const METHODS_A_SIDE_CONNECTION_MAY_SEND_NEVER_A_TURN = [
  'thread/list',
  // CODEX§24
  'thread/search',
  'thread/searchOccurrences',
  'thread/turns/list',
  'thread/read',
  'thread/loaded/list',
  'account/read',
  'account/rateLimits/read',
  // CODEX§15
  'account/rateLimitResetCredit/consume',
  'model/list',
  'config/read',
  // CODEX§27
  'hooks/list'
]

export class CodexRpc {
  private process: CodexProcess
  private initialized: Promise<void>
  private nextId = 0
  private pending = new Map<number, PendingRequest>()
  private closed = false
  private handshakeDone = false

  constructor(private options: CodexProcessOptions) {
    this.process = this.spawn()
    // CODEX§28
    this.initialized = this.handshake().catch(async () => {
      await this.process.stop().catch(() => {})
      if (this.closed) throw new Error('Codex RPC connection is closed')
      this.process = this.spawn()
      await this.handshake()
    })
    void this.initialized.then(
      () => (this.handshakeDone = true),
      () => void this.close().catch(() => {})
    )
  }

  private spawn(): CodexProcess {
    return new CodexProcess(
      this.options,
      ({ head, parse }) => {
        if (typeof head.replyTo === 'number') settleRequest(this.pending, head.replyTo, parse)
      },
      (error) => {
        rejectAll(this.pending, error)
        if (this.handshakeDone) void this.close().catch(() => {})
      }
    )
  }

  private async handshake(): Promise<void> {
    await this.process.ready
    await this.send('initialize', KOLOFT_INITIALIZE)
    this.process.write(JSON.stringify({ method: 'initialized' }))
  }

  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (!METHODS_A_SIDE_CONNECTION_MAY_SEND_NEVER_A_TURN.includes(method)) {
      throw new Error(`Codex side connection does not allow ${method}`)
    }
    await this.initialized
    return (await this.send(method, params)) as T
  }

  private send(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex RPC connection is closed'))
    return sendRequest(
      this.pending,
      ++this.nextId,
      method,
      params,
      this.options.timeoutMs ?? DEFAULT_TIMEOUT,
      (raw) => this.process.write(raw)
    )
  }

  get isClosed(): boolean {
    return this.closed
  }

  close(): Promise<void> {
    this.closed = true
    rejectAll(this.pending, new Error('Codex RPC connection is closed'))
    return this.process.stop()
  }
}
