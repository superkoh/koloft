import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  watchFile,
  unwatchFile,
  closeAllFileWatchers,
  watchDir,
  closeAllDirWatchers
} from '../../src/main/fileWatch'

// Contract (preview auto-refresh): watchFile(p, onChange) fires onChange(p) whenever the
// file at absolute path `p` changes on disk — content writes, deletion, and recreation
// alike (the poll follows the *path*, so an atomic rename-replace keeps being observed).
// Watches are ref-counted per path: only the final unwatch stops the poll.
// closeAllFileWatchers drops everything (renderer hard-reload leak guard).

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
/** poll until cond() or timeout; returns the final cond value */
const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(50)
  }
  return cond()
}
/** let the watcher take its baseline stat before we mutate the file (500ms poll) */
const settle = (): Promise<void> => sleep(700)

describe('fileWatch (preview auto-refresh watcher)', () => {
  it('fires onChange with the path when the file content changes', async () => {
    watchFile(file, (p) => calls.push(p))
    await settle()
    fs.appendFileSync(file, 'two\n')
    expect(await until(() => calls.length > 0)).toBe(true)
    expect(calls[0]).toBe(file)
  })

  it('survives an atomic rename-replace (write temp + rename over the path)', async () => {
    watchFile(file, (p) => calls.push(p))
    await settle()
    const tmp = path.join(dir, 'tmp-replace')
    fs.writeFileSync(tmp, 'replaced content\n')
    fs.renameSync(tmp, file)
    expect(await until(() => calls.length > 0)).toBe(true)
    // and a LATER in-place change on the same path is still observed
    calls = []
    await settle()
    fs.appendFileSync(file, 'more\n')
    expect(await until(() => calls.length > 0)).toBe(true)
  })

  it('fires on deletion and again on recreation', async () => {
    watchFile(file, (p) => calls.push(p))
    await settle()
    fs.rmSync(file)
    expect(await until(() => calls.length >= 1)).toBe(true)
    const afterDelete = calls.length
    fs.writeFileSync(file, 'back\n')
    expect(await until(() => calls.length > afterDelete)).toBe(true)
  })

  it('is ref-counted: one unwatch of two keeps it alive, the final unwatch stops it', async () => {
    watchFile(file, (p) => calls.push(p))
    watchFile(file, (p) => calls.push(p)) // second ref, same path
    unwatchFile(file) // one ref left
    await settle()
    fs.appendFileSync(file, 'two\n')
    expect(await until(() => calls.length > 0)).toBe(true)

    unwatchFile(file) // last ref gone → poll stops
    const before = calls.length
    await settle()
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
    await settle()
    fs.writeFileSync(file, 'one\ntwo\n')
    expect(await until(() => calls.length > 0)).toBe(true)
    const st = fs.statSync(file)
    expect(seen[0]).toEqual({ mtimeMs: st.mtimeMs, size: st.size })
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
    await settle()
    fs.appendFileSync(file, 'two\n')
    fs.appendFileSync(other, 'y\n')
    await sleep(1500)
    expect(calls.length).toBe(0)
  })
})

// Contract (Changes stream live refresh): watchDir(root, onChange) answers whether
// a recursive fs.watch is really running on `root`. A root where fs.watch throws
// (network mount, EMFILE, no recursive support) answers false, so the renderer can fall
// back to activity-driven refresh instead of waiting for events that never come.
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
})
