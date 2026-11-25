process.env.TZ = 'America/Los_Angeles'

import fs from 'fs'
import os from 'os'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  UsageCache,
  listUsageFiles,
  statOf,
  type ScannedFile,
  type UsageFile
} from '../../src/main/usageCache'
import { machineUsageDirs } from '../../src/main/remote/usageMirror'
import { costUsdOf, resolvePricing } from '../../src/shared/pricing'
import type { UsageRead } from '../../src/shared/types'

const GOLDEN = path.join(__dirname, 'usage-records')
const MACHINE = 'box'

let root: string

const write = (file: string, lines: unknown[]): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
  )
}

function varint(n: number): number[] {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
const lengthDelimited = (field: number, bytes: number[]): number[] => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes
]
const varintField = (field: number, value: number): number[] => [
  ...varint(field * 8),
  ...varint(value)
]
const text = (s: string): number[] => [...Buffer.from(s)]

function conversationDb(file: string, callModels: string[], configured: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(
    'create table steps (idx integer, step_type integer, step_payload blob);' +
      'create table gen_metadata (idx integer, data blob);' +
      'create table executor_metadata (idx integer, data blob)'
  )
  const gen = db.prepare('insert into gen_metadata values (?, ?)')
  callModels.forEach((model, i) =>
    gen.run(
      i,
      Uint8Array.from(
        lengthDelimited(1, [...varintField(2, 300), ...lengthDelimited(19, text(model))])
      )
    )
  )
  db.prepare('insert into executor_metadata values (?, ?)').run(
    0,
    Uint8Array.from(
      lengthDelimited(
        10,
        lengthDelimited(1, [...varintField(3, 1), ...lengthDelimited(28, text(configured))])
      )
    )
  )
  db.close()
}

const claudeCall = (o: {
  session: string
  id?: string
  req?: string
  at: string
  model?: string
  tokens: [number, number, number, number, number?]
  sidechain?: boolean
}) => ({
  parentUuid: null,
  isSidechain: o.sidechain ?? false,
  ...(o.sidechain ? { agentId: 'a1' } : {}),
  type: 'assistant',
  sessionId: o.session,
  timestamp: o.at,
  ...(o.req ? { requestId: o.req } : {}),
  message: {
    ...(o.id ? { id: o.id } : {}),
    type: 'message',
    role: 'assistant',
    model: o.model ?? 'claude-opus-5-5',
    content: [{ type: 'text', text: 'Done.' }],
    usage: {
      input_tokens: o.tokens[0],
      output_tokens: o.tokens[1],
      cache_creation_input_tokens: o.tokens[2],
      cache_read_input_tokens: o.tokens[3],
      ...(o.tokens[4] !== undefined
        ? {
            cache_creation: { ephemeral_1h_input_tokens: o.tokens[4], ephemeral_5m_input_tokens: 0 }
          }
        : {})
    }
  }
})
const claudeUser = (session: string, at: string, words: string) => ({
  type: 'user',
  sessionId: session,
  timestamp: at,
  message: { role: 'user', content: words }
})

const codexMeta = (id: string, cwd: string, source: unknown = 'cli') => ({
  timestamp: '2026-10-15T19:00:00.000Z',
  type: 'session_meta',
  payload: { id, cwd, source, cli_version: '0.140.0' }
})
const codexTurn = (turn: string, model: string) => ({
  timestamp: '2026-10-15T19:00:01.000Z',
  type: 'turn_context',
  payload: { turn_id: turn, model, cwd: '/repo' }
})
const codexUsage = (
  at: string,
  turn: string,
  response: string,
  input: number,
  cached: number,
  out: number
) => ({
  timestamp: at,
  type: 'token_usage_record',
  payload: {
    thread_id: 'ignored',
    turn_id: turn,
    response_id: response,
    usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: out,
      reasoning_output_tokens: 0,
      total_tokens: input + out
    },
    turn_token_usage: { input_tokens: input * 10, output_tokens: out * 10 },
    thread_token_usage: { input_tokens: input * 100, output_tokens: out * 100 }
  }
})
const codexSaid = (words: string) => ({
  timestamp: '2026-10-15T19:00:02.000Z',
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: words }] }
})

