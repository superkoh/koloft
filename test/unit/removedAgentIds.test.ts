import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendId, CronJob, HistoryLine } from '@shared/types'
import { localIso } from '@shared/schedule'
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
  const heard = <T>(what: string, answer: T): T => {
    asked.push(`${agent}.${what}`)
    return answer
  }
  return {
    ...stubBackend(agent),
    aliveTabFor: () => heard('aliveTabFor', 'a tab'),
    transcriptExists: () => heard('transcriptExists', true),
    accountUsable: () => heard('accountUsable', true),
    resumePlan: async () => heard('resumePlan', { action: 'direct' as const, cwd: '/repo' }),
    resume: async () => heard('resume', { ok: true as const, id: 'tab', cwd: '/repo' }),
    archive: () => heard('archive', true),
    turns: async () => heard('turns', []),
    transcriptPlaces: () => heard('transcriptPlaces', undefined),
    sessionGone: () => heard('sessionGone', false)
  }
}

const ASKED_BY_KEY = [
  'aliveTabFor',
  'transcriptExists',
  'accountUsable',
  'resumePlan',
  'resume',
  'archive',
  'turns',
  'transcriptPlaces',
  'sessionGone'
]

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

  it('still asks the agent a key names, and the owner of unnamed old data for an old id, each of the same questions', async () => {
    const { SessionBackends } = await koloftWithout(gone)
    const asked: string[] = []
    const backends = new SessionBackends(lifecycle())
    for (const agent of left) backends.register(tellsWhenAsked(agent, asked))
    const owned: [string, BackendId][] = left.map((agent) => [keyOf(agent), agent])
    if (ownerOfUnnamedOldDataIsLeft) owned.push([ID, OWNER_OF_UNNAMED_OLD_DATA])
    for (const [key, owner] of owned) {
      asked.length = 0
      backends.aliveTabFor(key)
      await backends.transcriptExists(key)
      backends.noAccountToResume(key)
      await backends.resumePlan(key)
      await backends.resume({ sessionId: key, cwd: '/repo' })
      backends.archive(key)
      await backends.turns(key, 3)
      backends.transcriptPlaces(key)
      backends.sessionStillThere(key, new Set())
      expect(asked).toEqual(ASKED_BY_KEY.map((what) => `${owner}.${what}`))
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
