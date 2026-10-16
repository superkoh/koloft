import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UsageCache, type ScannedFile, type UsageFile } from '../../src/main/usageCache'
import type { UsageRecord } from '../../src/main/usageScan'

function record(sessionId: string, outTok: number): UsageRecord {
  return {
    sessionId,
    day: '2026-10-15',
    model: 'claude-opus-5-5',
    inTok: 1,
    outTok,
    cacheWriteTok: 0,
    cacheReadTok: 0
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

function cache(): UsageCache {
  return new UsageCache({
    cacheFile: () => path.join(dir, 'usage-cache.json'),
    listFiles: async () => listed,
    stat: async (file) => stats.get(file),
    scan: (files, scanned, ended) => void runs.push({ files, scanned, ended }),
    codexWorkspaces: (cwds) => cwds,
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
})
