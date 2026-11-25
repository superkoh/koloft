import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendId, CronJob, HistoryLine } from '@shared/types'
import { localIso } from '@shared/schedule'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import type { SessionBackend } from '../../src/core/agent/sessionBackends'
import type { RunnerDeps } from '../../src/plugins/scheduled-tasks/main/cronRunner'
import { lifecycle, stubBackend } from './helpers/sessionBackendStub'

const EVERY_AGENT: BackendId[] = ['claude', 'codex', 'agy']
const OWNER_OF_UNNAMED_OLD_DATA: BackendId = 'claude'
const ID = '00000000-0000-4000-8000-000000000001'
const A_RUN_AT = new Date(2026, 10, 18, 5, 0).getTime()
const THE_RUN_BEFORE_AT = new Date(2026, 10, 17, 5, 0).getTime()

const keyOf = (agent: BackendId, place = 'local'): string => `${agent}:${place}:${ID}`

async function koloftWithout(gone: BackendId) {
  vi.resetModules()
  vi.doMock('@agents/list', async () => {
    const real = await vi.importActual<typeof import('@agents/list')>('@agents/list')
    const AGENTS = real.AGENTS.filter((agent) => agent.id !== gone)
    return { ...real, AGENTS, PICKED_ON_FIRST_OPEN: AGENTS[0] }
  })
  return {
    ...(await import('@shared/sessionBackend')),
    ...(await import('@shared/cronNames')),
    ...(await import('@shared/cronHistory')),
    ...(await import('../../src/core/agent/sessionBackends')),
    ...(await import('../../src/main/layoutMigrate')),
    ...(await import('../../src/plugins/scheduled-tasks/main/cronStore')),
    ...(await import('../../src/plugins/scheduled-tasks/main/cronVerb')),
    ...(await import('../../src/plugins/scheduled-tasks/main/cronRunner'))
  }
}

afterEach(() => {
  vi.doUnmock('@agents/list')
  vi.resetModules()
})

function tellsWhenAsked(agent: BackendId, asked: string[]): SessionBackend {
  const heard = <T>(answer: T): T => {
    asked.push(agent)
    return answer
  }
  return {
    ...stubBackend(agent),
    aliveTabFor: () => heard(`a tab of ${agent}`),
    transcriptExists: () => heard(true),
    accountUsable: () => heard(false),
    resumePlan: async () => heard({ action: 'direct' as const, cwd: `/${agent}` }),
    resume: async () => heard({ ok: true as const, id: `a tab of ${agent}`, cwd: '/repo' }),
    archive: () => heard(true),
    turns: async () => heard([]),
    transcriptPlaces: () => heard(undefined),
    sessionGone: () => heard(false)
  }
}

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'j1',
    workspacePath: '/ws/a',
    name: 'Old task',
    task: 'look around',
    schedule: { kind: 'daily', at: '10:00' },
    permission: 'same',
    enabled: true,
    createdAt: THE_RUN_BEFORE_AT,
    history: [],
    ...over
  }
}

