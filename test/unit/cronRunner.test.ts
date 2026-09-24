import { describe, expect, it, vi } from 'vitest'
import {
  CronRunner,
  worktreeNameFor,
  type LaunchRequest,
  type LaunchResult,
  type RunnerDeps
} from '../../src/main/cronRunner'
import { sanitizeCron } from '../../src/main/cronStore'
import { slugOf } from '../../src/shared/cronNames'
import { isValidWorktreeName } from '../../src/shared/worktreeName'
import type { CronJob, CronSaveInput, CronState } from '../../src/shared/types'

const T0 = new Date(2026, 8, 2, 10, 0, 0, 0).getTime()
const SEC = 1000
const MIN = 60 * SEC

function at(h: number, m: number, s = 0, dayOffset = 0): number {
  return new Date(2026, 8, 2 + dayOffset, h, m, s, 0).getTime()
}

function makeJob(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'j1',
    workspacePath: '/ws/a',
    name: 'Nightly report',
    task: '/koloft.release-dmg patch',
    schedule: { kind: 'daily', at: '10:00' },
    permission: 'same',
    enabled: true,
    createdAt: T0 - 24 * 60 * MIN,
    history: [],
    ...over
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function makeHarness(
  jobs: CronJob[],
  over: Partial<RunnerDeps> = {},
  notes: Record<string, string> = {}
): {
  runner: CronRunner
  deps: RunnerDeps
  jobs: CronJob[]
  flags: {
    ready: boolean
    dir: boolean
    git: boolean
    account: boolean
    pinned: boolean
    folders: number
  }
  toasts: string[]
  launches: LaunchRequest[]
  states: CronState[]
  killedTabs: string[]
  launch: ReturnType<typeof vi.fn>
  killTab: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  branchExists: ReturnType<typeof vi.fn>
  setClock: (t: number) => void
  tick: (t?: number) => Promise<void>
  fireTimers: (t: number) => Promise<void>
} {
  let clock = T0
  let nextId = 1
  const timeouts = new Map<number, { at: number; cb: () => void }>()
  const intervals = new Map<number, { cb: () => void }>()
  const flags = { ready: true, dir: true, git: true, account: true, pinned: true, folders: 0 }
  const toasts: string[] = []
  const launches: LaunchRequest[] = []
  const states: CronState[] = []
  const killedTabs: string[] = []

  const launch = vi.fn((req: LaunchRequest): LaunchResult => {
    launches.push(req)
    return { ok: true, tabId: `tab-${launches.length}` }
  })
  const killTab = vi.fn()
  const notify = vi.fn()
  const save = vi.fn()
  const branchExists = vi.fn(async () => false)

  const deps: RunnerDeps = {
    now: () => clock,
    bootTime: T0,
    store: { load: () => ({ jobs, notes }), save },
    dirExists: () => flags.dir,
    isPinned: () => flags.pinned,
    gitDirExists: () => flags.git,
    worktreeDirExists: () => false,
    branchExists,
    countRunFolders: () => flags.folders,
    accountUsable: () => flags.account,
    trusted: () => true,
    ready: () => flags.ready,
    launch,
    killTab,
    toast: (t: string) => {
      toasts.push(t)
    },
    notify,
    push: (s: CronState) => {
      states.push(s)
    },
    killed: (id: string) => {
      killedTabs.push(id)
    },
    bindDeadlineMs: 90 * SEC,
    setInterval: ((cb: () => void) => {
      const id = nextId++
      intervals.set(id, { cb })
      return id
    }) as unknown as typeof setInterval,
    clearInterval: ((id: number) => {
      intervals.delete(id)
    }) as unknown as typeof clearInterval,
    setTimeout: ((cb: () => void, ms: number) => {
      const id = nextId++
      timeouts.set(id, { at: clock + ms, cb })
      return id
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => {
      timeouts.delete(id)
    }) as unknown as typeof clearTimeout,
    ...over
  }

  const runner = new CronRunner(deps)
  return {
    runner,
    deps,
    jobs,
    flags,
    toasts,
    launches,
    states,
    killedTabs,
    launch,
    killTab,
    notify,
    save,
    branchExists,
    setClock: (t: number) => {
      clock = t
    },
    async tick(t?: number): Promise<void> {
      if (t !== undefined) clock = t
      for (const i of [...intervals.values()]) i.cb()
      await flush()
    },
    async fireTimers(t: number): Promise<void> {
      clock = t
      for (const [id, timer] of [...timeouts.entries()]) {
        if (timer.at <= clock) {
          timeouts.delete(id)
          timer.cb()
        }
      }
      await flush()
    }
  }
}

describe('worktreeNameFor (BB-E03: two runs never share a folder)', () => {
  const DUE = at(21, 0)
  const BASE = 'nightly-report-260902-2100'

  it('takes the plain name when nothing holds it', async () => {
    const taken = vi.fn(async () => false)
    expect(await worktreeNameFor(makeJob(), DUE, taken)).toBe(BASE)
  })

  it('steps to -2 when the folder was removed by hand but its branch survives', async () => {
    const taken = vi.fn(async (n: string) => n === BASE)
    expect(await worktreeNameFor(makeJob(), DUE, taken)).toBe(`${BASE}-2`)
  })

  it('falls back to four random hex characters once -2 … -99 are all taken', async () => {
    const taken = vi.fn(async (n: string) => n === BASE || /-\d{1,2}$/.test(n))
    const name = await worktreeNameFor(makeJob(), DUE, taken)
    expect(name).toMatch(new RegExp(`^${BASE}-[0-9a-f]{4}$`))
    expect(isValidWorktreeName(name)).toBe(true)
  })

  it('cuts a very long job name down to a name git will take', async () => {
    const name = 'Nightly release build for the whole team and everyone else, every night!!'
    expect(name.length).toBeGreaterThan(64)
    const taken = vi.fn(async () => false)
    const out = await worktreeNameFor(makeJob({ name }), DUE, taken)
    expect(slugOf(name)).toHaveLength(48)
    expect(out).toBe(`${slugOf(name)}-260902-2100`)
    expect(out).toHaveLength(60)
    expect(isValidWorktreeName(out)).toBe(true)
  })

  it('keeps the hex fallback inside the 64-character limit by cutting the slug, never the date stamp', async () => {
    const name = 'Nightly release build for the whole team and everyone else, every night!!'
    const base = `${slugOf(name)}-260902-2100`
    const taken = vi.fn(async (n: string) => n === base || /-\d{1,2}$/.test(n))
    const out = await worktreeNameFor(makeJob({ name }), DUE, taken)
    expect(out).toHaveLength(64)
    expect(out).toMatch(/-260902-2100-[0-9a-f]{4}$/)
    expect(isValidWorktreeName(out)).toBe(true)
  })
})

describe('CronRunner — starting one run', () => {
  it('launches a due job with its task as the first prompt and its name as the session name', async () => {
    const h = makeHarness([makeJob()])
    h.runner.start()
    await h.tick(at(10, 0, 20))
    expect(h.launches).toEqual([
      {
        jobId: 'j1',
        cwd: '/ws/a',
        worktree: 'nightly-report-260902-1000',
        model: undefined,
        permission: 'default',
        firstPrompt: '/koloft.release-dmg patch',
        name: 'Nightly report'
      }
    ])
    expect(h.toasts).toEqual(['⏰ Nightly report started'])
    expect(h.runner.state().live).toEqual([
      {
        jobId: 'j1',
        tabId: 'tab-1',
        worktree: 'nightly-report-260902-1000',
        state: 'launching',
        startedAt: at(10, 0, 20),
        dueAt: T0
      }
    ])
  })

  it('BB-E22: a folder whose .git is not a directory runs in place, with no worktree', async () => {
    const h = makeHarness([makeJob()])
    h.flags.git = false
    await h.runner.runNow('j1')
    expect(h.launches).toHaveLength(1)
    expect(h.launches[0].worktree).toBeUndefined()
    expect(h.launches[0].cwd).toBe('/ws/a')
    expect(h.branchExists).not.toHaveBeenCalled()
  })

  it("the tick's own window check fires a due exactly five minutes old, and misses the next millisecond", async () => {
    for (const [age, launched] of [
      [5 * MIN, true],
      [5 * MIN + 1, false]
    ] as Array<[number, boolean]>) {
      const h = makeHarness([makeJob()])
      h.runner.start()
      await h.tick(T0 + age)
      expect(h.launch.mock.calls.length, String(age)).toBe(launched ? 1 : 0)
      expect(h.jobs[0].history, String(age)).toEqual(
        launched ? [] : [{ dueAt: T0, state: 'missed' }]
      )
    }
  })

  it('runs a switched-off job when the person presses Run now', async () => {
    const h = makeHarness([makeJob({ enabled: false })])
    expect(await h.runner.runNow('j1')).toEqual({ ok: true })
    expect(h.launch).toHaveBeenCalledTimes(1)
  })

  it('answers unknown-job for an id that is not there', async () => {
    const h = makeHarness([makeJob()])
    expect(await h.runner.runNow('nope')).toEqual({ ok: false, reason: 'unknown-job' })
    expect(h.launch).not.toHaveBeenCalled()
  })
})

describe('CronRunner — reasons a run does not start', () => {
  it('writes "the folder is missing" and never launches', async () => {
    const h = makeHarness([makeJob()])
    h.flags.dir = false
    expect(await h.runner.runNow('j1')).toEqual({ ok: false, reason: 'folder-missing' })
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.jobs[0].history).toEqual([
      { dueAt: T0, state: 'failed', note: 'the folder is missing', manual: true }
    ])
    expect(h.toasts).toEqual(['⏰ Nightly report could not start: the folder is missing'])
    expect(h.save).toHaveBeenCalled()
  })

  it('writes "no usable account" and never launches', async () => {
    const h = makeHarness([makeJob()])
    h.flags.account = false
    expect(await h.runner.runNow('j1')).toEqual({ ok: false, reason: 'no-account' })
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.jobs[0].history[0]).toEqual({
      dueAt: T0,
      state: 'failed',
      note: 'no usable account',
      manual: true
    })
    expect(h.toasts).toEqual(['⏰ Nightly report could not start: no usable account'])
  })

  it('writes "Claude exited before it started" as failed, never skipped, when the launch itself is refused', async () => {
    const h = makeHarness([makeJob()], { launch: vi.fn(() => ({ ok: false }) as LaunchResult) })
    expect(await h.runner.runNow('j1')).toEqual({ ok: false, reason: 'failed' })
    expect(h.jobs[0].history[0]).toEqual({
      dueAt: T0,
      state: 'failed',
      note: 'Claude exited before it started',
      manual: true
    })
    expect(h.toasts).toEqual(['⏰ Nightly report could not start: Claude exited before it started'])
    expect(h.runner.state().live).toEqual([])
  })
})

