import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startToolShim, type ToolShim } from '../../src/main/toolShim'
import { writeWholeBeforeVisible } from '../../src/main/jsonDrops'

const SWEEPS_BEFORE_GIVING_UP_MS = 3000
const ANOTHER_SWEEP_HAS_RUN_MS = 1500
const SETUP_UNDER_LOAD_MS = 5000

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
  it(
    'a koloft request the folder watch never reports is still answered, and only once though it stays in the folder, so a Codex, Muse or Antigravity tab never waits out its time on a lost event',
    async () => {
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
      await vi.waitFor(
        () => expect(agent).toHaveBeenCalledWith(requestDir, 'req-1.json', request),
        {
          timeout: SWEEPS_BEFORE_GIVING_UP_MS
        }
      )
      await new Promise((r) => setTimeout(r, ANOTHER_SWEEP_HAS_RUN_MS))
      expect(agent).toHaveBeenCalledTimes(1)
    },
    SWEEPS_BEFORE_GIVING_UP_MS + ANOTHER_SWEEP_HAS_RUN_MS + SETUP_UNDER_LOAD_MS
  )

  // PLATFORM§28
  it(
    'pages a koloft open asked for are still opened when the folder watch never reports them, each once and in the order they were asked for',
    async () => {
      folderWatchThatNeverReports()
      const open = vi.fn()
      started = startToolShim(
        {
          openShimRoot: path.join(base, 'open'),
          playwrightBin: path.join(base, 'playwright'),
          ghWrapper: path.join(base, 'gh')
        },
        { backend: 'codex', open }
      )
      const { requestDir } = started.shim
      const urls = ['https://one.test/', 'https://two.test/', 'https://three.test/']
      urls.forEach((url, n) =>
        writeWholeBeforeVisible(
          path.join(requestDir, `open-${2 - n}.json`),
          JSON.stringify({ url })
        )
      )
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(urls.length), {
        timeout: SWEEPS_BEFORE_GIVING_UP_MS
      })
      await new Promise((r) => setTimeout(r, ANOTHER_SWEEP_HAS_RUN_MS))
      expect(open.mock.calls.map(([target]) => target)).toEqual(urls)
    },
    SWEEPS_BEFORE_GIVING_UP_MS + ANOTHER_SWEEP_HAS_RUN_MS + SETUP_UNDER_LOAD_MS
  )
})