describe.each(EVERY_AGENT)('a Koloft that no longer has %s', (gone) => {
  const left = EVERY_AGENT.filter((agent) => agent !== gone)
  const ownerOfUnnamedOldDataIsLeft = gone !== OWNER_OF_UNNAMED_OLD_DATA

  it('reports its saved session keys as unavailable, here and on a machine and in the old two-part form, and still reads every other agent’s', async () => {
    const { identityOf } = await koloftWithout(gone)
    expect(identityOf(keyOf(gone))).toBeUndefined()
    expect(identityOf(keyOf(gone, 'devbox'))).toBeUndefined()
    expect(identityOf(`${gone}:019a-thread`)).toBeUndefined()
    for (const agent of left) {
      expect(identityOf(keyOf(agent, 'devbox'))).toEqual({
        backendId: agent,
        sourceId: 'devbox',
        nativeSessionId: ID
      })
    }
  })

  it('an old id that names no agent stays the owner of unnamed old data’s, and is unavailable once that owner is the one gone', async () => {
    const { identityOf } = await koloftWithout(gone)
    expect(identityOf(ID)).toEqual(
      ownerOfUnnamedOldDataIsLeft
        ? { backendId: OWNER_OF_UNNAMED_OLD_DATA, sourceId: 'local', nativeSessionId: ID }
        : undefined
    )
  })

  it('answers "nothing here" for its keys before any agent is asked: no live tab, no transcript, no missing account, a plan of not found, a refused resume, nothing archived, no turns, no transcript place, and gone for the butler', async () => {
    const { SessionBackends } = await koloftWithout(gone)
    const asked: string[] = []
    const backends = new SessionBackends(lifecycle())
    for (const agent of left) backends.register(tellsWhenAsked(agent, asked))
    const unavailable = [keyOf(gone), keyOf(gone, 'devbox')]
    if (!ownerOfUnnamedOldDataIsLeft) unavailable.push(ID)
    for (const key of unavailable) {
      expect(backends.aliveTabFor(key)).toBeUndefined()
      expect(backends.transcriptExists(key)).toBe(false)
      expect(backends.noAccountToResume(key)).toBeNull()
      await expect(backends.resumePlan(key)).resolves.toEqual({
        action: 'unavailable',
        reason: 'not-found'
      })
      await expect(backends.resume({ sessionId: key, cwd: '/repo' })).resolves.toEqual({
        ok: false,
        code: 'invalid-args'
      })
      expect(backends.archive(key)).toBe(false)
      await expect(backends.turns(key, 3)).resolves.toEqual([])
      expect(backends.transcriptPlaces(key)).toBeUndefined()
      expect(backends.sessionStillThere(key, new Set())).toBe(false)
    }
    expect(asked).toEqual([])
  })

  it('still gives the answers of the agent a key names, and of the owner of unnamed old data for an old id, and asks no other agent', async () => {
    const { SessionBackends } = await koloftWithout(gone)
    const asked: string[] = []
    const backends = new SessionBackends(lifecycle())
    for (const agent of left) backends.register(tellsWhenAsked(agent, asked))
    const owned: [string, BackendId][] = left.map((agent) => [keyOf(agent), agent])
    if (ownerOfUnnamedOldDataIsLeft) owned.push([ID, OWNER_OF_UNNAMED_OLD_DATA])
    for (const [key, owner] of owned) {
      asked.length = 0
      expect(backends.aliveTabFor(key)).toBe(`a tab of ${owner}`)
      expect(await backends.transcriptExists(key)).toBe(true)
      expect(backends.noAccountToResume(key)).toBe(NO_USABLE_ACCOUNT[owner])
      await expect(backends.resumePlan(key)).resolves.toEqual({
        action: 'direct',
        cwd: `/${owner}`
      })
      await expect(backends.resume({ sessionId: key, cwd: '/repo' })).resolves.toMatchObject({
        id: `a tab of ${owner}`
      })
      expect(backends.archive(key)).toBe(true)
      expect(backends.sessionStillThere(key, new Set())).toBe(true)
      expect(new Set(asked)).toEqual(new Set([owner]))
    }
  })

  it('a scheduled task’s text prints its run’s key as it is, and "the last run of this task" skips its runs for the last one that is the task’s own agent’s', async () => {
    const { agentSessionId, lastRunLine, formatShow } = await koloftWithout(gone)
    const history: HistoryLine[] = [
      { dueAt: A_RUN_AT, state: 'closed', sessionId: keyOf(gone) },
      { dueAt: THE_RUN_BEFORE_AT, state: 'closed', sessionId: keyOf(left[0]) }
    ]
    expect(agentSessionId(keyOf(gone))).toBe(keyOf(gone))
    expect(formatShow(job({ backend: left[0], history }), 1, [], new Date(A_RUN_AT))).toContain(
      `session ${keyOf(gone)} ·`
    )
    for (const agent of left) {
      expect(lastRunLine(history, agent)).toBe(
        agent === left[0]
          ? `Last run of this task: ${localIso(THE_RUN_BEFORE_AT)}, session ${ID}.`
          : null
      )
    }
  })

  it('a version 4 layout’s keys become members only when their owner is known and is the owner of unnamed old data', async () => {
    const { migrateLayout } = await koloftWithout(gone)
    const keys = [ID, ...EVERY_AGENT.map((agent) => keyOf(agent))]
    const out = migrateLayout(
      {
        version: 4,
        workspaces: [{ path: '/repo' }],
        workbench: { defaultOpen: true },
        sessions: Object.fromEntries(keys.map((key) => [key, { open: false, tabs: [] }]))
      },
      { dirExists: () => true, projectRootOf: (p) => p }
    )
    expect(out.members).toEqual(
      ownerOfUnnamedOldDataIsLeft ? [ID, keyOf(OWNER_OF_UNNAMED_OLD_DATA)] : []
    )
    expect(Object.keys(out.panels)).toEqual(keys)
  })

  it('a scheduled task that names no agent is the owner of unnamed old data’s, and nobody’s once that owner is gone; one that names an agent left is that agent’s', async () => {
    const { cronBackend } = await koloftWithout(gone)
    expect(cronBackend({})).toBe(
      ownerOfUnnamedOldDataIsLeft ? OWNER_OF_UNNAMED_OLD_DATA : undefined
    )
    for (const agent of left) expect(cronBackend({ backend: agent })).toBe(agent)
  })
})

