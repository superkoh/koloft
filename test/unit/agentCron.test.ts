import { describe, expect, it } from 'vitest'
import { CronRunner, type RunnerDeps } from '../../src/main/cronRunner'
import {
  cronVerb,
  formatList,
  formatShow,
  parseCronArgs,
  type CronVerbDeps
} from '../../src/main/agentCron'
import { EXIT_USAGE, NOT_PINNED } from '../../src/main/agentRequests'
import type { BackendId, CronJob } from '../../src/shared/types'

const NOW = new Date(2026, 8, 2, 10, 0, 0, 0)
const HERE = '/ws/here'
const ELSEWHERE = '/ws/elsewhere'

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'j1',
    workspacePath: HERE,
    name: 'nightly',
    task: 'Run the tests',
    schedule: { kind: 'daily', at: '02:00' },
    permission: 'same',
    enabled: true,
    createdAt: NOW.getTime(),
    history: [],
    ...over
  }
}

function runnerWith(jobs: CronJob[]): CronRunner {
  const deps = {
    now: () => NOW.getTime(),
    bootTime: NOW.getTime(),
    store: { load: () => ({ jobs, notes: {} }), save: () => {} },
    isPinned: (p: string) => p === HERE || p === ELSEWHERE,
    gitDirExists: () => false,
    push: () => {}
  } as unknown as RunnerDeps
  return new CronRunner(deps)
}

function cron(
  jobs: CronJob[],
  over: Partial<CronVerbDeps> & { backend?: BackendId } = {}
): {
  run: (...args: string[]) => ReturnType<ReturnType<typeof cronVerb>>
  runner: CronRunner
  toasts: string[]
} {
  const runner = runnerWith(jobs)
  const toasts: string[] = []
  const verb = cronVerb({
    runner: () => runner,
    pinnedWorkspaceOf: () => HERE,
    backendOf: () => over.backend ?? 'claude',
    sessionName: () => 'Fix login',
    toast: (t) => toasts.push(t),
    now: () => NOW,
    ...over
  })
  return { run: (...args) => verb(args, { tabId: 'tab-1', cwd: HERE }), runner, toasts }
}

function parsedPatch(args: string[]): unknown {
  const r = parseCronArgs(args)
  if (!r.ok) throw new Error(r.error)
  return r.value.patch
}

function parseError(args: string[]): string {
  const r = parseCronArgs(args)
  if (r.ok) throw new Error('parsed')
  return r.error
}

describe('koloft cron: reading the command line', () => {
  it('add turns every option into the task fields and joins the words after -- into the task', () => {
    const r = parseCronArgs([
      'add',
      '--name',
      'nightly',
      '--daily',
      '02:00',
      '--backend',
      'codex',
      '--model',
      'gpt-5',
      '--effort',
      'high',
      '--permission',
      'acceptEdits',
      '--',
      'Run',
      'the tests'
    ])
    expect(r).toEqual({
      ok: true,
      value: {
        sub: 'add',
        ref: undefined,
        patch: {
          name: 'nightly',
          schedule: { kind: 'daily', at: '02:00' },
          backend: 'codex',
          model: 'gpt-5',
          effort: 'high',
          permission: 'acceptEdits',
          task: 'Run the tests'
        }
      }
    })
  })

  it('the three time options map onto the Schedule kinds; weekly days are sorted, deduped, and all seven mean daily', () => {
    expect(parsedPatch(['edit', '1', '--every', '30m'])).toEqual({
      schedule: { kind: 'every', n: 30, unit: 'minutes' }
    })
    expect(parsedPatch(['edit', '1', '--every', '2h'])).toEqual({
      schedule: { kind: 'every', n: 2, unit: 'hours' }
    })
    expect(parsedPatch(['edit', '1', '--weekly', 'fri,Mon,wed,mon@09:00'])).toEqual({
      schedule: { kind: 'weekly', days: [1, 3, 5], at: '09:00' }
    })
    expect(parsedPatch(['edit', '1', '--weekly', 'sun,mon,tue,wed,thu,fri,sat@07:30'])).toEqual({
      schedule: { kind: 'daily', at: '07:30' }
    })
  })

  it('a malformed command is refused with a reason, before anything is saved', () => {
    expect(parseError([])).toMatch(/say what to do/)
    expect(parseError(['make'])).toMatch(/no "make" command/)
    expect(parseError(['edit', '1', '--colour', 'red'])).toMatch(/no --colour option/)
    expect(parseError(['edit', '1', '--model'])).toMatch(/--model needs a value/)
    expect(parseError(['edit', '1', '--model', '--', 'x'])).toMatch(/--model needs a value/)
    expect(parseError(['edit', '1', '--daily', '09:00', '--every', '2h'])).toMatch(/only one/)
    expect(parseError(['edit', '1', '--every', '30s'])).toMatch(/--every like 30m/)
    expect(parseError(['edit', '1', '--weekly', 'mon,funday@09:00'])).toMatch(
      /"funday" is not a day/
    )
    expect(parseError(['edit', '1', '--weekly', 'mon'])).toMatch(/--weekly like/)
    expect(parseError(['edit', '1', '--backend', 'gemini'])).toMatch(/claude or codex/)
    expect(parseError(['edit', '1', '--effort', 'huge'])).toMatch(/--effort is one of/)
    expect(parseError(['edit', '1', '--permission', 'root'])).toMatch(/--permission is one of/)
    expect(parseError(['edit', '1'])).toMatch(/say what to change/)
    expect(parseError(['edit', '--daily', '09:00'])).toMatch(/say which task/)
    expect(parseError(['show', '1', '--daily', '09:00'])).toMatch(/takes no options/)
    expect(parseError(['list', 'extra'])).toMatch(/did not expect "extra"/)
    expect(parseError(['add', '--daily', '09:00', '--', 'x'])).toMatch(/--name/)
    expect(parseError(['add', '--name', 'n', '--', 'x'])).toMatch(/when it runs/)
    expect(parseError(['add', '--name', 'n', '--daily', '09:00'])).toMatch(/after --/)
    expect(parseError(['add', '--name', 'n', '--daily', '09:00', 'Run it'])).toMatch(
      /did not expect "Run it"/
    )
  })
})

