import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UsageCache, type ScannedFile, type UsageFile } from '../../src/main/usageCache'
import type { UsageRead, UsageRecord } from '../../src/shared/types'

function record(sessionId: string, outTok: number): UsageRecord {
  return {
    sessionId,
    day: '2026-10-15',
    model: 'claude-opus-5-5',
    inTok: 1,
    outTok,
    cacheWriteTok: 0,
    cacheWrite1hTok: 0,
    cacheReadTok: 0,
    surchargeUsd: 0
  }
}

interface Run {
  files: UsageFile[]
  scanned: (file: ScannedFile) => void
  ended: () => void
}

let dir: string
let listed: UsageFile[]
let stats: Map<string, { mtimeMs: number; size: number }>
let runs: Run[]
let changes: number
let places: Map<string, { workspace: string; title: string }>

function cache(): UsageCache {
  return new UsageCache({
    cacheFile: () => path.join(dir, 'usage-cache.json'),
    listFiles: async () => listed,
    stat: async (file) => stats.get(file),
    scan: (files, scanned, ended) => void runs.push({ files, scanned, ended }),
    codexWorkspaces: (cwds) => cwds,
    sessionPlaces: () => (_backend, id) => places.get(id),
    changed: () => void changes++
  })
}

function finish(run: Run, recordsByFile: Record<string, UsageRecord[]>): void {
  for (const [file, records] of Object.entries(recordsByFile)) run.scanned({ file, records })
  run.ended()
}

const A = '/p/ws/a.jsonl'
const B = '/p/ws/b.jsonl'

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cache-'))
  listed = [
    { file: A, backend: 'claude', workspace: '/ws' },
    { file: B, backend: 'claude', workspace: '/ws' }
  ]
  stats = new Map([
    [A, { mtimeMs: 1, size: 10 }],
    [B, { mtimeMs: 1, size: 20 }]
  ])
  runs = []
  changes = 0
  places = new Map()
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('UsageCache', () => {
  it('does not read a file again while its mtime and size stay the same, even after a restart', async () => {
    const first = cache()
    await first.read()
    finish(runs[0], { [A]: [record('a', 5)], [B]: [record('b', 7)] })

    const again = await cache().read()

    expect(runs).toHaveLength(1)
    expect(again.reading).toBe(false)
    expect(again.rows.map((r) => r.outTok).sort()).toEqual([5, 7])
  })

  it('reads a changed file again and replaces its old records', async () => {
    const usage = cache()
    await usage.read()
    finish(runs[0], { [A]: [record('a', 5)], [B]: [record('b', 7)] })
    stats.set(A, { mtimeMs: 2, size: 30 })

    await usage.read()
    expect(runs[1].files.map((f) => f.file)).toEqual([A])
    finish(runs[1], { [A]: [record('a', 50)] })

    const { rows } = await usage.read()
    expect(rows.map((r) => r.outTok).sort()).toEqual([50, 7])
  })

  it('drops the records of a file that is gone', async () => {
    const usage = cache()
    await usage.read()
    finish(runs[0], { [A]: [record('a', 5)], [B]: [record('b', 7)] })
    listed = listed.filter((f) => f.file !== B)

    const { rows } = await usage.read()

    expect(runs).toHaveLength(1)
    expect(rows.map((r) => r.sessionId)).toEqual(['a'])
    expect((await cache().read()).rows.map((r) => r.sessionId)).toEqual(['a'])
  })

  it('answers a read during a run with what is cached and reading, and starts no second run', async () => {
    const usage = cache()
    expect((await usage.read()).reading).toBe(true)
    runs[0].scanned({ file: A, records: [record('a', 5)] })

    const during = await usage.read()

    expect(runs).toHaveLength(1)
    expect(during).toMatchObject({ reading: true, rows: [{ sessionId: 'a' }] })
    finish(runs[0], { [B]: [] })
    expect(changes).toBe(1)
    expect((await usage.read()).reading).toBe(false)
  })

  it('tells the page a read ended, with what it found, even when no file needed reading', async () => {
    const pushed: UsageRead[] = []
    const usage = new UsageCache({
      cacheFile: () => path.join(dir, 'usage-cache.json'),
      listFiles: async () => [],
      stat: async () => undefined,
      scan: () => {},
      codexWorkspaces: (cwds) => cwds,
      sessionPlaces: () => () => undefined,
      changed: (read) => void pushed.push(read)
    })

    await usage.read()

    expect(pushed).toEqual([{ rows: [], titles: {}, reading: false }])
  })

  it('reads again after a listing that failed, instead of staying "reading" for good', async () => {
    let fail = true
    const usage = new UsageCache({
      cacheFile: () => path.join(dir, 'usage-cache.json'),
      listFiles: async () => {
        if (fail) throw new Error('no home')
        return []
      },
      stat: async () => undefined,
      scan: () => {},
      codexWorkspaces: (cwds) => cwds,
      sessionPlaces: () => () => undefined,
      changed: () => {}
    })
    await expect(usage.read()).rejects.toThrow('no home')
    fail = false

    expect((await usage.read()).reading).toBe(false)
  })

  it('puts a Muse or Antigravity file under the workspace and title of the session row with its id', async () => {
    const M = '/home/.local/share/muse/sessions/2026/10/15/m1/session.jsonl'
    listed = [{ file: M, backend: 'muse', workspace: '', sessionId: 'm1' }]
    stats = new Map([[M, { mtimeMs: 1, size: 10 }]])
    places.set('m1', { workspace: '/ws-muse', title: 'Sort the fixtures' })
    const usage = cache()
    await usage.read()
    finish(runs[0], { [M]: [record('m1', 5)] })

    const read = await usage.read()

    expect(read.rows).toMatchObject([{ sessionId: 'm1', backend: 'muse', workspace: '/ws-muse' }])
    expect(read.titles).toEqual({ m1: 'Sort the fixtures' })
  })

  it("names a remote Codex rollout's machine path as an ssh workspace before mapping it", async () => {
    const R = '/ud/remote/box/codex-home/sessions/rollout-1.jsonl'
    listed = [{ file: R, backend: 'codex', workspace: '', host: 'box' }]
    stats = new Map([[R, { mtimeMs: 1, size: 10 }]])
    const usage = cache()
    await usage.read()
    runs[0].scanned({ file: R, records: [record('t1', 5)], cwd: '/home/me/site' })
    runs[0].ended()

    const { rows } = await usage.read()

    expect(rows.map((r) => r.workspace)).toEqual(['ssh://box/home/me/site'])
  })
})