describe('CronRunner — BB-E01 overlap: a run that is still open', () => {
  it('skips the second due and folds the third into the same line, answering every button press', async () => {
    const h = makeHarness([makeJob()])
    await h.runner.runNow('j1')
    h.setClock(T0 + 1 * MIN)
    expect(await h.runner.runNow('j1')).toEqual({ ok: false, reason: 'skipped' })
    expect(h.jobs[0].history).toEqual([
      { dueAt: T0 + 1 * MIN, state: 'skipped', count: 1, manual: true }
    ])
    expect(h.toasts).toEqual([
      '⏰ Nightly report started',
      '⏰ Nightly report skipped: the last run is still open'
    ])

    h.setClock(T0 + 2 * MIN)
    await h.runner.runNow('j1')
    expect(h.jobs[0].history).toEqual([
      { dueAt: T0 + 1 * MIN, state: 'skipped', count: 2, until: T0 + 2 * MIN, manual: true }
    ])
    expect(h.toasts).toHaveLength(3)
    expect(h.toasts[2]).toBe('⏰ Nightly report skipped: the last run is still open')
    expect(h.launch).toHaveBeenCalledTimes(1)
  })

  it('starts a new skip row for a new run, even when the last run left its skips on top', async () => {
    const written = [
      { dueAt: at(10, 0), state: 'closed' },
      { dueAt: at(10, 10), state: 'skipped', count: 2, until: at(10, 20) }
    ]
    const reloaded = sanitizeCron(
      { version: 1, jobs: [makeJob({ history: written as CronJob['history'] })] },
      ['/ws/a']
    ).jobs[0]
    expect(reloaded.history[0].state).toBe('skipped')

    const h = makeHarness([reloaded])
    h.setClock(at(11, 0))
    await h.runner.runNow('j1')
    h.setClock(at(11, 10))
    await h.runner.runNow('j1')
    expect(reloaded.history).toEqual([
      { dueAt: at(11, 10), state: 'skipped', count: 1, manual: true },
      { dueAt: at(10, 10), state: 'skipped', count: 2, until: at(10, 20) },
      { dueAt: at(10, 0), state: 'closed' }
    ])
  })

  it('says nothing when the CLOCK folds a skip nobody asked for', async () => {
    const jobs = [makeJob({ schedule: { kind: 'every', n: 10, unit: 'minutes' } })]
    const h = makeHarness(jobs, { bootTime: at(9, 59) })
    h.setClock(at(9, 59))
    h.runner.start()
    await h.tick(at(10, 0, 20))
    expect(h.launch).toHaveBeenCalledTimes(1)

    await h.tick(at(10, 10, 20))
    await h.tick(at(10, 20, 20))
    expect(jobs[0].history).toEqual([
      { dueAt: at(10, 10), state: 'skipped', count: 2, until: at(10, 20) }
    ])
    expect(h.toasts).toEqual([
      '⏰ Nightly report started',
      '⏰ Nightly report skipped: the last run is still open'
    ])
  })
})

