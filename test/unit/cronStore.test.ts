import { describe, expect, it } from 'vitest'
import type { CronJob, HistoryLine, Schedule } from '../../src/shared/types'
import {
  cronFilePath,
  loadCron,
  sanitizeCron,
  saveCron,
  type CronStoreFs
} from '../../src/main/cronStore'

const WS = '/pinned/ws-a'
const PINNED = [WS]
const DAILY: Schedule = { kind: 'daily', at: '21:00' }

function job(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'j1',
    workspacePath: WS,
    name: 'Nightly report',
    task: '/daily-report',
    schedule: DAILY,
    permission: 'same',
    enabled: true,
    createdAt: 1,
    history: [],
    ...over
  }
}

function file(jobs: unknown[], version: unknown = 1): unknown {
  return { version, jobs }
}

function one(over: Record<string, unknown>, pinned = PINNED): CronJob | null {
  return sanitizeCron(file([job(over)]), pinned).jobs[0] ?? null
}

describe('sanitizeCron (BB-E29: the whole file)', () => {
  it('answers nothing at all for a version it does not know, and never throws', () => {
    expect(sanitizeCron(file([job()], 2), PINNED)).toEqual({ jobs: [], notes: {} })
  })

  it('answers nothing for something that is not an object, or has no jobs array', () => {
    expect(sanitizeCron('not a file', PINNED)).toEqual({ jobs: [], notes: {} })
    expect(sanitizeCron({ version: 1, jobs: 'nope' }, PINNED)).toEqual({ jobs: [], notes: {} })
  })
})

describe('sanitizeCron (BB-E29: which jobs are dropped)', () => {
  it('drops a job with no usable id', () => {
    expect(one({ id: '' })).toBeNull()
    expect(one({ id: 7 })).toBeNull()
  })

  it('keeps only the first of two jobs that share an id', () => {
    const out = sanitizeCron(
      { version: 1, jobs: [job({ name: 'First' }), job({ name: 'Second' })] },
      PINNED
    )
    expect(out.jobs.map((j) => j.name)).toEqual(['First'])
  })

  it('drops a job whose workspace path is relative', () => {
    expect(one({ workspacePath: 'ws-a' }, ['ws-a'])).toBeNull()
  })

  it('drops a job whose workspace is absolute but not pinned', () => {
    expect(one({ workspacePath: '/somewhere/else' })).toBeNull()
  })

  it('keeps a job whose pinned folder is missing on disk', () => {
    const missing = '/pinned/gone-for-now'
    expect(one({ workspacePath: missing }, [missing])?.workspacePath).toBe(missing)
  })

  it('keeps every job when the pinned list is empty, which more likely means the layout failed to load', () => {
    expect(sanitizeCron(file([job()]), []).jobs).toHaveLength(1)
  })

  it('drops a job whose name starts with a dash', () => {
    expect(one({ name: '-force' })).toBeNull()
  })

  it('drops a job whose name is empty, too long, or has no letters or digits', () => {
    expect(one({ name: '   ' })).toBeNull()
    expect(one({ name: 'a'.repeat(81) })).toBeNull()
    expect(one({ name: '!!!' })).toBeNull()
  })

  it('drops a job whose task is empty, too long, or starts with a dash', () => {
    expect(one({ task: '  ' })).toBeNull()
    expect(one({ task: 'x'.repeat(4097) })).toBeNull()
    expect(one({ task: '--dangerously-skip-permissions' })).toBeNull()
  })

  it('drops a job whose schedule is not one Koloft knows', () => {
    expect(one({ schedule: { kind: 'daily', at: '9:00' } })).toBeNull()
    expect(one({ schedule: { kind: 'every', n: 0, unit: 'minutes' } })).toBeNull()
  })

  it('drops a job whose enabled is not a yes-or-no', () => {
    expect(one({ enabled: 'true' })).toBeNull()
  })
})

