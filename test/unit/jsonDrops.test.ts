import { describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { oncePerName, watchAndSweepJsonDrops } from '../../src/main/jsonDrops'

const DROP_LONG_SETTLED_BEFORE_THE_WATCH_MS = 1500

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