describe('a Koloft that no longer has the owner of unnamed old data: a scheduled task that names no agent', () => {
  const kept = EVERY_AGENT.find((agent) => agent !== OWNER_OF_UNNAMED_OLD_DATA)!

  it('is paused as it is read, with the note an agent that is no longer supported gets, while a task of an agent left stays on', async () => {
    const { sanitizeCron, AGENT_NO_LONGER_SUPPORTED_NOTE } =
      await koloftWithout(OWNER_OF_UNNAMED_OLD_DATA)
    const read = sanitizeCron({ version: 1, jobs: [job(), job({ id: 'j2', backend: kept })] }, [])
    expect(read.jobs.map((j) => [j.id, j.enabled])).toEqual([
      ['j1', false],
      ['j2', true]
    ])
    expect(read.notes).toEqual({ j1: AGENT_NO_LONGER_SUPPORTED_NOTE })
  })

  it('is shown with no "Runs as" line, and is not started when asked to run: the refusal carries that note', async () => {
    const { formatShow, CronRunner, AGENT_NO_LONGER_SUPPORTED_NOTE } =
      await koloftWithout(OWNER_OF_UNNAMED_OLD_DATA)
    const now = new Date(A_RUN_AT)
    expect(formatShow(job(), 1, [], now)).not.toContain('Runs as:')
    expect(formatShow(job({ backend: kept }), 1, [], now)).toContain('Runs as: ')

    const jobs = [job({ enabled: false })]
    const launch = vi.fn()
    const toasts: string[] = []
    const runner = new CronRunner({
      now: () => A_RUN_AT,
      bootTime: A_RUN_AT,
      store: { load: () => ({ jobs, notes: {} }), save: () => {} },
      dirExists: () => true,
      gitDirExists: () => false,
      launch,
      toast: (text: string) => void toasts.push(text),
      push: () => {}
    } as unknown as RunnerDeps)
    await expect(runner.runNow('j1')).resolves.toEqual({
      ok: false,
      reason: 'turned-off',
      why: AGENT_NO_LONGER_SUPPORTED_NOTE
    })
    expect(launch).not.toHaveBeenCalled()
    expect(jobs[0].history).toMatchObject([
      { state: 'failed', note: AGENT_NO_LONGER_SUPPORTED_NOTE }
    ])
    expect(toasts).toEqual([`⏰ Old task could not start: ${AGENT_NO_LONGER_SUPPORTED_NOTE}`])
  })

  it('cannot be saved until an agent is picked for it: the save is refused with that note, and one that names an agent left is saved', async () => {
    const { CronRunner, AGENT_NO_LONGER_SUPPORTED_NOTE } =
      await koloftWithout(OWNER_OF_UNNAMED_OLD_DATA)
    const jobs = [job({ enabled: false })]
    const runner = new CronRunner({
      now: () => A_RUN_AT,
      bootTime: A_RUN_AT,
      store: { load: () => ({ jobs, notes: {} }), save: () => {} },
      isPinned: () => true,
      gitDirExists: () => false,
      push: () => {}
    } as unknown as RunnerDeps)
    const edited = { ...jobs[0], enabled: true }
    expect(runner.save(edited)).toEqual({ ok: false, errors: [AGENT_NO_LONGER_SUPPORTED_NOTE] })
    expect(jobs[0].enabled).toBe(false)
    expect(runner.save({ ...edited, backend: kept })).toMatchObject({
      ok: true,
      job: { backend: kept, enabled: true }
    })
  })
})

