import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  watchFile,
  unwatchFile,
  closeAllFileWatchers,
  watchDir,
  unwatchDir,
  closeAllDirWatchers
} from '../../src/main/fileWatch'

let dir: string
let file: string
let calls: string[]

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-fw-')))
  file = path.join(dir, 'watched.txt')
  fs.writeFileSync(file, 'one\n')
  calls = []
})
afterEach(() => {
  closeAllFileWatchers()
  fs.rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(50)
  }
  return cond()
}
const settlePastTheWatchersBaselinePoll = (): Promise<void> => sleep(700)

describe('fileWatch (preview auto-refresh watcher)', () => {
  it('fires onChange with the path when the file content changes', async () => {
    watchFile(file, (p) => calls.push(p))
    await settlePastTheWatchersBaselinePoll()
    fs.appendFileSync(file, 'two\n')
    expect(await until(() => calls.length > 0)).toBe(true)
    expect(calls[0]).toBe(file)
  })

  it('survives an atomic rename-replace (write temp + rename over the path)', async () => {
    watchFile(file, (p) => calls.push(p))
    await settlePastTheWatchersBaselinePoll()
    const tmp = path.join(dir, 'tmp-replace')
    fs.writeFileSync(tmp, 'replaced content\n')
    fs.renameSync(tmp, file)
    expect(await until(() => calls.length > 0)).toBe(true)
    calls = []
    await settlePastTheWatchersBaselinePoll()
    fs.appendFileSync(file, 'more\n')
    expect(await until(() => calls.length > 0)).toBe(true)
  })

  it('fires on deletion and again on recreation', async () => {
    watchFile(file, (p) => calls.push(p))
    await settlePastTheWatchersBaselinePoll()
    fs.rmSync(file)
    expect(await until(() => calls.length >= 1)).toBe(true)
    const afterDelete = calls.length
    fs.writeFileSync(file, 'back\n')
    expect(await until(() => calls.length > afterDelete)).toBe(true)
  })

  it('is ref-counted: one unwatch of two keeps it alive, the final unwatch stops it', async () => {
    watchFile(file, (p) => calls.push(p))
    watchFile(file, (p) => calls.push(p))
    unwatchFile(file)
    await settlePastTheWatchersBaselinePoll()
    fs.appendFileSync(file, 'two\n')
    expect(await until(() => calls.length > 0)).toBe(true)

    unwatchFile(file)
    const before = calls.length
    await settlePastTheWatchersBaselinePoll()
    fs.appendFileSync(file, 'three\n')
    await sleep(1500)
    expect(calls.length).toBe(before)
  })

  it('hands the callback the fresh stats, so the editor gets a fingerprint with the news', async () => {
    const seen: Array<{ mtimeMs: number; size: number }> = []
    watchFile(file, (p, curr) => {
      calls.push(p)
      seen.push({ mtimeMs: curr.mtimeMs, size: curr.size })
    })
    await settlePastTheWatchersBaselinePoll()
    fs.writeFileSync(file, 'one\ntwo\n')
    expect(await until(() => calls.length > 0)).toBe(true)
    const st = fs.statSync(file)
    expect(seen[0]).toEqual({ mtimeMs: st.mtimeMs, size: st.size })
  })

  it('unwatchFile removes only its own listener, so another fs.watchFile listener on the same path (the sessionTracker’s) keeps firing', async () => {
    let siblingFired = 0
    const sibling = (): void => {
      siblingFired++
    }
    fs.watchFile(file, { interval: 500 }, sibling)
    try {
      watchFile(file, (p) => calls.push(p))
      unwatchFile(file)
      await settlePastTheWatchersBaselinePoll()
      fs.appendFileSync(file, 'two\n')
      expect(await until(() => siblingFired > 0)).toBe(true)
    } finally {
      fs.unwatchFile(file, sibling)
    }
  })

  it('unwatch of an unknown path is a no-op', () => {
    expect(() => unwatchFile(path.join(dir, 'never-watched'))).not.toThrow()
  })

  it('closeAllFileWatchers stops every watch', async () => {
    const other = path.join(dir, 'other.txt')
    fs.writeFileSync(other, 'x\n')
    watchFile(file, (p) => calls.push(p))
    watchFile(other, (p) => calls.push(p))
    closeAllFileWatchers()
    await settlePastTheWatchersBaselinePoll()
    fs.appendFileSync(file, 'two\n')
    fs.appendFileSync(other, 'y\n')
    await sleep(1500)
    expect(calls.length).toBe(0)
  })
})

describe('watchDir (recursive dir watcher)', () => {
  afterEach(() => {
    closeAllDirWatchers()
    vi.restoreAllMocks()
  })

  it('answers true when the recursive watch starts', () => {
    expect(watchDir(dir, () => {})).toBe(true)
  })

  it('answers false when fs.watch throws, and a later call on the same root tries again', () => {
    const spy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
    })
    expect(watchDir(dir, () => {})).toBe(false)
    expect(watchDir(dir, () => {})).toBe(false)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('never reports a change under .git, or git status rewriting .git/index would set off a refresh loop about every 300 ms', async () => {
    const gitDir = path.join(dir, '.git')
    fs.mkdirSync(gitDir)
    fs.writeFileSync(path.join(gitDir, 'index'), 'a')
    const roots: string[] = []
    expect(watchDir(dir, (r) => roots.push(r))).toBe(true)
    await sleep(700)
    roots.length = 0

    fs.writeFileSync(path.join(gitDir, 'index'), 'b')
    fs.writeFileSync(path.join(gitDir, 'index.lock'), 'c')
    await sleep(1000)
    expect(roots).toEqual([])

    fs.appendFileSync(file, 'two\n')
    expect(await until(() => roots.length > 0)).toBe(true)
  })

  it('after an FSWatcher error rebuilds the watcher in place with its ref count kept, and keeps reporting changes', async () => {
    const realWatch = fs.watch
    const watchers: fs.FSWatcher[] = []
    const spy = vi.spyOn(fs, 'watch').mockImplementation(((
      ...args: Parameters<typeof fs.watch>
    ) => {
      const w = realWatch.apply(fs, args)
      watchers.push(w)
      return w
    }) as typeof fs.watch)
    const roots: string[] = []
    expect(watchDir(dir, (r) => roots.push(r))).toBe(true)
    expect(watchDir(dir, (r) => roots.push(r))).toBe(true)

    watchers[0].emit('error', new Error('FSEvents stream died'))
    expect(spy).toHaveBeenCalledTimes(2)
    unwatchDir(dir)

    await sleep(700)
    roots.length = 0
    fs.appendFileSync(file, 'two\n')
    expect(await until(() => roots.length > 0)).toBe(true)
  })
})