describe('sanitizeCron (BB-E29: what is repaired instead of dropped)', () => {
  it('turns a permission it does not know into "same"', () => {
    expect(one({ permission: 'yes' })?.permission).toBe('same')
  })

  it('keeps a permission it does know', () => {
    expect(one({ permission: 'skipAll' })?.permission).toBe('skipAll')
  })

  it('trims the name and takes control characters out of it', () => {
    expect(one({ name: ' Nightly ' })?.name).toBe('Nightly')
  })

  it('takes the NUL out of the task and trims it', () => {
    expect(one({ task: ' /x\u0000y ' })?.task).toBe('/xy')
  })

  it('drops a model that would not survive the launch line, and says so on the card', () => {
    for (const model of ['sonnet; rm -rf ~', '', 42]) {
      const out = sanitizeCron(file([job({ model })]), PINNED)
      expect(out.jobs[0].model, String(model)).toBeUndefined()
      expect(out.notes, String(model)).toEqual({
        j1: 'The saved model was not valid and was ignored.'
      })
    }
  })

  it('keeps a model that is a plain token, with no note', () => {
    const out = sanitizeCron(file([job({ model: 'sonnet' })]), PINNED)
    expect(out.jobs[0].model).toBe('sonnet')
    expect(out.notes).toEqual({})
  })

  it('keeps a thinking effort claude knows and quietly drops one it does not', () => {
    expect(sanitizeCron(file([job({ effort: 'xhigh' })]), PINNED).jobs[0].effort).toBe('xhigh')
    const out = sanitizeCron(file([job({ effort: 'ultra' })]), PINNED)
    expect(out.jobs[0].effort).toBeUndefined()
    expect(out.notes).toEqual({})
  })
})

describe('sanitizeCron (BB-E29: the history lines)', () => {
  it('answers an empty history when what is on disk is not a list', () => {
    expect(one({ history: { dueAt: 1 } })?.history).toEqual([])
  })

  const raw: unknown[] = []
  for (let i = 1; i <= 25; i++) {
    const line: Record<string, unknown> = { dueAt: i * 60_000, state: 'closed' }
    if (i === 24) delete line.state
    if (i === 25) line.worktree = '../evil'
    if (i === 23) line.worktree = 'nightly-260902-2100'
    raw.push(line)
  }
  raw.reverse()
  raw.push(raw.shift() as unknown)
  const history = one({ history: raw })?.history as HistoryLine[]

  it('keeps only the newest 20', () => {
    expect(history).toHaveLength(20)
  })

  it('puts the newest first', () => {
    expect(history.map((h) => h.dueAt)).toEqual(
      [25, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5].map(
        (i) => i * 60_000
      )
    )
  })

  it('drops a line that says nothing about how the run ended', () => {
    expect(history.some((h) => h.dueAt === 24 * 60_000)).toBe(false)
  })

  it('takes a bad folder name off its line but keeps the line', () => {
    expect(history[0]).toEqual({ dueAt: 25 * 60_000, state: 'closed' })
  })

  it('keeps a folder name that is fine', () => {
    expect(history[1].worktree).toBe('nightly-260902-2100')
  })

  it('keeps count and until on a folding line only, and a note on a failed line only', () => {
    const lines = one({
      history: [
        { dueAt: 6, state: 'missed', count: 85, until: 9 },
        { dueAt: 5, state: 'skipped', count: 3, until: 9 },
        { dueAt: 4, state: 'skipped', count: 0, until: 9 },
        { dueAt: 3, state: 'closed', count: 2, until: 9, note: 'made up' },
        { dueAt: 2, state: 'failed', note: 'no usable account' },
        { dueAt: 1, state: 'missed', manual: 'yes' }
      ]
    })?.history as HistoryLine[]
    expect(lines[0]).toEqual({ dueAt: 6, state: 'missed', count: 85, until: 9 })
    expect(lines[1]).toEqual({ dueAt: 5, state: 'skipped', count: 3, until: 9 })
    expect(lines[2]).toEqual({ dueAt: 4, state: 'skipped', count: 1 })
    expect(lines[3]).toEqual({ dueAt: 3, state: 'closed' })
    expect(lines[4]).toEqual({ dueAt: 2, state: 'failed', note: 'no usable account' })
    expect(lines[5]).toEqual({ dueAt: 1, state: 'missed' })
  })
})

