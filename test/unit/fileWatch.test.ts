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
import type { DirChanges } from '../../src/shared/types'

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

  it('answers true when the recursive watch starts', async () => {
    expect(await watchDir(dir, () => {})).toBe(true)
  })

  it('answers false when fs.watch throws, and a later call on the same root tries again', async () => {
    const spy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
    })
    expect(await watchDir(dir, () => {})).toBe(false)
    expect(await watchDir(dir, () => {})).toBe(false)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('never reports a change under .git, or git status rewriting .git/index would set off a refresh loop about every 300 ms', async () => {
    const gitDir = path.join(dir, '.git')
    fs.mkdirSync(gitDir)
    fs.writeFileSync(path.join(gitDir, 'index'), 'a')
    const roots: string[] = []
    expect(await watchDir(dir, (r) => roots.push(r))).toBe(true)
    await sleep(700)
    roots.length = 0

    fs.writeFileSync(path.join(gitDir, 'index'), 'b')
    fs.writeFileSync(path.join(gitDir, 'index.lock'), 'c')
    await sleep(1000)
    expect(roots).toEqual([])

    fs.appendFileSync(file, 'two\n')
    expect(await until(() => roots.length > 0)).toBe(true)
  })

  // AGY§8
  it('never reports Antigravity writing its own logs under .system_generated, which it does at every step, or each step would re-list every open folder', async () => {
    const logs = path.join(dir, '.system_generated', 'logs')
    fs.mkdirSync(logs, { recursive: true })
    const roots: string[] = []
    expect(await watchDir(dir, (r) => roots.push(r))).toBe(true)
    await sleep(700)
    roots.length = 0

    fs.appendFileSync(path.join(logs, 'transcript.jsonl'), '{}\n')
    await sleep(1000)
    expect(roots).toEqual([])

    fs.appendFileSync(file, 'two\n')
    expect(await until(() => roots.length > 0)).toBe(true)
  })

  it('names the folders whose list of names may have changed, so Browse re-lists only those and not every open folder', async () => {
    const sub = path.join(dir, 'a', 'b')
    fs.mkdirSync(sub, { recursive: true })
    const reports: (DirChanges | undefined)[] = []
    expect(await watchDir(dir, (_r, changes) => reports.push(changes))).toBe(true)
    await sleep(700)
    reports.length = 0

    fs.writeFileSync(path.join(sub, 'new.txt'), 'x')
    expect(await until(() => reports.length > 0)).toBe(true)
    expect(reports[0]?.listsChanged).toContain(sub)
    expect(reports[0]?.listsChanged).not.toContain(dir)
  })

  it('names a folder moved into place as a replaced tree, so its open subfolders re-list though no event came from inside it', async () => {
    const staged = path.join(dir, 'out.tmp')
    fs.mkdirSync(path.join(staged, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(staged, 'assets', 'a.js'), 'x')
    const reports: (DirChanges | undefined)[] = []
    expect(await watchDir(dir, (_r, changes) => reports.push(changes))).toBe(true)
    await sleep(700)
    reports.length = 0

    fs.renameSync(staged, path.join(dir, 'out'))
    expect(
      await until(() => reports.some((r) => r?.replacedTrees.includes(path.join(dir, 'out'))))
    ).toBe(true)
  })

  it('names the folder of a changed .gitignore as a replaced tree, since it can hide or show files in every folder under it', async () => {
    const sub = path.join(dir, 'pkg')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, '.gitignore'), 'a\n')
    const reports: (DirChanges | undefined)[] = []
    expect(await watchDir(dir, (_r, changes) => reports.push(changes))).toBe(true)
    await sleep(700)
    reports.length = 0

    fs.appendFileSync(path.join(sub, '.gitignore'), 'b\n')
    expect(await until(() => reports.some((r) => r?.replacedTrees.includes(sub)))).toBe(true)
  })

  it('a folder viewed again after its last viewer left opens no second watcher, and reports its changes again', async () => {
    const spy = vi.spyOn(fs, 'watch')
    const roots: string[] = []
    expect(await watchDir(dir, (r) => roots.push(r))).toBe(true)
    unwatchDir(dir)
    expect(await watchDir(dir, (r) => roots.push(r))).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)

    await sleep(700)
    roots.length = 0
    fs.appendFileSync(file, 'two\n')
    expect(await until(() => roots.length > 0)).toBe(true)
  })

  it('reports nothing about a folder nobody views, though its watcher is kept', async () => {
    const roots: string[] = []
    expect(await watchDir(dir, (r) => roots.push(r))).toBe(true)
    await sleep(700)
    roots.length = 0
    unwatchDir(dir)

    fs.appendFileSync(file, 'two\n')
    await sleep(1000)
    expect(roots).toEqual([])
  })

  it('tells a returning viewer nothing about changes made while nobody viewed the folder, since every viewer reads the folder itself as it starts watching and a report would make it read twice', async () => {
    const reports: (DirChanges | undefined)[] = []
    expect(await watchDir(dir, (_r, changes) => reports.push(changes))).toBe(true)
    await sleep(700)
    unwatchDir(dir)
    reports.length = 0
    fs.appendFileSync(file, 'two\n')
    await sleep(700)

    expect(await watchDir(dir, (_r, changes) => reports.push(changes))).toBe(true)
    await sleep(700)
    expect(reports).toEqual([])

    fs.appendFileSync(file, 'three\n')
    expect(await until(() => reports.length > 0)).toBe(true)
  })

  it('drops a change still waiting to be reported when the last viewer left, rather than reporting it to the next viewer', async () => {
    const reports: (DirChanges | undefined)[] = []
    expect(await watchDir(dir, (_r, changes) => reports.push(changes))).toBe(true)
    await sleep(700)
    reports.length = 0
    fs.appendFileSync(file, 'two\n')
    await sleep(120)
    unwatchDir(dir)
    await sleep(500)

    expect(await watchDir(dir, (_r, changes) => reports.push(changes))).toBe(true)
    await sleep(700)
    expect(reports).toEqual([])

    fs.appendFileSync(file, 'three\n')
    expect(await until(() => reports.length > 0)).toBe(true)
  })

  it('opens a new watcher for a folder deleted and made again while nobody viewed it', async () => {
    const folder = path.join(dir, 'worktree')
    fs.mkdirSync(folder)
    const spy = vi.spyOn(fs, 'watch')
    expect(await watchDir(folder, () => {})).toBe(true)
    unwatchDir(folder)
    fs.rmSync(folder, { recursive: true })
    fs.mkdirSync(path.join(dir, 'takes-the-freed-inode-number'))
    fs.mkdirSync(folder)

    expect(await watchDir(folder, () => {})).toBe(true)
    expect(spy).toHaveBeenCalledTimes(2)
    unwatchDir(folder)
    fs.rmSync(folder, { recursive: true })
    expect(await watchDir(folder, () => {})).toBe(false)
  })

  it('a watch and an unwatch of one folder take effect in the order they were asked, though the watch waits on the disk', async () => {
    const spy = vi.spyOn(fs, 'watch')
    const first = watchDir(dir, () => {})
    unwatchDir(dir)
    const again = watchDir(dir, () => {})
    expect(await first).toBe(true)
    expect(await again).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a watch still waiting on the disk when every watcher is closed opens none', async () => {
    const spy = vi.spyOn(fs, 'watch')
    const pending = watchDir(dir, () => {})
    closeAllDirWatchers()
    expect(await pending).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the watchers of only the 8 folders left most recently, so a ninth closes the one left longest ago', async () => {
    const folders = Array.from({ length: 9 }, (_, i) => {
      const folder = path.join(dir, `ws-${i}`)
      fs.mkdirSync(folder)
      return folder
    })
    const spy = vi.spyOn(fs, 'watch')
    for (const folder of folders) {
      expect(await watchDir(folder, () => {})).toBe(true)
      unwatchDir(folder)
    }
    expect(spy).toHaveBeenCalledTimes(9)

    await watchDir(folders[8], () => {})
    expect(spy).toHaveBeenCalledTimes(9)
    await watchDir(folders[0], () => {})
    expect(spy).toHaveBeenCalledTimes(10)
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
    expect(await watchDir(dir, (r) => roots.push(r))).toBe(true)
    expect(await watchDir(dir, (r) => roots.push(r))).toBe(true)

    watchers[0].emit('error', new Error('FSEvents stream died'))
    expect(spy).toHaveBeenCalledTimes(2)
    unwatchDir(dir)

    await sleep(700)
    roots.length = 0
    fs.appendFileSync(file, 'two\n')
    expect(await until(() => roots.length > 0)).toBe(true)
  })
})
