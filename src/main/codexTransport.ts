import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs/promises'
import http from 'http'
import os from 'os'
import path from 'path'
import { StringDecoder } from 'string_decoder'
import { promisify } from 'util'
import WebSocket, { WebSocketServer } from 'ws'
import { BROWSER_TAB_ENV } from '@shared/browserTabEnv'

export type CodexFrame = Record<string, unknown>

export interface CodexProcessOptions {
  binary: string
  cwd: string
  env?: NodeJS.ProcessEnv
  configOverrides?: readonly string[]
  timeoutMs?: number
  maxFrameBytes?: number
}

export interface CodexTransportOptions extends CodexProcessOptions {
  onFrame(direction: 'client' | 'server', frame: CodexFrame): void
  onDisconnect?(): void
  onError?(error: Error): void
}

const DEFAULT_TIMEOUT = 15_000
const DEFAULT_MAX_FRAME = 32 * 1024 * 1024
const execFileAsync = promisify(execFile)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

function parseFrame(text: string, limit: number): CodexFrame {
  if (Buffer.byteLength(text) > limit) throw new Error('Codex frame exceeds the size limit')
  const frame: unknown = JSON.parse(text)
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('Codex sent a non-object protocol frame')
  }
  return frame as CodexFrame
}

interface ProcessRow {
  pid: number
  parent: number
  group: number
  state: string
  started: string
}

async function processRows(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024
  })
  return stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    return match
      ? [
          {
            pid: +match[1],
            parent: +match[2],
            group: +match[3],
            state: match[4],
            started: match[5]
          }
        ]
      : []
  })
}

const processObservers = new Set<(rows: ProcessRow[]) => void>()
let processSampling = false
// CODEX§5
const PROCESS_SAMPLE_MS = 1000

function watchProcesses(observer: (rows: ProcessRow[]) => void): () => void {
  processObservers.add(observer)
  if (!processSampling) {
    processSampling = true
    const sample = async (): Promise<void> => {
      try {
        const rows = await processRows()
        for (const receive of processObservers) receive(rows)
      } catch {}
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

class CodexProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly ready: Promise<void>
  private decoder = new StringDecoder('utf8')
  private tail = ''
  private stopping?: Promise<void>
  private failed = false
  private exited = false
  private owned = new Map<number, string>()
  private unwatch?: () => void

  constructor(
    readonly options: CodexProcessOptions,
    private frame: (raw: string, parsed: CodexFrame) => void,
    private failure: (error: Error) => void
  ) {
    const configArgs = (options.configOverrides ?? []).flatMap((value) => ['-c', value])
    this.child = spawn(options.binary, ['app-server', '--stdio', ...configArgs], {
      cwd: options.cwd,
      env: codexEnvironment(options.env),
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
        this.tail += this.decoder.write(chunk)
        let newline: number
        while ((newline = this.tail.indexOf('\n')) !== -1) {
          const raw = this.tail.slice(0, newline)
          this.tail = this.tail.slice(newline + 1)
          if (raw.trim()) this.frame(raw, parseFrame(raw, this.limit))
        }
        if (Buffer.byteLength(this.tail) > this.limit)
          throw new Error('Codex frame exceeds the size limit')
      } catch (error) {
        this.fail(asError(error))
      }
    })
    this.child.stdout.on('end', () => {
      this.tail += this.decoder.end()
      if (!this.stopping && this.tail.trim())
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

  write(raw: string): void {
    if (this.stopping || this.failed || this.exited) throw new Error('Codex connection is closed')
    if (this.child.stdin.writableLength + Buffer.byteLength(raw) > this.limit * 2) {
      throw new Error('Codex input queue exceeds the size limit')
    }
    this.child.stdin.write(raw + '\n')
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
        if (alive.some((row) => row.group === root)) signal(-root, phase)
        for (const row of alive) if (row.group !== root) signal(row.pid, phase)
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
      if (row.group === root || (!this.exited && row.pid === root))
        this.owned.set(row.pid, row.started)
    }
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        if (this.owned.has(row.parent) && !this.owned.has(row.pid)) {
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export async function createCodexTransport(options: CodexTransportOptions): Promise<{
  url: string
  stop(): Promise<void>
}> {
  // PLATFORM§3
  const directory = await fs.mkdtemp(
    path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'koloft-cx-')
  )
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
  const pending: string[] = []
  let pendingBytes = 0
  const report = (error: Error): void => {
    try {
      options.onError?.(error)
    } catch {}
  }
  const observe = (direction: 'client' | 'server', frame: CodexFrame): void => {
    try {
      options.onFrame(direction, frame)
    } catch (error) {
      report(asError(error))
    }
  }
  const stop = (): Promise<void> => {
    if (!stopping)
      stopping = (async () => {
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
  const upstream = new CodexProcess(
    options,
    (raw, frame) => {
      observe('server', frame)
      if (client?.readyState === WebSocket.OPEN) {
        if (client.bufferedAmount > upstream.limit * 2)
          throw new Error('Codex output queue exceeds the size limit')
        client.send(raw, (error) => {
          if (error) fail(error)
        })
      } else if (!accepted) {
        pendingBytes += Buffer.byteLength(raw)
        if (pendingBytes > upstream.limit * 2)
          throw new Error('Codex output queue exceeds the size limit')
        pending.push(raw)
      }
    },
    fail
  )
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
          const raw = bytes.toString()
          const frame = parseFrame(raw, upstream.limit)
          const line = JSON.stringify(frame)
          observe('client', frame)
          // CODEX§1
          upstream.write(line)
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
      for (const raw of pending) ws.send(raw)
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
    return { url: `unix://${socketPath}`, stop }
  } catch (error) {
    await stop().catch(report)
    throw error
  }
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class CodexRpc {
  private process: CodexProcess
  private initialized: Promise<void>
  private nextId = 0
  private pending = new Map<number, PendingRequest>()
  private closed = false

  constructor(private options: CodexProcessOptions) {
    this.process = new CodexProcess(
      options,
      (_raw, frame) => {
        if (frame.method !== undefined || typeof frame.id !== 'number') return
        const request = this.pending.get(frame.id)
        if (!request) return
        this.pending.delete(frame.id)
        clearTimeout(request.timer)
        if (frame.error) {
          const error = frame.error as { message?: string; code?: number }
          request.reject(new Error(error.message ?? `Codex RPC error ${error.code ?? ''}`))
        } else request.resolve(frame.result)
      },
      (error) => {
        this.rejectPending(error)
        void this.close().catch(() => {})
      }
    )
    this.initialized = this.process.ready.then(async () => {
      await this.send('initialize', {
        clientInfo: { name: 'koloft', title: 'Koloft', version: '1' },
        capabilities: { experimentalApi: true }
      })
      this.process.write(JSON.stringify({ method: 'initialized' }))
    })
    void this.initialized.catch(() => {
      void this.close().catch(() => {})
    })
  }

  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (
      ![
        'thread/list',
        'thread/read',
        'thread/loaded/list',
        'account/read',
        'account/rateLimits/read',
        'model/list',
        'config/read'
      ].includes(method)
    ) {
      throw new Error(`Codex history connection does not allow ${method}`)
    }
    await this.initialized
    return (await this.send(method, params)) as T
  }

  private send(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex RPC connection is closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex RPC timed out: ${method}`))
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.process.write(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(asError(error))
      }
    })
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  close(): Promise<void> {
    this.closed = true
    this.rejectPending(new Error('Codex RPC connection is closed'))
    return this.process.stop()
  }
}
