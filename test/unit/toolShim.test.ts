import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startToolShim, type ToolShim } from '../../src/main/toolShim'

const SWEEPS_BEFORE_GIVING_UP_MS = 3000
const ANOTHER_SWEEP_HAS_RUN_MS = 1500

let base: string
let started: ToolShim | undefined

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-toolshim-')))
})

afterEach(() => {
  started?.release()
  started = undefined
  vi.restoreAllMocks()
  fs.rmSync(base, { recursive: true, force: true })
})

function folderWatchThatNeverReports(): void {
  vi.spyOn(fs, 'watch').mockImplementation(
    () =>
      Object.assign(new EventEmitter(), {
        close(this: EventEmitter) {
          this.emit('close')
        }
      }) as unknown as fs.FSWatcher
  )
}

describe('startToolShim', () => {
  // PLATFORM§28
  it('a koloft request the folder watch never reports is still answered, and only once though it stays in the folder, so a Codex, Muse or Antigravity tab never waits out its time on a lost event', async () => {
    folderWatchThatNeverReports()
    const agent = vi.fn()
    started = startToolShim(
      {
        openShimRoot: path.join(base, 'open'),
        playwrightBin: path.join(base, 'playwright'),
        ghWrapper: path.join(base, 'gh')
      },
      { backend: 'codex', open: () => {}, agent }
    )
    const { requestDir } = started.shim
    const request = { argv: ['session', 'send', 'parent', 'all done'], cwd: base }
    fs.writeFileSync(path.join(requestDir, 'req-1.json'), JSON.stringify(request))
    await vi.waitFor(() => expect(agent).toHaveBeenCalledWith(requestDir, 'req-1.json', request), {
      timeout: SWEEPS_BEFORE_GIVING_UP_MS
    })
    await new Promise((r) => setTimeout(r, ANOTHER_SWEEP_HAS_RUN_MS))
    expect(agent).toHaveBeenCalledTimes(1)
  })
})
