import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { processTables, type ProcessTable, type ProcessTables } from '../../src/main/processTable'

const ROW = ' 4242     1  4242 S    01:00 0:00.10 Sat Oct 17 01:29:13 2026     /bin/sleep 30\n'
const LIVENESS_ROUND_MS = 2500
const CODEX_ROUND_MS = 5000
const ONE_MINUTE_MS = 60_000
const HOLD_30_S = 'setTimeout(()=>{},30000)'
const PS_ON_A_BUSY_MAC_MS = 15_000

afterEach(() => {
  vi.useRealTimers()
})

function countingTables(): { tables: ProcessTables; runs: () => number } {
  let runs = 0
  return {
    tables: processTables(async () => {
      runs++
      return ROW
    }),
    runs: () => runs
  }
}

describe('one process table shared by every reader', () => {
  it('a 2.5 s round and a 5 s round together start one ps per 2.5 s, and the 2.5 s round never reads the same table twice in a row', async () => {
    vi.useFakeTimers()
    const { tables, runs } = countingTables()
    const seenByLiveness: ProcessTable[] = []
    setInterval(async () => {
      const table = await tables.eachRound(LIVENESS_ROUND_MS)
      if (table) seenByLiveness.push(table)
    }, LIVENESS_ROUND_MS)
    await vi.advanceTimersByTimeAsync(1700)
    setInterval(() => void tables.eachRound(CODEX_ROUND_MS), CODEX_ROUND_MS)
    await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS - 1700)
    expect(runs()).toBe(ONE_MINUTE_MS / LIVENESS_ROUND_MS)
    for (let i = 1; i < seenByLiveness.length; i++)
      expect(seenByLiveness[i]).not.toBe(seenByLiveness[i - 1])
  })

  it('a 5 s round alone starts one ps per 5 s', async () => {
    vi.useFakeTimers()
    const { tables, runs } = countingTables()
    setInterval(() => void tables.eachRound(CODEX_ROUND_MS), CODEX_ROUND_MS)
    await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS)
    expect(runs()).toBe(ONE_MINUTE_MS / CODEX_ROUND_MS)
  })

  it('a reader that needs a fresh table never gets one from a ps that began before it asked, and readers who asked meanwhile share the next ps', async () => {
    const { tables, runs } = countingTables()
    const [running, next, alsoNext] = await Promise.all([
      tables.fresh(),
      tables.fresh(),
      tables.fresh()
    ])
    expect(next).not.toBe(running)
    expect(alsoNext).toBe(next)
    expect(runs()).toBe(2)
  })
})

// PLATFORM§3
describe('the real ps, read in the user’s own locale', () => {
  const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG }

  afterEach(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  })

  it(
    'reads every row when LC_ALL names a locale whose dates ps prints its own way, and keeps the command’s own characters',
    async () => {
      process.env.LC_ALL = 'zh_CN.UTF-8'
      process.env.LANG = 'zh_CN.UTF-8'
      const child = spawn(process.execPath, ['-e', HOLD_30_S, '目录'], { stdio: 'ignore' })
      try {
        await new Promise((r) => child.once('spawn', r))
        const table = await processTables().fresh()
        const row = table?.byPid.get(child.pid!)
        expect(row?.command).toBe(`${process.execPath} -e ${HOLD_30_S} 目录`)
        expect(row?.ppid).toBe(process.pid)
        expect(table!.byPid.get(process.pid)).toBeDefined()
      } finally {
        child.kill()
      }
    },
    PS_ON_A_BUSY_MAC_MS
  )
})
