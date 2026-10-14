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
}

// MUSE§5
export async function withServe<T>(
  options: ServeOptions,
  use: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>
): Promise<T> {
  const child = spawn(options.binary, ['serve', ...(options.extraArgs ?? [])], {
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
    await request('initialize', { clientInfo: { name: 'koloft', version: '1' } })
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

function museSession(raw: unknown): HistoryEntry | undefined {
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
    updatedAt: seconds(s.updatedAt)
  }
}

// MUSE§5
export async function listMuseSessions(options: ServeOptions): Promise<HistoryEntry[]> {
  return withServe(options, async (request) => {
    const found: HistoryEntry[] = []
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

export interface MuseHistory {
  turns: Turn[]
  lastReplyId?: string
}

export function museHistory(items: unknown, n: number): MuseHistory {
  const log = new TurnLog()
  let lastReplyId: string | undefined
  for (const raw of Array.isArray(items) ? items : []) {
    const item = record(raw)
    if (typeof item.text !== 'string') continue
    const at = seconds(item.recordedAt) ?? 0
    if (item.kind === 'userMessage') log.add({ who: 'owner', text: item.text, at: at * 1000 })
    else if (item.kind === 'agentMessage') {
      log.add({ who: 'assistant', text: item.text, at: at * 1000 })
      if (typeof item.itemId === 'string') lastReplyId = item.itemId
    }
  }
  return { turns: log.last(n), lastReplyId }
}

// MUSE§5
export async function readMuseTurns(
  options: ServeOptions,
  sessionId: string,
  n: number
): Promise<MuseHistory> {
  return withServe({ ...options, extraArgs: ['--provider', 'echo'] }, async (request) => {
    const reply = record(await request('session/read', { sessionId, excludeItems: false }))
    return museHistory(record(reply.history).items, n)
  })
}