describe('koloft cron: changing tasks', () => {
  it('edit changes only the parts given and keeps model, effort, permission, task and off state', async () => {
    const kept = job({ model: 'opus', effort: 'max', permission: 'skipAll', enabled: false })
    const c = cron([kept])
    const reply = await c.run('edit', 'nightly', '--daily', '03:00')
    expect(reply.ok).toBe(true)
    expect(c.runner.state().jobs[0]).toMatchObject({
      id: 'j1',
      name: 'nightly',
      task: 'Run the tests',
      schedule: { kind: 'daily', at: '03:00' },
      model: 'opus',
      effort: 'max',
      permission: 'skipAll',
      enabled: false
    })
  })

  it('reaches only the caller workspace: another workspace’s task is neither listed nor found by name or number', async () => {
    const c = cron([job({ id: 'other', workspacePath: ELSEWHERE, name: 'theirs' })])
    const listed = await c.run('list')
    expect(listed.text).not.toMatch(/theirs/)
    expect((await c.run('rm', 'theirs')).ok).toBe(false)
    expect((await c.run('off', '1')).ok).toBe(false)
    expect(c.runner.state().jobs[0]).toMatchObject({ id: 'other', enabled: true })
  })

  it('refuses every command while the workspace is not pinned', async () => {
    const c = cron([job()], { pinnedWorkspaceOf: () => undefined })
    expect(await c.run('list')).toEqual({ ok: false, text: NOT_PINNED, exit: 1 })
  })

  it('add saves an enabled task in the caller workspace with the dialog default permission for its backend, and toasts who did it', async () => {
    const c = cron([], { backend: 'codex' })
    const reply = await c.run('add', '--name', 'lint', '--every', '2h', '--', 'Run lint')
    expect(reply.ok).toBe(true)
    expect(c.runner.state().jobs[0]).toMatchObject({
      workspacePath: HERE,
      name: 'lint',
      task: 'Run lint',
      backend: 'codex',
      permission: 'skipAll',
      enabled: true
    })
    expect(c.toasts).toEqual([expect.stringMatching(/Fix login.*lint/)])
  })

  it('a value the task dialog would reject comes back as that same error, and nothing is saved', async () => {
    const c = cron([])
    const reply = await c.run('add', '--name', 'lint', '--daily', '9am', '--', 'Run lint')
    expect(reply).toMatchObject({ ok: false, text: expect.stringMatching(/Use a time like 09:00/) })
    expect(c.runner.state().jobs).toEqual([])
    expect(c.toasts).toEqual([])
  })

  it('rm, on and off change the task and each shows a toast naming the session and the task', async () => {
    const c = cron([job(), job({ id: 'j2', name: 'weekly' })])
    await c.run('off', '2')
    expect(c.runner.state().jobs[1].enabled).toBe(false)
    await c.run('on', 'weekly')
    expect(c.runner.state().jobs[1].enabled).toBe(true)
    await c.run('rm', 'nightly')
    expect(c.runner.state().jobs.map((j) => j.id)).toEqual(['j2'])
    expect(c.toasts).toEqual([
      expect.stringMatching(/Fix login.*weekly/),
      expect.stringMatching(/Fix login.*weekly/),
      expect.stringMatching(/Fix login.*nightly/)
    ])
  })

  it('a bad command line exits with the usage code', async () => {
    expect((await cron([]).run('add')).exit).toBe(EXIT_USAGE)
  })
})

describe('koloft cron: printing tasks', () => {
  it('list gives one line per task with number, name, schedule, on or off, next run and last result', () => {
    const text = formatList(
      [
        job({ history: [{ dueAt: new Date(2026, 8, 2, 2, 0).getTime(), state: 'closed' }] }),
        job({ id: 'j2', name: 'weekly', enabled: false })
      ],
      [],
      NOW
    )
    const [first, second] = text.split('\n')
    expect(first).toMatch(
      /^1\. nightly · Every day at 2:00 · on · next tomorrow 02:00 · last run today 02:00/
    )
    expect(second).toMatch(/^2\. weekly · .* · off · .*never run/)
  })

  it('show prints the task, its settings and its recent runs', () => {
    const text = formatShow(
      job({
        model: 'opus',
        task: 'Run the tests\nand report',
        history: [
          {
            dueAt: new Date(2026, 8, 2, 2, 0).getTime(),
            state: 'failed',
            note: 'no usable account'
          }
        ]
      }),
      1,
      [],
      NOW
    )
    expect(text).toContain('Id: j1')
    expect(text).toContain('opus')
    expect(text).toContain('    Run the tests\n    and report')
    expect(text).toContain('today 02:00 · Could not start — no usable account')
  })
})