describe('CronRunner — BB-E24: two fires in one launch start one run', () => {
  it('drops the second arrival silently, and skips only once the run is really there', async () => {
    let settle: (r: LaunchResult) => void = () => {}
    const calls: LaunchRequest[] = []
    const launch = vi.fn((req: LaunchRequest) => {
      calls.push(req)
      return new Promise<LaunchResult>((r) => {
        settle = r
      })
    })
    const h = makeHarness([makeJob()], { launch })
    h.runner.start()
    await h.tick(at(10, 0, 20))
    expect(launch).toHaveBeenCalledTimes(1)

    h.setClock(at(10, 0, 25))
    await h.runner.runNow('j1')
    expect(launch).toHaveBeenCalledTimes(1)
    expect(h.jobs[0].history).toEqual([])
    expect(h.toasts).toEqual([])

    settle({ ok: true, tabId: 'tab-1' })
    await flush()
    expect(h.toasts).toEqual(['⏰ Nightly report started'])

    h.setClock(at(10, 0, 40))
    await h.runner.runNow('j1')
    expect(launch).toHaveBeenCalledTimes(1)
    expect(h.jobs[0].history).toEqual([
      { dueAt: at(10, 0, 40), state: 'skipped', count: 1, manual: true }
    ])
    expect(h.toasts).toEqual([
      '⏰ Nightly report started',
      '⏰ Nightly report skipped: the last run is still open'
    ])
  })
})

