import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { EventEmitter } from 'events'
import { spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startToolShim, type ToolShim } from '../../src/main/toolShim'
import { writeWholeBeforeVisible } from '../../src/main/jsonDrops'
import { CODEX_TMP_DIR, ownedByThisRun } from '../../src/main/leftovers'

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

function folderWatchThatReportsOnlyWhatItIsTold(): (name: string) => void {
  let report: ((event: string, name: string) => void) | undefined
  vi.spyOn(fs, 'watch').mockImplementation(((_dir: string, listener: typeof report) => {
    report = listener
    return Object.assign(new EventEmitter(), {
      close(this: EventEmitter) {
        this.emit('close')
      }
    }) as unknown as fs.FSWatcher
  }) as unknown as typeof fs.watch)
  return (name) => report?.('rename', name)
}

describe('startToolShim', () => {
  it.each(['codex', 'muse', 'agy'] as const)(
    'a %s tab starting removes both tool folders of each tab a Koloft run that has ended left behind, and keeps a live run’s and a stranger’s',
    (backend) => {
      const openShimRoot = path.join(base, `${backend}-open`)
      const names = {
        ended: `${spawnSync('true').pid}-${randomUUID()}`,
        live: ownedByThisRun(randomUUID()),
        someoneElse: 'other-folder'
      }
      for (const name of Object.values(names))
        fs.mkdirSync(path.join(openShimRoot, name), { recursive: true })
      const requestDirOf = (name: string): string =>
        path.join(CODEX_TMP_DIR, `koloft-cx-open-${name}`)
      for (const name of [names.ended, names.live]) {
        fs.mkdirSync(requestDirOf(name))
        onTestFinished(() => fs.rmSync(requestDirOf(name), { recursive: true, force: true }))
      }
      started = startToolShim(
        {
          openShimRoot,
          playwrightBin: path.join(base, 'playwright'),
          ghWrapper: path.join(base, 'gh')
        },
        { backend, open: () => {} }
      )
      expect(fs.readdirSync(openShimRoot).sort()).toEqual(
        [names.live, names.someoneElse, path.basename(started.shim.shimDir)].sort()
      )
      expect(fs.existsSync(requestDirOf(names.ended))).toBe(false)
      expect(fs.existsSync(requestDirOf(names.live))).toBe(true)
    }
  )

  // PLATFORM§28
  it(
    'a koloft request the folder watch never reports is still answered, and only once though it stays in the folder, so a Codex, Muse or Antigravity tab never waits out its time on a lost event',
    async () => {
      folderWatchThatReportsOnlyWhatItIsTold()
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
  it.each([
    ['never reports any of them', false],
    ['reports only the last of them', true]
  ])(
    'pages a koloft open asked for are opened each once and in the order they were asked for when the folder watch %s',
    async (_watch, reportsTheLast) => {
      const report = folderWatchThatReportsOnlyWhatItIsTold()
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
      const names = urls.map((_url, n) => `open-${urls.length - 1 - n}.json`)
      urls.forEach((url, n) =>
        writeWholeBeforeVisible(path.join(requestDir, names[n]), JSON.stringify({ url }))
      )
      if (reportsTheLast) report(names[names.length - 1])
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(urls.length), {
        timeout: SWEEPS_BEFORE_GIVING_UP_MS
      })
      await new Promise((r) => setTimeout(r, ANOTHER_SWEEP_HAS_RUN_MS))
      expect(open.mock.calls.map(([target]) => target)).toEqual(urls)
    },
    SWEEPS_BEFORE_GIVING_UP_MS + ANOTHER_SWEEP_HAS_RUN_MS + SETUP_UNDER_LOAD_MS
  )
})
