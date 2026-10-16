import { spawn } from 'child_process'
import os from 'os'
import readline from 'readline'
import { TurnLog, type Turn } from '@shared/turns'
import { record } from './codexObservation'
import type { HistoryEntry } from './storedSessions'

const SERVE_ANSWERS_WITHIN_MS = 15_000
const LIST_PAGE = 200

export interface ServeOptions {
  binary: string
  env: NodeJS.ProcessEnv
  extraArgs?: string[]
  experimental?: boolean
  over?(serveArgs: string[]): { binary: string; args: string[] }
}

export interface MuseHistoryEntry extends HistoryEntry {
  logPath?: string
}

// MUSE§5 MUSE§16
export async function withServe<T>(
  options: ServeOptions,
  use: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>
): Promise<T> {
  const serveArgs = options.extraArgs ?? []
  const command = options.over?.(serveArgs) ?? {
    binary: options.binary,
    args: ['serve', ...serveArgs]
  }
  const child = spawn(command.binary, command.args, {
    cwd: os.homedir(),
    env: options.env,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  let nextId = 0
  let failure: Error | undefined
  const failAll = (error: Error): void => {
    failure ??= error
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  }
  child.on('error', failAll)
  child.stdin.on('error', failAll)
  child.on('exit', () => failAll(new Error('muse serve exited')))
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let frame: Record<string, unknown>
    try {
      frame = record(JSON.parse(line))
    } catch {
      return
    }
    if (typeof frame.id !== 'number') return
    const waiting = pending.get(frame.id)
    if (!waiting) return
    pending.delete(frame.id)
    const error = frame.error ? record(frame.error) : undefined
    if (error) waiting.reject(new Error(String(error.message ?? 'muse serve refused the request')))
    else waiting.resolve(frame.result)
  })
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure)
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`muse serve did not answer ${method}`))
      }, SERVE_ANSWERS_WITHIN_MS)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  try {
    await request('initialize', {
      clientInfo: { name: 'koloft', version: '1' },
      ...(options.experimental && { capabilities: { experimentalApi: true } })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n')
    return await use(request)
  } finally {
    child.kill()
  }
}

const seconds = (iso: unknown): number | undefined => {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? ms / 1000 : undefined
}

function museSession(raw: unknown): MuseHistoryEntry | undefined {
  const s = record(raw)
  if (typeof s.sessionId !== 'string' || typeof s.workspaceRoot !== 'string') return undefined
  if (s.kind !== undefined && s.kind !== 'root') return undefined
  const title = typeof s.title === 'string' && s.title ? s.title : undefined
  return {
    id: s.sessionId,
    cwd: s.workspaceRoot,
    name: title ?? (typeof s.name === 'string' ? s.name : null),
    preview: typeof s.firstUserPrompt === 'string' ? s.firstUserPrompt : undefined,
    createdAt: seconds(s.createdAt),
    updatedAt: seconds(s.updatedAt),
    ...(typeof s.path === 'string' && { logPath: s.path })
  }
}

// MUSE§5
export async function listMuseSessions(options: ServeOptions): Promise<MuseHistoryEntry[]> {
  return withServe(options, async (request) => {
    const found: MuseHistoryEntry[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const reply = record(await request('session/list', { limit: LIST_PAGE, cursor }))
      if (!Array.isArray(reply.sessions))
        throw new Error('Muse history returned an unsupported response.')
      for (const raw of reply.sessions) {
        const session = museSession(raw)
        if (session) found.push(session)
      }
      cursor =
        typeof reply.nextCursor === 'string' && reply.nextCursor ? reply.nextCursor : undefined
      if (cursor && seen.has(cursor)) throw new Error('Muse history repeated a page.')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return found
  })
}

export function museHistory(items: unknown, n: number): Turn[] {
  const log = new TurnLog()
  for (const raw of Array.isArray(items) ? items : []) {
    const item = record(raw)
    if (typeof item.text !== 'string') continue
    const at = (seconds(item.recordedAt) ?? 0) * 1000
    if (item.kind === 'userMessage') log.add({ who: 'owner', text: item.text, at })
    else if (item.kind === 'agentMessage') log.add({ who: 'assistant', text: item.text, at })
  }
  return log.last(n)
}

export interface MuseAsk {
  approval?: { id: string; command?: string }
  question?: { id: string; question: string; options: { label: string; description?: string }[] }
}

const commandOf = (args: Record<string, unknown>): string | undefined =>
  [args.command, args.url, args.path].find((v): v is string => typeof v === 'string')

// MUSE§5 MUSE§11
export function museAsk(reply: unknown): MuseAsk {
  const r = record(reply)
  const approval = record(Array.isArray(r.approvals) ? r.approvals[0] : undefined)
  if (typeof approval.approvalId === 'string')
    return { approval: { id: approval.approvalId, command: commandOf(record(approval.rawArgs)) } }
  const input = record(Array.isArray(r.userInputs) ? r.userInputs[0] : undefined)
  const questions = Array.isArray(input.questions) ? input.questions.map(record) : []
  const q = questions[0]
  if (typeof input.userInputId !== 'string' || questions.length !== 1) return {}
  if (typeof q.question !== 'string' || record(q.selection).mode !== 'single') return {}
  const options = (Array.isArray(q.options) ? q.options : []).flatMap((raw) => {
    const o = record(raw)
    return typeof o.label === 'string'
      ? [
          {
            label: o.label,
            ...(typeof o.description === 'string' && { description: o.description })
          }
        ]
      : []
  })
  return options.length
    ? { question: { id: input.userInputId, question: q.question, options } }
    : {}
}

// MUSE§5
export function readMuseAsk(options: ServeOptions, sessionId: string): Promise<MuseAsk> {
  return withServe({ ...options, extraArgs: ['--provider', 'echo'] }, async (request) =>
    museAsk(await request('approval/listPending', { sessionId }))
  )
}

// MUSE§13
const SIGNED_IN_STATES = ['apiKey', 'accountLogin']

// MUSE§13
export async function museSignedIn(options: ServeOptions): Promise<boolean> {
  return withServe({ ...options, experimental: true }, async (request) =>
    SIGNED_IN_STATES.includes(String(record(await request('account/read', {})).state))
  )
}

// MUSE§13
export function storeMuseKey(options: ServeOptions, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.binary, ['auth', 'set', '--provider', 'meta', '--api-key-stdin'], {
      cwd: os.homedir(),
      env: options.env,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    let said = ''
    child.stderr.on('data', (chunk) => (said += String(chunk)))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(said.trim() || 'muse auth set failed'))
    )
    child.stdin.end(key)
  })
}

// MUSE§5
export async function readMuseTurns(
  options: ServeOptions,
  sessionId: string,
  n: number
): Promise<Turn[]> {
  return withServe({ ...options, extraArgs: ['--provider', 'echo'] }, async (request) => {
    const reply = record(await request('session/read', { sessionId, excludeItems: false }))
    return museHistory(record(reply.history).items, n)
  })
}