describe('CronRunner — BB-E11: a due that arrives with no window', () => {
  it('holds it and launches it once the window comes back inside five minutes', async () => {
    const h = makeHarness([makeJob()])
    h.flags.ready = false
    h.runner.start()
    await h.tick(at(10, 0, 20))
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.jobs[0].history).toEqual([])

    h.flags.ready = true
    h.setClock(at(10, 0, 50))
    h.runner.onRendererReady()
    await flush()
    expect(h.launch).toHaveBeenCalledTimes(1)
    expect(h.runner.state().live[0].dueAt).toBe(T0)

    h.runner.onRendererReady()
    await flush()
    expect(h.launch).toHaveBeenCalledTimes(1)
  })

  it('marks it missed when the window comes back too late', async () => {
    const h = makeHarness([makeJob()])
    h.flags.ready = false
    h.runner.start()
    await h.tick(at(10, 0, 20))

    h.flags.ready = true
    h.setClock(at(10, 6, 0))
    h.runner.onRendererReady()
    await flush()
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.jobs[0].history).toEqual([{ dueAt: T0, state: 'missed' }])
  })

  it('keeps every due it held, starts only the newest, and misses the rest in one row', async () => {
    const jobs = [makeJob({ schedule: { kind: 'every', n: 1, unit: 'hours' } })]
    const h = makeHarness(jobs, { bootTime: at(9, 59) })
    h.setClock(at(9, 59))
    h.flags.ready = false
    h.runner.start()
    await h.tick(at(10, 0, 20))
    await h.tick(at(11, 0, 20))
    await h.tick(at(12, 0, 20))

    h.flags.ready = true
    h.setClock(at(12, 2, 0))
    h.runner.onRendererReady()
    await flush()
    expect(h.launch).toHaveBeenCalledTimes(1)
    expect(jobs[0].history).toEqual([
      { dueAt: at(10, 0), state: 'missed', count: 2, until: at(11, 0) }
    ])
  })

  it("the held-due window check, separate from the tick's, launches at exactly five minutes old and misses the next millisecond", async () => {
    for (const [age, launched] of [
      [5 * MIN, true],
      [5 * MIN + 1, false]
    ] as Array<[number, boolean]>) {
      const h = makeHarness([makeJob()])
      h.flags.ready = false
      h.runner.start()
      await h.tick(at(10, 0, 20))

      h.flags.ready = true
      h.setClock(T0 + age)
      h.runner.onRendererReady()
      await flush()
      expect(h.launch.mock.calls.length, String(age)).toBe(launched ? 1 : 0)
      expect(h.jobs[0].history, String(age)).toEqual(
        launched ? [] : [{ dueAt: T0, state: 'missed' }]
      )
    }
  })

  it('throws the held due away when the job is saved again, so a just-switched-off job never starts', async () => {
    const h = makeHarness([makeJob()])
    h.flags.ready = false
    h.runner.start()
    await h.tick(at(10, 0, 20))

    h.setClock(at(10, 0, 30))
    h.runner.save({
      id: 'j1',
      workspacePath: '/ws/a',
      name: 'Nightly report',
      task: '/koloft.release-dmg patch',
      schedule: { kind: 'daily', at: '10:00' },
      permission: 'same',
      enabled: false
    })

    h.flags.ready = true
    h.setClock(at(10, 0, 50))
    h.runner.onRendererReady()
    await flush()
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.jobs[0].history).toEqual([])
  })

  it('answers not-ready to Run now, writes nothing, and never holds the press for later', async () => {
    const h = makeHarness([makeJob()])
    h.flags.ready = false
    expect(await h.runner.runNow('j1')).toEqual({ ok: false, reason: 'not-ready' })
    expect(h.launch).not.toHaveBeenCalled()
    expect(h.jobs[0].history).toEqual([])
    expect(h.toasts).toEqual([])
    h.flags.ready = true
    h.runner.onRendererReady()
    await flush()
    expect(h.launch).not.toHaveBeenCalled()
  })
})

describe('CronRunner — BB-E26: the first tick after the Mac wakes waits 30 seconds', () => {
  it('ignores ticks for half a minute, then fires the fresh due and misses the old one', async () => {
    const jobs = [
      makeJob({ id: 'a', name: 'Report A', schedule: { kind: 'daily', at: '09:58' } }),
      makeJob({ id: 'b', name: 'Report B', schedule: { kind: 'daily', at: '09:54' } })
    ]
    const h = makeHarness(jobs, { bootTime: at(20, 0, 0, -1) })
    h.setClock(at(20, 0, 0, -1))
    h.runner.start()

    h.setClock(at(10, 0, 5))
    h.runner.onResume()
    await h.tick(at(10, 0, 20))
    await h.tick(at(10, 0, 34))
    expect(h.launch).not.toHaveBeenCalled()
    expect(jobs[0].history).toEqual([])
    expect(jobs[1].history).toEqual([])

    await h.tick(at(10, 0, 40))
    expect(h.launches).toHaveLength(1)
    expect(h.launches[0].name).toBe('Report A')
    expect(jobs[0].history).toEqual([])
    expect(jobs[1].history).toEqual([{ dueAt: at(9, 54), state: 'missed' }])
  })

  it('folds a whole sleep into one missed row, saved once and pushed once', async () => {
    const jobs = [makeJob({ schedule: { kind: 'every', n: 10, unit: 'minutes' } })]
    const h = makeHarness(jobs, { bootTime: at(20, 0, 0, -1) })
    h.setClock(at(20, 0, 0, -1))
    h.runner.start()
    const pushes = h.states.length

    h.setClock(at(10, 5, 10))
    h.runner.onResume()
    await h.tick(at(10, 6, 0))

    expect(h.launch).not.toHaveBeenCalled()
    expect(jobs[0].history).toEqual([
      { dueAt: at(20, 0, 0, -1), state: 'missed', count: 85, until: at(10, 0) }
    ])
    expect(h.save).toHaveBeenCalledTimes(1)
    expect(h.states.length - pushes).toBe(1)
  })
})