describe.each(EVERY_AGENT)(
  'a Koloft that no longer has %s: a scheduled task that names it',
  (gone) => {
    const other = EVERY_AGENT.find((agent) => agent !== gone)!
    const named = (over: Partial<CronJob> = {}): CronJob =>
      job({ backend: gone, model: 'its-model', effort: 'high', ...over })

    function runnerOf(
      jobs: CronJob[],
      CronRunner: typeof import('../../src/plugins/scheduled-tasks/main/cronRunner').CronRunner
    ) {
      const launch = vi.fn()
      const runner = new CronRunner({
        now: () => A_RUN_AT,
        bootTime: A_RUN_AT,
        store: { load: () => ({ jobs, notes: {} }), save: () => {} },
        isPinned: () => true,
        dirExists: () => true,
        gitDirExists: () => false,
        launch,
        toast: () => {},
        push: () => {}
      } as unknown as RunnerDeps)
      return { runner, launch }
    }

    it('is read as nobody’s, paused with the note an agent that is no longer supported gets, and written back still naming that agent with its model and effort', async () => {
      const { sanitizeCron, cronBackend, AGENT_NO_LONGER_SUPPORTED_NOTE } =
        await koloftWithout(gone)
      const read = sanitizeCron({ version: 1, jobs: [named()] }, [])
      expect(cronBackend(read.jobs[0])).toBeUndefined()
      expect(read.jobs[0].enabled).toBe(false)
      expect(read.notes).toEqual({ j1: AGENT_NO_LONGER_SUPPORTED_NOTE })
      const again = sanitizeCron(JSON.parse(JSON.stringify({ version: 1, jobs: read.jobs })), [])
      expect(again.jobs[0]).toMatchObject({ backend: gone, model: 'its-model', effort: 'high' })
    })

    it('is shown with that note in place of a "Runs as" line', async () => {
      const { formatShow, AGENT_NO_LONGER_SUPPORTED_NOTE } = await koloftWithout(gone)
      const text = formatShow(named({ enabled: false }), 1, [], new Date(A_RUN_AT))
      expect(text).not.toContain('Runs as:')
      expect(text).toContain(AGENT_NO_LONGER_SUPPORTED_NOTE)
    })

    it('cannot be turned on, is not started when asked to run, and is not saved until an agent left is picked for it', async () => {
      const { CronRunner, AGENT_NO_LONGER_SUPPORTED_NOTE } = await koloftWithout(gone)
      const jobs = [named({ enabled: false })]
      const { runner, launch } = runnerOf(jobs, CronRunner)
      runner.setEnabled('j1', true)
      expect(jobs[0].enabled).toBe(false)
      await expect(runner.runNow('j1')).resolves.toMatchObject({
        ok: false,
        why: AGENT_NO_LONGER_SUPPORTED_NOTE
      })
      expect(launch).not.toHaveBeenCalled()
      const edited = { ...jobs[0], backend: undefined, model: undefined, effort: undefined }
      expect(runner.save({ ...edited, enabled: true })).toEqual({
        ok: false,
        errors: [AGENT_NO_LONGER_SUPPORTED_NOTE]
      })
      expect(jobs[0]).toMatchObject({ backend: gone, enabled: false })
      expect(runner.save({ ...edited, backend: other, enabled: true })).toMatchObject({
        ok: true,
        job: { backend: other, enabled: true }
      })
    })

    it('through koloft cron: is listed off, refuses on and an edit that picks no agent with that note, takes an edit to an agent left without the old model and effort, and can be removed', async () => {
      const { CronRunner, cronVerb, AGENT_NO_LONGER_SUPPORTED_NOTE } = await koloftWithout(gone)
      const jobs = [named({ enabled: false })]
      const { runner } = runnerOf(jobs, CronRunner)
      const verb = cronVerb({
        runner: () => runner,
        pinnedWorkspaceOf: () => '/ws/a',
        resolveWorkspace: () => ({ ok: false, error: '' }),
        toast: () => {},
        now: () => new Date(A_RUN_AT)
      })
      const caller = {
        tabId: 'tab-1',
        cwd: '/ws/a',
        session: { tabId: 'tab-1', backendId: other, host: 'local', title: 'Caller' }
      } as unknown as Parameters<typeof verb>[1]
      const run = (...args: string[]) => verb(args, caller)

      expect((await run('list')).text).toContain('Old task · ')
      expect((await run('list')).text).toContain(' · off · ')
      expect(await run('on', '1')).toEqual({
        text: `koloft cron: ${AGENT_NO_LONGER_SUPPORTED_NOTE}`,
        exit: 1
      })
      expect(jobs[0].enabled).toBe(false)
      expect(await run('edit', '1', '--name', 'Renamed')).toEqual({
        text: `koloft cron: ${AGENT_NO_LONGER_SUPPORTED_NOTE}`,
        exit: 1
      })
      expect(jobs[0]).toMatchObject({ name: 'Old task', backend: gone })
      expect((await run('edit', '1', '--backend', other)).exit).toBe(0)
      expect(jobs[0].backend).toBe(other)
      expect(jobs[0].model).toBeUndefined()
      expect(jobs[0].effort).toBeUndefined()

      const left = [named({ id: 'j2' })]
      const second = runnerOf(left, CronRunner).runner
      const rm = cronVerb({
        runner: () => second,
        pinnedWorkspaceOf: () => '/ws/a',
        resolveWorkspace: () => ({ ok: false, error: '' }),
        toast: () => {},
        now: () => new Date(A_RUN_AT)
      })
      expect((await rm(['rm', '1'], caller)).exit).toBe(0)
      expect(second.jobsAndLive().jobs).toEqual([])
    })
  }
)
