import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { HISTORY_STORES, watchHistory, type HistoryStore } from '../../src/main/historyWatch'

const SETTLE_MS = 50
const QUIET_WINDOW_MS = 600

const dirs: string[] = []
const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function write(dir: string, rel: string, text = '{}\n'): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.appendFileSync(path.join(dir, rel), text)
}

// PLATFORM§28
async function watching(
  store: HistoryStore,
  warmUp: (n: number) => string
): Promise<{ dir: string; lists: () => number; listed: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-history-'))
  dirs.push(dir)
  let count = 0
  closers.push(watchHistory({ ...store, settleMs: SETTLE_MS }, dir, () => void count++))
  let n = 0
  await vi.waitFor(
    () => {
      write(dir, warmUp(n++))
      expect(count).toBeGreaterThan(0)
    },
    { timeout: 5000, interval: 200 }
  )
  await new Promise((r) => setTimeout(r, QUIET_WINDOW_MS))
  let seen = count
  return {
    dir,
    lists: () => count - seen,
    listed: async () => {
      await vi.waitFor(() => expect(count).toBeGreaterThan(seen), { timeout: 3000 })
      await new Promise((r) => setTimeout(r, QUIET_WINDOW_MS))
      seen = count
    }
  }
}

const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, QUIET_WINDOW_MS))

describe('the session list of an agent Koloft does not run asks it again when its own store gains or loses a session', () => {
  it('Codex: a rollout written in a new day folder is listed once, its later turns are not, and deleting it lists again', async () => {
    const w = await watching(HISTORY_STORES.codex, (n) => `warm-${n}.jsonl`)
    const rollout = path.join('2026', '10', '27', 'rollout-2026-10-27T07-15-39-abc.jsonl')
    write(w.dir, rollout)
    await w.listed()
    for (let i = 0; i < 5; i++) write(w.dir, rollout, `turn ${i}\n`)
    await quiet()
    expect(w.lists()).toBe(0)
    fs.unlinkSync(path.join(w.dir, rollout))
    await w.listed()
  })

  it("Muse: a new session's session.jsonl is listed, its bookkeeping files and subagents are not, and removing its folder lists again", async () => {
    const w = await watching(HISTORY_STORES.muse, (n) =>
      path.join('2026', '10', '26', `warm-${n}`, 'session.jsonl')
    )
    const folder = path.join('2026', '10', '27', '01a17db8-7cda-7722-8212-7f60790ea9c8')
    write(w.dir, path.join(folder, '.session.lock'))
    write(w.dir, path.join(folder, 'cron.db'))
    write(w.dir, path.join(folder, 'cli-c22072e2.log'))
    write(w.dir, path.join(folder, 'subagent', 'child', 'session.jsonl'))
    write(w.dir, path.join('.msp-view-g6', '01a17db8', 'HEAD.json'))
    write(w.dir, '.msp-maintenance-owner.lock')
    await quiet()
    expect(w.lists()).toBe(0)
    write(w.dir, path.join(folder, 'session.jsonl'))
    await w.listed()
    fs.rmSync(path.join(w.dir, folder), { recursive: true })
    await w.listed()
  })

  it("Antigravity: a new conversation's .db is listed, its sqlite side files are not, and deleting it lists again", async () => {
    const w = await watching(HISTORY_STORES.agy, (n) => `warm-${n}.db`)
    write(w.dir, 'c1.db-wal')
    write(w.dir, 'c1.db-shm')
    await quiet()
    expect(w.lists()).toBe(0)
    write(w.dir, 'c1.db')
    await w.listed()
    fs.unlinkSync(path.join(w.dir, 'c1.db'))
    await w.listed()
  })

  it('a store folder two levels short of existing, as for someone who never ran the agent, is listed when the agent makes it and watched from then on', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-history-'))
    dirs.push(root)
    const dir = path.join(root, 'muse', 'sessions')
    let count = 0
    closers.push(
      watchHistory({ ...HISTORY_STORES.muse, settleMs: SETTLE_MS }, dir, () => void count++)
    )
    await quiet()
    fs.mkdirSync(dir, { recursive: true })
    await vi.waitFor(() => expect(count).toBe(1), { timeout: 3000 })
    await quiet()
    write(dir, path.join('2026', '10', '27', 'id1', 'session.jsonl'))
    await vi.waitFor(() => expect(count).toBe(2), { timeout: 3000 })
  })
})