describe('CronRunner — BB-E23: an edit or a switch re-arms from now', () => {
  it('replays nothing after the job is switched off and on again', async () => {
    const jobs = [makeJob({ schedule: { kind: 'every', n: 1, unit: 'minutes' } })]
    const h = makeHarness(jobs)
    h.runner.start()

    h.setClock(at(15, 0, 0))
    h.runner.setEnabled('j1', false)
    h.runner.setEnabled('j1', true)

    await h.tick(at(15, 0, 10))
    expect(h.launch).not.toHaveBeenCalled()
    expect(jobs[0].history).toEqual([])

    await h.tick(at(15, 1, 10))
    expect(h.launch).toHaveBeenCalledTimes(1)
    expect(jobs[0].history).toEqual([])
  })

  it('replays nothing after the schedule is edited', async () => {
    const jobs = [makeJob({ schedule: { kind: 'daily', at: '21:00' } })]
    const h = makeHarness(jobs)
    h.runner.start()

    h.setClock(at(10, 0, 30))
    const res = h.runner.save({
      id: 'j1',
      workspacePath: '/ws/a',
      name: 'Nightly report',
      task: '/koloft.release-dmg patch',
      schedule: { kind: 'every', n: 1, unit: 'minutes' },
      permission: 'same',
      enabled: true
    })
    expect(res.ok).toBe(true)

    await h.tick(at(10, 0, 40))
    expect(h.launch).not.toHaveBeenCalled()

    await h.tick(at(10, 1, 10))
    expect(h.launch).toHaveBeenCalledTimes(1)
    expect(jobs[0].history).toEqual([])
  })
})

describe('CronRunner — a live run growing up', () => {
  async function started(): Promise<ReturnType<typeof makeHarness>> {
    const h = makeHarness([makeJob()])
    await h.runner.runNow('j1')
    return h
  }

  it('binding clears the deadline and turns launching into running', async () => {
    const h = await started()
    h.runner.onBound('tab-1', 'sess-1')
    expect(h.runner.state().live[0]).toMatchObject({ state: 'running', sessionId: 'sess-1' })
    await h.fireTimers(T0 + 5 * MIN)
    expect(h.killTab).not.toHaveBeenCalled()
    expect(h.jobs[0].history).toEqual([])
  })

  it('working → waiting means the turn ended', async () => {
    const h = await started()
    h.runner.onBound('tab-1', 'sess-1')
    h.runner.onStatus('tab-1', 'working', 'waiting')
    expect(h.runner.state().live[0].state).toBe('done')
  })

  it('approval → waiting also means the turn ended', async () => {
    const h = await started()
    h.runner.onBound('tab-1', 'sess-1')
    h.runner.onStatus('tab-1', 'approval', 'waiting')
    expect(h.runner.state().live[0].state).toBe('done')
  })

  it('waiting → waiting changes nothing', async () => {
    const h = await started()
    h.runner.onBound('tab-1', 'sess-1')
    const before = h.states.length
    h.runner.onStatus('tab-1', 'waiting', 'waiting')
    expect(h.runner.state().live[0].state).toBe('running')
    expect(h.states).toHaveLength(before)
  })

  it('cannot finish a run that has not started yet, even when a status edge beats SessionStart', async () => {
    const h = makeHarness([makeJob()], { bindDeadlineMs: 5 * SEC })
    await h.runner.runNow('j1')
    h.runner.onStatus('tab-1', 'working', 'waiting')
    expect(h.runner.state().live[0].state).toBe('launching')
    await h.fireTimers(T0 + 5 * SEC)
    expect(h.killTab).toHaveBeenCalledTimes(1)
    expect(h.jobs[0].history[0]).toMatchObject({ state: 'failed', note: 'Claude did not start' })
  })

  it('a new turn after done goes back to running', async () => {
    const h = await started()
    h.runner.onBound('tab-1', 'sess-1')
    h.runner.onStatus('tab-1', 'working', 'waiting')
    h.runner.onStatus('tab-1', 'waiting', 'working')
    expect(h.runner.state().live[0].state).toBe('running')
  })

  it('a pty exit after the run was working is closed, with its folder written down', async () => {
    const h = await started()
    h.runner.onBound('tab-1', 'sess-1')
    h.runner.onStatus('tab-1', 'working', 'waiting')
    h.runner.onPtyExit('tab-1')
    expect(h.jobs[0].history).toEqual([
      {
        dueAt: T0,
        state: 'closed',
        worktree: 'nightly-report-260902-1000',
        manual: true
      }
    ])
    expect(h.runner.state().live).toEqual([])
  })

  it('a pty exit before it ever bound reads "Claude exited before it started"', async () => {
    const h = await started()
    h.runner.onPtyExit('tab-1')
    expect(h.jobs[0].history[0]).toMatchObject({
      state: 'failed',
      note: 'Claude exited before it started'
    })
    expect(h.toasts).toEqual([
      '⏰ Nightly report started',
      '⏰ Nightly report could not start: Claude exited before it started'
    ])
    await h.runner.runNow('j1')
    expect(h.launch).toHaveBeenCalledTimes(2)
  })

  it('ignores events for a tab it does not own', async () => {
    const h = await started()
    const before = h.states.length
    h.runner.onBound('other', 's')
    h.runner.onStatus('other', 'working', 'waiting')
    h.runner.onPtyExit('other')
    expect(h.states).toHaveLength(before)
    expect(h.jobs[0].history).toEqual([])
  })
})

