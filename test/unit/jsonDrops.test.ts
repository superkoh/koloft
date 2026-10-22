import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  oncePerName,
  watchAndSweepJsonDrops,
  watchJsonDrops,
  writeWholeBeforeVisible
} from '../../src/main/jsonDrops'

const DROP_LONG_SETTLED_BEFORE_THE_WATCH_MS = 1500
const DROPS_WRITTEN_BACK_TO_BACK = 12

describe("watchJsonDrops 'as-written': drops reach their handler in the order they were written", () => {
  it('hands drops written back to back over in write order, as an agent opening two pages in one command expects its tabs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-drops-'))
    const seen: number[] = []
    let watchLive = false
    const watcher = watchJsonDrops(
      dir,
      (name) =>
        name.startsWith('until-seen-')
          ? (): void => void (watchLive = true)
          : (obj): void => void seen.push((obj as { n: number }).n),
      'as-written'
    )
    try {
      // PLATFORM§28
      await vi.waitFor(
        () => {
          writeWholeBeforeVisible(path.join(dir, `until-seen-${Date.now()}.json`), '{}')
          expect(watchLive).toBe(true)
        },
        { timeout: 5000, interval: 100 }
      )
      const written = [...Array(DROPS_WRITTEN_BACK_TO_BACK).keys()]
      for (const n of written) {
        writeWholeBeforeVisible(path.join(dir, `drop-${n}.json`), JSON.stringify({ n }))
      }
      await vi.waitFor(() => expect(seen).toHaveLength(written.length), { timeout: 5000 })
      expect(seen).toEqual(written)
    } finally {
      watcher?.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('watchAndSweepJsonDrops with oncePerName: a drop is handled once even when the folder watch never reports it', () => {
  // PLATFORM§28
  it('hands a drop written before the watch went live to its handler exactly once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-drops-'))
    fs.writeFileSync(path.join(dir, 'req-a.json'), JSON.stringify({ tabId: 'pty-x-1' }))
    fs.writeFileSync(path.join(dir, 'res-a.json'), JSON.stringify({ account: 'other' }))
    await new Promise((r) => setTimeout(r, DROP_LONG_SETTLED_BEFORE_THE_WATCH_MS))
    const seen: unknown[] = []
    const watcher = watchAndSweepJsonDrops(
      dir,
      oncePerName((name) => (name.startsWith('req-') ? (obj): void => void seen.push(obj) : null))
    )
    try {
      await vi.waitFor(() => expect(seen).toEqual([{ tabId: 'pty-x-1' }]), { timeout: 5000 })
      fs.writeFileSync(path.join(dir, 'req-a.json'), JSON.stringify({ tabId: 'pty-x-1' }))
      await new Promise((r) => setTimeout(r, DROP_LONG_SETTLED_BEFORE_THE_WATCH_MS))
      expect(seen).toEqual([{ tabId: 'pty-x-1' }])
    } finally {
      watcher?.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