describe('loadCron / saveCron (BB-E29: reading and writing the file)', () => {
  function fakeFs(
    seed: Record<string, string> = {}
  ): CronStoreFs & { disk: Record<string, string> } {
    const disk = { ...seed }
    return {
      disk,
      readFile: (p) => {
        if (!(p in disk)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return disk[p]
      },
      writeFile: (p, s) => {
        disk[p] = s
      },
      rename: (a, b) => {
        disk[b] = disk[a]
        delete disk[a]
      }
    }
  }

  it('names the file next to the other user data', () => {
    expect(cronFilePath('/u/data')).toBe('/u/data/cron.json')
  })

  it('answers nothing, and touches nothing, when there is no file to read', () => {
    const fs = fakeFs()
    expect(loadCron(fs, '/u/data/cron.json', PINNED)).toEqual({ jobs: [], notes: {} })
    expect(fs.disk).toEqual({})
  })

  it('copies a file it cannot make sense of aside before answering with nothing', () => {
    const broken = fakeFs({ '/f.json': '{ half a fi' })
    expect(loadCron(broken, '/f.json', PINNED)).toEqual({ jobs: [], notes: {} })
    const copies = Object.keys(broken.disk).filter((p) => p.startsWith('/f.json.broken-'))
    expect(copies).toHaveLength(1)
    expect(broken.disk[copies[0]]).toBe('{ half a fi')

    const text = JSON.stringify(file([job()], 2))
    const wrongVersion = fakeFs({ '/f.json': text })
    expect(loadCron(wrongVersion, '/f.json', PINNED)).toEqual({ jobs: [], notes: {} })
    const kept = Object.keys(wrongVersion.disk).filter((p) => p.startsWith('/f.json.broken-'))
    expect(kept).toHaveLength(1)
    expect(wrongVersion.disk[kept[0]]).toBe(text)
  })

  it('moves a file it cannot read at all aside, and leaves nothing to overwrite', () => {
    const fs = fakeFs({ '/f.json': JSON.stringify(file([job()])) })
    const kept = fs.disk['/f.json']
    fs.readFile = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    }
    expect(loadCron(fs, '/f.json', PINNED)).toEqual({ jobs: [], notes: {} })
    expect(fs.disk['/f.json']).toBeUndefined()
    const aside = Object.keys(fs.disk).filter((p) => p.startsWith('/f.json.broken-'))
    expect(aside).toHaveLength(1)
    expect(fs.disk[aside[0]]).toBe(kept)
  })

  it('does not throw when even that move fails', () => {
    const fs = fakeFs({ '/f.json': 'whatever' })
    fs.readFile = () => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' })
    }
    fs.rename = () => {
      throw new Error('EPERM')
    }
    expect(loadCron(fs, '/f.json', PINNED)).toEqual({ jobs: [], notes: {} })
    expect(fs.disk['/f.json']).toBe('whatever')
  })

  it('reads back what saveCron wrote', () => {
    const fs = fakeFs()
    const saved = one({}) as CronJob
    saveCron(fs, '/f.json', [saved])
    expect(loadCron(fs, '/f.json', PINNED).jobs).toEqual([saved])
  })

  it('writes a tmp file first and then renames it over the real one', () => {
    const fs = fakeFs()
    const saved = one({}) as CronJob
    saveCron(fs, '/f.json', [saved])
    expect(fs.disk['/f.json']).toBe(JSON.stringify({ version: 1, jobs: [saved] }, null, 2))
    expect(fs.disk['/f.json.tmp']).toBeUndefined()
  })

  it('leaves the old file alone, and does not throw, when the rename fails', () => {
    const before = JSON.stringify({ version: 1, jobs: [] }, null, 2)
    const fs = fakeFs({ '/f.json': before })
    fs.rename = () => {
      throw new Error('EPERM')
    }
    expect(() => saveCron(fs, '/f.json', [one({}) as CronJob])).not.toThrow()
    expect(fs.disk['/f.json']).toBe(before)
  })
})