describe('CronRunner — BB-N02: the runner never writes into a session', () => {
  it('has no write path, kills only the run that never started, and says so once', async () => {
    const h = makeHarness([makeJob()], { bindDeadlineMs: 5 * SEC })
    expect(Object.keys(h.deps).filter((k) => /write/i.test(k))).toEqual([])

    await h.runner.runNow('j1')
    h.runner.onBound('tab-1', 's1')
    h.runner.onStatus('tab-1', 'idle', 'working')
    h.runner.onStatus('tab-1', 'working', 'waiting')
    h.runner.onPtyExit('tab-1')

    h.setClock(T0 + 1 * MIN)
    await h.runner.runNow('j1')
    h.runner.onBound('tab-2', 's2')
    h.runner.onStatus('tab-2', 'working', 'approval')
    h.runner.onPtyExit('tab-2')

    h.setClock(T0 + 2 * MIN)
    await h.runner.runNow('j1')
    await h.fireTimers(T0 + 2 * MIN + 5 * SEC)

    expect(h.killTab.mock.calls).toEqual([['tab-3']])
    expect(h.killedTabs).toEqual(['tab-3'])
    expect(h.notify.mock.calls).toEqual([
      ['Nightly report', 'Could not start — Claude did not start']
    ])
    expect(h.jobs[0].history[0]).toMatchObject({
      state: 'failed',
      note: 'Claude did not start'
    })
    expect(h.toasts.at(-1)).toBe('⏰ Nightly report could not start: Claude did not start')
    expect(h.runner.state().live).toEqual([])
  })

  // CC§9
  it('names the untrusted folder in the deadline row, and only there', async () => {
    const h = makeHarness([makeJob()], { bindDeadlineMs: 5 * SEC, trusted: () => false })
    await h.runner.runNow('j1')
    await h.fireTimers(T0 + 5 * SEC)

    expect(h.jobs[0].history[0]).toMatchObject({
      state: 'failed',
      note: 'Claude did not start — this folder was never opened in Claude; start one session here first'
    })
    expect(h.toasts.at(-1)).toBe('⏰ Nightly report could not start: Claude did not start')
    expect(h.notify.mock.calls.at(-1)).toEqual([
      'Nightly report',
      'Could not start — Claude did not start'
    ])
  })
})

describe('CronRunner — quitting', () => {
  it('ends every open run, empties the live list, and lets the pty exits fall silent', async () => {
    const h = makeHarness([makeJob()])
    await h.runner.runNow('j1')
    h.runner.onBound('tab-1', 's1')

    h.runner.quitSweep()
    expect(h.jobs[0].history).toEqual([
      {
        dueAt: T0,
        state: 'ended',
        worktree: 'nightly-report-260902-1000',
        manual: true
      }
    ])
    expect(h.runner.state().live).toEqual([])

    h.runner.onPtyExit('tab-1')
    expect(h.jobs[0].history).toHaveLength(1)
  })

  it('disarms the deadline of a run it just ended, so shutdown kills no tab and writes no second line', async () => {
    const h = makeHarness([makeJob()], { bindDeadlineMs: 5 * SEC })
    await h.runner.runNow('j1')
    h.runner.quitSweep()
    await h.fireTimers(T0 + 1 * MIN)
    expect(h.killTab).not.toHaveBeenCalled()
    expect(h.jobs[0].history).toHaveLength(1)
    expect(h.jobs[0].history[0].state).toBe('ended')
  })

  it('stops the tick and the deadline timers', async () => {
    const h = makeHarness([makeJob()], { bindDeadlineMs: 5 * SEC })
    h.runner.start()
    await h.runner.runNow('j1')
    h.runner.stop()
    await h.tick(at(10, 5, 0))
    await h.fireTimers(at(10, 5, 0))
    expect(h.killTab).not.toHaveBeenCalled()
    expect(h.launch).toHaveBeenCalledTimes(1)
  })
})