const agyStep = (i: number, type: string, at: string, tokens?: [number, number, number]) => ({
  step_index: i,
  source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL',
  type,
  status: 'DONE',
  created_at: at,
  content: type === 'USER_INPUT' ? 'sort the fixtures' : 'Sorted.',
  ...(tokens
    ? { input_tokens: tokens[0], output_tokens: tokens[1], cache_read_tokens: tokens[2] }
    : {})
})

interface Homes {
  transcripts: { file: string; workspace: string }[]
  codexHome: string
  geminiDir: string
  userData: string
}

function seed(): Homes {
  const claudeProjects = path.join(root, 'home', '.claude', 'projects', '-ws')
  const parent = path.join(claudeProjects, 'c-parent.jsonl')
  const fork = path.join(claudeProjects, 'c-fork.jsonl')
  const quiet = path.join(claudeProjects, 'c-quiet.jsonl')
  write(parent, [
    claudeUser('c-parent', '2026-10-15T18:59:00.000Z', 'read the file'),
    claudeCall({
      session: 'c-parent',
      id: 'msg_1',
      req: 'req_1',
      at: '2026-10-15T19:00:00.000Z',
      tokens: [3, 2, 5000, 10000, 5000]
    }),
    claudeCall({
      session: 'c-parent',
      id: 'msg_1',
      req: 'req_1',
      at: '2026-10-15T19:00:00.000Z',
      tokens: [3, 120, 5000, 10000, 5000]
    }),
    claudeCall({
      session: 'c-parent',
      at: '2026-10-15T19:01:00.000Z',
      model: 'claude-sonnet-5-5',
      tokens: [7, 40, 0, 2000]
    }),
    claudeCall({
      session: 'c-parent',
      at: '2026-10-15T19:01:00.000Z',
      model: 'claude-sonnet-5-5',
      tokens: [7, 40, 0, 2000]
    }),
    claudeCall({
      session: 'c-parent',
      id: 'msg_s',
      req: 'req_s',
      at: '2026-10-15T19:02:00.000Z',
      model: '<synthetic>',
      tokens: [0, 0, 0, 0]
    }),
    claudeCall({
      session: 'c-parent',
      id: 'msg_2',
      req: 'req_2',
      at: '2026-10-16T08:00:00.000Z',
      model: 'claude-opus-4-20250514',
      tokens: [10, 30, 100, 1000]
    }),
    '{"type":"assistant","sessionId":"c-parent","timestamp":"2026-10-16T08:00:01.000Z","message":{"id":"msg_torn","usa'
  ])
  write(path.join(claudeProjects, 'c-parent', 'subagents', 'agent-a1.jsonl'), [
    claudeCall({
      session: 'c-parent',
      id: 'msg_sub',
      req: 'req_sub',
      at: '2026-10-15T19:03:00.000Z',
      model: 'claude-haiku-5-5',
      tokens: [50, 60, 0, 700],
      sidechain: true
    })
  ])
  fs.writeFileSync(
    path.join(claudeProjects, 'c-parent', 'subagents', 'notes.txt'),
    'not a transcript\n'
  )
  write(fork, [
    claudeUser('c-fork', '2026-10-15T20:00:00.000Z', 'try another way'),
    claudeCall({
      session: 'c-fork',
      id: 'msg_1',
      req: 'req_1',
      at: '2026-10-15T19:00:00.000Z',
      tokens: [3, 120, 5000, 10000, 5000]
    }),
    claudeCall({
      session: 'c-fork',
      id: 'msg_f',
      req: 'req_f',
      at: '2026-10-15T20:00:05.000Z',
      model: 'claude-fable-5-2',
      tokens: [4, 9, 0, 3000]
    })
  ])
  write(quiet, [claudeUser('c-quiet', '2026-10-15T21:00:00.000Z', 'hello')])

  const codexHome = path.join(root, 'home', '.codex')
  const day = path.join(codexHome, 'sessions', '2026', '10', '15')
  write(path.join(day, 'rollout-2026-10-15T12-00-00-x-main.jsonl'), [
    codexMeta('x-main', '/repo'),
    codexTurn('t1', 'gpt-6.1-sol'),
    codexSaid('looking'),
    codexUsage('2026-10-15T19:00:03.000Z', 't1', 'r1', 1000, 800, 30),
    codexUsage('2026-10-15T19:00:03.000Z', 't1', 'r1', 1000, 800, 30),
    codexUsage('2026-10-15T19:00:04.000Z', 't1', 'r2', 300000, 100000, 50),
    codexTurn('t2', 'gpt-6-astra'),
    codexUsage('2026-10-16T09:00:00.000Z', 't2', 'r3', 500, 0, 20)
  ])
  write(path.join(day, 'rollout-2026-10-15T12-05-00-x-child.jsonl'), [
    codexMeta('x-child', '/repo', {
      subagent: { thread_spawn: { parent_thread_id: 'x-main', depth: 1 } }
    }),
    codexMeta('x-main', '/repo'),
    codexTurn('t9', 'gpt-6.1-terra'),
    codexUsage('2026-10-15T19:10:00.000Z', 't9', 'r9', 2000, 1000, 10)
  ])
  write(path.join(day, 'rollout-2026-10-15T13-00-00-x-placed.jsonl'), [
    codexMeta('x-placed', '/elsewhere'),
    codexTurn('t1', 'gpt-5.5'),
    codexUsage('2026-10-15T20:00:00.000Z', 't1', 'r1', 400, 100, 10)
  ])
  write(path.join(day, 'notes.jsonl'), [codexMeta('x-notes', '/repo')])
  write(path.join(codexHome, 'archived_sessions', 'rollout-2026-09-01T10-00-00-x-old.jsonl'), [
    codexMeta('x-old', '/repo-old'),
    codexTurn('t1', 'gpt-6.2-unknown'),
    codexUsage('2026-09-01T17:00:00.000Z', 't1', 'r1', 100, 0, 5)
  ])

  const geminiDir = path.join(root, 'home', '.gemini')
  const app = path.join(geminiDir, 'antigravity-cli')
  const transcript = (id: string) =>
    path.join(app, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
  write(transcript('g-one'), [
    agyStep(0, 'USER_INPUT', '2026-10-15T19:00:00Z'),
    agyStep(1, 'PLANNER_RESPONSE', '2026-10-15T19:00:05Z', [100, 20, 300]),
    agyStep(2, 'GENERIC', '2026-10-15T19:00:06Z', [999, 999, 999]),
    agyStep(3, 'PLANNER_RESPONSE', '2026-10-15T19:00:07Z', [0, 0, 0]),
    agyStep(4, 'PLANNER_RESPONSE', '2026-10-15T19:00:09Z', [40, 8, 120]),
    agyStep(5, 'PLANNER_RESPONSE', '2026-10-16T07:30:00Z', [10, 2, 0])
  ])
  conversationDb(
    path.join(app, 'conversations', 'g-one.db'),
    ['gemini-3.1-pro', 'gemini-3.1-flash-lite', 'gemini-3.6-flash-preview'],
    'gemini-3.1-pro'
  )
  write(transcript('g-nodb'), [agyStep(0, 'PLANNER_RESPONSE', '2026-10-15T22:00:00Z', [5, 5, 5])])
  fs.mkdirSync(path.join(app, 'brain', 'g-empty'), { recursive: true })

  const userData = path.join(root, 'userData')
  const remote = machineUsageDirs(userData, MACHINE)
  write(
    path.join(
      remote.codexHome,
      'sessions',
      '2026',
      '10',
      '15',
      'rollout-2026-10-15T15-00-00-x-remote.jsonl'
    ),
    [
      codexMeta('x-remote', '/home/me/site'),
      codexTurn('t1', 'gpt-6.2-sol'),
      codexUsage('2026-10-15T22:00:00.000Z', 't1', 'r1', 700, 200, 40)
    ]
  )
  const remoteApp = path.join(remote.geminiDir, 'antigravity-cli')
  write(
    path.join(remoteApp, 'brain', 'g-remote', '.system_generated', 'logs', 'transcript.jsonl'),
    [agyStep(0, 'PLANNER_RESPONSE', '2026-10-15T23:00:00Z', [60, 6, 600])]
  )
  conversationDb(path.join(remoteApp, 'conversations', 'g-remote.db'), [], 'gemini-3.8-flash')

  return {
    transcripts: [
      { file: fork, workspace: '/ws' },
      { file: parent, workspace: '/ws' },
      { file: quiet, workspace: '/ws' }
    ],
    codexHome,
    geminiDir,
    userData
  }
}

const END_OF_RUN = 'end-of-run.jsonl'

async function scanInTheWorker(files: UsageFile[]): Promise<ScannedFile[]> {
  const end = path.join(root, END_OF_RUN)
  fs.writeFileSync(end, '')
  const posted: ScannedFile[] = []
  let ended!: () => void
  const done = new Promise<void>((resolve) => (ended = resolve))
  vi.resetModules()
  vi.doMock('worker_threads', () => ({
    parentPort: {
      postMessage: (m: ScannedFile) => (m.file === end ? ended() : posted.push(m))
    },
    workerData: { files: [...files, { file: end, backend: 'claude', workspace: '' }] }
  }))
  await import('../../src/main/usageScanWorker')
  await done
  vi.doUnmock('worker_threads')
  return posted
}

const PLACES: Record<string, { workspace: string; title: string }> = {
  'c-parent': { workspace: '/ws-from-the-row', title: 'Read the file' },
  'c-fork': { workspace: '/ws-from-the-row', title: 'Try another way' },
  'x-placed': { workspace: '/ws-codex-row', title: 'Placed by its row' },
  'g-one': { workspace: '/ws-agy', title: 'Sort the fixtures' },
  'g-remote': { workspace: 'ssh://box/home/me/agy', title: 'On the machine' }
}

async function readUsage(homes: Homes): Promise<{ listed: UsageFile[]; read: UsageRead }> {
  let listed: UsageFile[] = []
  let finished!: () => void
  const changed = new Promise<void>((resolve) => (finished = resolve))
  const usage = new UsageCache({
    cacheFile: () => path.join(root, 'usage-cache.json'),
    listFiles: async () =>
      (listed = await listUsageFiles(homes.transcripts, [
        { codexHome: homes.codexHome, geminiDir: homes.geminiDir },
        machineUsageDirs(homes.userData, MACHINE)
      ])),
    stat: statOf,
    scan: (files, scanned, ended) =>
      void scanInTheWorker(files).then((posts) => {
        for (const p of posts) scanned(p)
        ended()
      }),
    codexWorkspaces: (cwds) => cwds.map((cwd) => `workspace of ${cwd}`),
    sessionPlaces: () => (backend, id, host) => {
      const place = PLACES[id]
      return (
        place && {
          ...place,
          workspace: `${place.workspace} (${backend}${host ? ' on ' + host : ''})`
        }
      )
    },
    changed: (read) => !read.reading && finished()
  })
  await usage.read()
  await changed
  return { listed, read: await usage.read() }
}

const relative = (p: string | undefined): string => (p ? path.relative(root, p) : '-')

function listedText(listed: UsageFile[]): string {
  return listed
    .map((f) =>
      [
        f.backend,
        relative(f.file),
        `workspace=${f.workspace || '-'}`,
        `session=${f.sessionId ?? '-'}`,
        `db=${relative(f.db)}`,
        `host=${f.host ?? '-'}`
      ].join('  ')
    )
    .join('\n')
}

function rowsText(read: UsageRead): string {
  const rows = read.rows.map((r) => {
    const pricing = resolvePricing(r.model)
    const cost = pricing ? (costUsdOf(pricing, r) + r.surchargeUsd).toFixed(9) : 'unpriced'
    return [
      r.backend,
      r.workspace,
      r.sessionId,
      r.day,
      r.model || '(no model)',
      `in=${r.inTok} out=${r.outTok} cacheWrite=${r.cacheWriteTok} cacheWrite1h=${r.cacheWrite1hTok} cacheRead=${r.cacheReadTok}`,
      `surcharge=${r.surchargeUsd.toFixed(9)}`,
      `cost=${cost}`
    ].join('  ')
  })
  const titles = Object.entries(read.titles).map(([id, title]) => `${id}: ${title || '(none)'}`)
  return [...rows, '', 'titles:', ...titles].join('\n')
}

describe("usage records read from every agent's own files, on this Mac and from a machine", () => {
  let got: { listed: UsageFile[]; read: UsageRead }

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-usage-records-')))
    got = await readUsage(seed())
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it("lists each agent's usage files, in the order they are read", async () => {
    await expect(listedText(got.listed) + '\n').toMatchFileSnapshot(path.join(GOLDEN, 'listed.txt'))
  })

  it('reads them into records per session, day and model, placed and priced', async () => {
    await expect(rowsText(got.read) + '\n').toMatchFileSnapshot(path.join(GOLDEN, 'rows.txt'))
  })
})