describe('CronRunner — the history stays short', () => {
  it('keeps the newest twenty lines and drops the rest', async () => {
    const h = makeHarness([makeJob()])
    h.flags.dir = false
    for (let i = 0; i < 25; i++) {
      h.setClock(T0 + i * MIN)
      await h.runner.runNow('j1')
    }
    expect(h.jobs[0].history).toHaveLength(20)
    expect(h.jobs[0].history[0].dueAt).toBe(T0 + 24 * MIN)
    expect(h.jobs[0].history[19].dueAt).toBe(T0 + 5 * MIN)
  })
})

describe('CronRunner.save — the same rules the form uses', () => {
  const BASE: CronSaveInput = {
    workspacePath: '/ws/a',
    name: 'Nightly report',
    task: '/koloft.release-dmg patch',
    schedule: { kind: 'daily', at: '21:00' },
    permission: 'same',
    enabled: true
  }

  const bad: Array<[string, Partial<CronSaveInput>, string]> = [
    ['an empty name', { name: '   ' }, 'Give the job a name.'],
    [
      'a name starting with a dash, which claude would read as a flag',
      { name: '-force' },
      'The name cannot start with a dash.'
    ],
    ['a name that is only dashes', { name: '-!!!' }, 'The name cannot start with a dash.'],
    [
      'a name with no letter or digit',
      { name: '!!!' },
      'Use at least one letter or digit in the name.'
    ],
    ['a name over 80 characters', { name: 'x'.repeat(81) }, 'Keep the name under 80 characters.'],
    ['an empty task', { task: '  ' }, 'Say what to run.'],
    ['a task starting with a dash', { task: '-rf /' }, 'The text cannot start with a dash.'],
    [
      'a task over 4096 characters',
      { task: 'x'.repeat(4097) },
      'Keep the text under 4096 characters.'
    ],
    [
      'a workspace path that is not absolute',
      { workspacePath: 'ws-a' },
      'The workspace path is not valid.'
    ],
    [
      'no days picked',
      { schedule: { kind: 'weekly', days: [], at: '09:00' } },
      'Pick at least one day.'
    ],
    [
      'a time that is not HH:MM',
      { schedule: { kind: 'daily', at: '9:00' } },
      'Use a time like 09:00.'
    ],
    [
      'a repeat out of range',
      { schedule: { kind: 'every', n: 900, unit: 'minutes' } },
      'Use a whole number from 1 to 720 minutes or 1 to 24 hours.'
    ],
    [
      'a model with a space in it',
      { model: 'gpt 4' },
      'Use letters, digits, dots, colons, dashes or underscores.'
    ]
  ]

  for (const [what, over, message] of bad) {
    it(`refuses ${what} in plain words`, () => {
      const h = makeHarness([])
      expect(h.runner.save({ ...BASE, ...over })).toEqual({ ok: false, errors: [message] })
      expect(h.save).not.toHaveBeenCalled()
      expect(h.runner.state().jobs).toEqual([])
    })
  }

  it('refuses a workspace path that is not pinned, since the loader would drop it after a restart', () => {
    const h = makeHarness([])
    h.flags.pinned = false
    expect(h.runner.save(BASE)).toEqual({ ok: false, errors: ['The workspace path is not valid.'] })
    expect(h.save).not.toHaveBeenCalled()
  })

  it("writes a job at the loader's own length limits that the loader gives back exactly as it was, history and all", async () => {
    const h = makeHarness([])
    const res = h.runner.save({
      ...BASE,
      name: 'N'.repeat(80),
      task: '/x'.padEnd(4096, 'y'),
      schedule: { kind: 'weekly', days: [1, 3, 5], at: '21:00' },
      model: 'opus',
      permission: 'skipAll'
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    h.flags.dir = false
    await h.runner.runNow(res.job.id)
    const saved = h.runner.state().jobs

    const onDisk = JSON.parse(JSON.stringify({ version: 1, jobs: saved }))
    const back = sanitizeCron(onDisk, ['/ws/a'])
    expect(back.jobs).toEqual(saved)
    expect(back.notes).toEqual({})
  })

  it('gives a new job an id, a birthday and an empty history', () => {
    const h = makeHarness([])
    const res = h.runner.save(BASE)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.job.id).toMatch(/[0-9a-f-]{36}/)
    expect(res.job.createdAt).toBe(T0)
    expect(res.job.history).toEqual([])
    expect(h.save).toHaveBeenCalledTimes(1)
  })

  it('keeps the history and the birthday when an existing job is edited', () => {
    const old = makeJob({ history: [{ dueAt: T0 - MIN, state: 'closed' }] })
    const h = makeHarness([old])
    const res = h.runner.save({ ...BASE, id: 'j1', name: 'Morning report', model: 'opus' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.job.name).toBe('Morning report')
    expect(res.job.model).toBe('opus')
    expect(res.job.createdAt).toBe(old.createdAt)
    expect(res.job.history).toEqual([{ dueAt: T0 - MIN, state: 'closed' }])
    expect(h.runner.state().jobs).toHaveLength(1)
  })

  it('drops a model that was there before when the edit leaves it out', () => {
    const h = makeHarness([makeJob({ model: 'opus' })])
    const res = h.runner.save({ ...BASE, id: 'j1' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect('model' in res.job).toBe(false)
  })

  it('keeps a thinking effort on save and drops it when the edit leaves it out', () => {
    const h = makeHarness([])
    const saved = h.runner.save({ ...BASE, id: 'j1', effort: 'high' })
    expect(saved.ok && saved.job.effort).toBe('high')
    const again = h.runner.save({ ...BASE, id: 'j1' })
    expect(again.ok && 'effort' in again.job).toBe(false)
  })

  it('trims the name and the task before it saves them', () => {
    const h = makeHarness([])
    const res = h.runner.save({ ...BASE, name: '  Nightly report \n', task: '  hello  ' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.job.name).toBe('Nightly report')
    expect(res.job.task).toBe('hello')
  })
})

describe('CronRunner — switching off, deleting, and losing a workspace', () => {
  it('switching a job off leaves it in the list but off', () => {
    const h = makeHarness([makeJob()])
    h.runner.setEnabled('j1', false)
    expect(h.runner.state().jobs[0].enabled).toBe(false)
    expect(h.save).toHaveBeenCalledTimes(1)
  })

  it('deleting a job leaves its open run alone, and throws away its ending', async () => {
    const job = makeJob()
    const h = makeHarness([job])
    await h.runner.runNow('j1')
    h.runner.delete('j1')
    expect(h.runner.state().jobs).toEqual([])
    expect(h.runner.state().live).toHaveLength(1)

    h.runner.onPtyExit('tab-1')
    expect(h.runner.state().live).toEqual([])
    expect(job.history).toEqual([])
  })

  it('does nothing more for a job that was deleted, or whose workspace was removed', async () => {
    const a = makeJob({ id: 'a', name: 'Job A', workspacePath: '/ws/a' })
    const b = makeJob({ id: 'b', name: 'Job B', workspacePath: '/ws/b' })
    const h = makeHarness([a, b])
    h.flags.ready = false
    h.runner.start()
    await h.tick(at(10, 0, 20))

    h.runner.delete('a')
    h.runner.removeWorkspace('/ws/b')

    h.flags.ready = true
    h.setClock(at(10, 0, 50))
    h.runner.onRendererReady()
    await flush()
    await h.tick(at(10, 1, 10))

    expect(h.launch).not.toHaveBeenCalled()
    expect(h.toasts).toEqual([])
    expect(a.history).toEqual([])
    expect(b.history).toEqual([])
  })

  it('never lets the deadline kill a run whose job has gone away', async () => {
    const a = makeJob({ id: 'a', name: 'Job A', workspacePath: '/ws/a' })
    const b = makeJob({ id: 'b', name: 'Job B', workspacePath: '/ws/b' })
    const h = makeHarness([a, b], { bindDeadlineMs: 5 * SEC })
    await h.runner.runNow('a')
    await h.runner.runNow('b')
    h.runner.delete('a')
    h.runner.removeWorkspace('/ws/b')

    await h.fireTimers(T0 + 1 * MIN)
    expect(h.killTab).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.runner.state().live).toHaveLength(2)
  })

  it('removing a workspace drops only that workspace’s jobs', () => {
    const a = makeJob({ id: 'a', workspacePath: '/ws/a' })
    const b = makeJob({ id: 'b', workspacePath: '/ws/b' })
    const h = makeHarness([a, b])
    expect(h.runner.jobCountFor('/ws/a')).toBe(1)
    h.runner.removeWorkspace('/ws/a')
    expect(h.runner.state().jobs.map((j) => j.id)).toEqual(['b'])
    expect(h.runner.jobCountFor('/ws/a')).toBe(0)
    expect(h.save).toHaveBeenCalledTimes(1)
  })
})

describe('CronRunner — the state it hands the dialog', () => {
  it('counts run folders per job for a git workspace only', async () => {
    const h = makeHarness([makeJob()])
    h.flags.folders = 3
    expect(h.runner.state().folders).toEqual({ j1: 3 })
    h.flags.git = false
    expect(h.runner.state().folders).toEqual({})
  })

  it('counts the folders again after the deadline kills a run', async () => {
    const h = makeHarness([makeJob()], { bindDeadlineMs: 5 * SEC })
    h.flags.folders = 1
    await h.runner.runNow('j1')
    h.flags.folders = 2
    await h.fireTimers(T0 + 5 * SEC)
    expect(h.states.at(-1)?.folders).toEqual({ j1: 2 })
  })

  it('carries the loader’s complaint through to the dialog until the job is saved again', () => {
    const h = makeHarness([makeJob()], {}, { j1: 'The saved model was not valid and was ignored.' })
    expect(h.runner.state().notes).toEqual({
      j1: 'The saved model was not valid and was ignored.'
    })
    h.runner.save({
      id: 'j1',
      workspacePath: '/ws/a',
      name: 'Nightly report',
      task: 'hello',
      schedule: { kind: 'daily', at: '21:00' },
      permission: 'same',
      enabled: true
    })
    expect(h.runner.state().notes).toEqual({})
  })
})
