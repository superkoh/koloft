import {
  CRON_EFFORTS,
  isCronEffort,
  type BackendId,
  type CronEffort,
  type CronJob,
  type CronPermission,
  type CronRunNowResult,
  type CronSaveInput,
  type CronSaveResult,
  type CronState,
  type LiveRun,
  type Schedule
} from '@shared/types'
import { BACKEND_LABEL, backendIdOf } from '@shared/sessionBackend'
import { cronBackend, NEW_JOB_PERMISSION } from '@shared/cronNames'
import { describeSchedule, describeWhen, nextRun } from '@shared/schedule'
import { histText, histWhen, lastRunOf, LIVE_WORDS, whenLine } from '@shared/cronHistory'
import { answered, EXIT_USAGE, refused, type AgentReply, type AgentVerb } from './agentRequests'

const SUBS = ['list', 'show', 'add', 'edit', 'rm', 'on', 'off', 'run'] as const
type Sub = (typeof SUBS)[number]
const TAKES_OPTIONS: Sub[] = ['add', 'edit']
const TAKES_NO_JOB: Sub[] = ['list', 'add']

const TIME_FLAGS = ['--every', '--daily', '--weekly']
const VALUE_FLAGS = ['--name', ...TIME_FLAGS, '--backend', '--model', '--effort', '--permission']
const PERMISSIONS: CronPermission[] = ['same', 'acceptEdits', 'skipAll']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export interface CronPatch {
  name?: string
  schedule?: Schedule
  backend?: BackendId
  model?: string
  effort?: CronEffort
  permission?: CronPermission
  task?: string
}

export interface CronCommand {
  sub: Sub
  ref?: string
  patch: CronPatch
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

function fail<T>(error: string): Parsed<T> {
  return { ok: false, error }
}

export function parseSchedule(flag: string, value: string): Parsed<Schedule> {
  if (flag === '--every') {
    const m = /^(\d+)([mh])$/.exec(value)
    if (!m) return fail('write --every like 30m or 2h.')
    return {
      ok: true,
      value: { kind: 'every', n: Number(m[1]), unit: m[2] === 'm' ? 'minutes' : 'hours' }
    }
  }
  if (flag === '--daily') return { ok: true, value: { kind: 'daily', at: value } }
  const at = value.lastIndexOf('@')
  if (at < 0) return fail('write --weekly like mon,wed,fri@09:00.')
  const days: number[] = []
  for (const word of value.slice(0, at).split(',')) {
    const day = DAYS.indexOf(word.trim().toLowerCase())
    if (day < 0) return fail(`"${word}" is not a day. Use ${DAYS.slice(1).join(', ')} or sun.`)
    if (!days.includes(day)) days.push(day)
  }
  days.sort((a, b) => a - b)
  const time = value.slice(at + 1)
  return {
    ok: true,
    value:
      days.length === DAYS.length ? { kind: 'daily', at: time } : { kind: 'weekly', days, at: time }
  }
}

function applyFlag(patch: CronPatch, flag: string, value: string): string | null {
  if (flag === '--name') patch.name = value
  else if (flag === '--model') patch.model = value
  else if (flag === '--backend') {
    const backend = backendIdOf(value)
    if (!backend) return '--backend is claude or codex.'
    patch.backend = backend
  } else if (flag === '--effort') {
    if (!isCronEffort(value)) return `--effort is one of ${CRON_EFFORTS.join(', ')}.`
    patch.effort = value
  } else if (flag === '--permission') {
    const permission = PERMISSIONS.find((p) => p === value)
    if (!permission) return `--permission is one of ${PERMISSIONS.join(', ')}.`
    patch.permission = permission
  } else {
    if (patch.schedule) return 'give only one of --every, --daily or --weekly.'
    const schedule = parseSchedule(flag, value)
    if (!schedule.ok) return schedule.error
    patch.schedule = schedule.value
  }
  return null
}

export function parseCronArgs(args: string[]): Parsed<CronCommand> {
  const [word, ...rest] = args
  const sub = SUBS.find((s) => s === word)
  if (!sub) {
    const what = word === undefined ? 'say what to do' : `there is no "${word}" command`
    return fail(`${what}: use ${SUBS.join(', ')}. Run "koloft help" to see how.`)
  }
  const patch: CronPatch = {}
  let ref: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--') {
      patch.task = rest.slice(i + 1).join(' ')
      break
    }
    if (arg.startsWith('--')) {
      if (!VALUE_FLAGS.includes(arg)) return fail(`there is no ${arg} option.`)
      const value = rest[i + 1]
      if (value === undefined || value === '--') return fail(`${arg} needs a value.`)
      i++
      const error = applyFlag(patch, arg, value)
      if (error) return fail(error)
      continue
    }
    if (ref === undefined && !TAKES_NO_JOB.includes(sub)) {
      ref = arg
      continue
    }
    return fail(`did not expect "${arg}". Put what to do after --, like: -- "Run the tests"`)
  }
  if (!TAKES_OPTIONS.includes(sub) && Object.keys(patch).length > 0)
    return fail(`"koloft cron ${sub}" takes no options.`)
  if (!TAKES_NO_JOB.includes(sub) && ref === undefined)
    return fail(`say which task: koloft cron ${sub} <number or name>`)
  if (sub === 'add') {
    if (patch.name === undefined) return fail('give the task a name with --name.')
    if (!patch.schedule)
      return fail('say when it runs: --every 30m, --daily 09:00 or --weekly mon,wed,fri@09:00.')
    if (patch.task === undefined) return fail('put what to do after --, like: -- "Run the tests"')
  }
  if (sub === 'edit' && Object.keys(patch).length === 0) return fail('say what to change.')
  return { ok: true, value: { sub, ref, patch } }
}

function withModelAndEffort(
  input: CronSaveInput,
  model: string | undefined,
  effort: CronEffort | undefined
): CronSaveInput {
  return {
    ...input,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {})
  }
}

export function newJobInput(
  patch: CronPatch,
  workspacePath: string,
  callerBackend: BackendId
): CronSaveInput {
  const backend = patch.backend ?? callerBackend
  return withModelAndEffort(
    {
      workspacePath,
      name: patch.name ?? '',
      task: patch.task ?? '',
      schedule: patch.schedule as Schedule,
      backend,
      permission: patch.permission ?? NEW_JOB_PERMISSION[backend],
      enabled: true
    },
    patch.model,
    patch.effort
  )
}

export function mergeEdit(job: CronJob, patch: CronPatch): CronSaveInput {
  return withModelAndEffort(
    {
      id: job.id,
      workspacePath: job.workspacePath,
      name: patch.name ?? job.name,
      task: patch.task ?? job.task,
      schedule: patch.schedule ?? job.schedule,
      backend: patch.backend ?? cronBackend(job),
      permission: patch.permission ?? job.permission,
      enabled: job.enabled
    },
    patch.model ?? job.model,
    patch.effort ?? job.effort
  )
}

export function findJob(jobs: CronJob[], ref: string): Parsed<CronJob> {
  if (/^\d+$/.test(ref)) {
    const job = jobs[Number(ref) - 1]
    if (job) return { ok: true, value: job }
  }
  const byId = jobs.find((j) => j.id === ref)
  if (byId) return { ok: true, value: byId }
  const named = jobs.filter((j) => j.name === ref)
  if (named.length === 1) return { ok: true, value: named[0] }
  if (named.length > 1)
    return fail(`${named.length} tasks are named "${ref}". Use the number from "koloft cron list".`)
  return fail(`there is no task "${ref}" in this workspace. Run "koloft cron list" to see them.`)
}

function liveOf(live: LiveRun[], jobId: string): LiveRun | undefined {
  return live.find((l) => l.jobId === jobId)
}

function lastText(job: CronJob, live: LiveRun[], now: Date): string {
  const last = lastRunOf(job, liveOf(live, job.id))
  return last ? `last run ${describeWhen(new Date(last.dueAt), now)} · ${last.words}` : 'never run'
}

function nextText(job: CronJob, now: Date): string {
  return job.enabled ? `next ${describeWhen(nextRun(job.schedule, now), now)}` : 'no next run'
}

export function formatList(jobs: CronJob[], live: LiveRun[], now: Date): string {
  if (jobs.length === 0) return 'This workspace has no scheduled tasks.'
  return jobs
    .map((job, i) =>
      [
        `${i + 1}. ${job.name}`,
        describeSchedule(job.schedule),
        job.enabled ? 'on' : 'off',
        nextText(job, now),
        lastText(job, live, now)
      ].join(' · ')
    )
    .join('\n')
}

export function formatShow(job: CronJob, number: number, live: LiveRun[], now: Date): string {
  const run = liveOf(live, job.id)
  const runs = [
    ...(run ? [`    ${describeWhen(new Date(run.dueAt), now)} · ${LIVE_WORDS[run.state]}`] : []),
    ...job.history.map((h) => `    ${histWhen(h, now)} · ${histText(h)}`)
  ]
  return [
    `${number}. ${job.name}`,
    `Id: ${job.id}`,
    `When: ${describeSchedule(job.schedule)}`,
    `On: ${job.enabled ? 'yes' : 'no'} · ${nextText(job, now)}`,
    `Runs as: ${BACKEND_LABEL[cronBackend(job)]}`,
    `Model: ${job.model ?? 'default'}`,
    `Effort: ${job.effort ?? 'default'}`,
    `Permission: ${job.permission}`,
    'What to do:',
    ...job.task.split('\n').map((line) => `    ${line}`),
    'Recent runs:',
    ...(runs.length > 0 ? runs : ['    none yet'])
  ].join('\n')
}

const RUN_REFUSED: Record<Exclude<CronRunNowResult, { ok: true }>['reason'], string> = {
  skipped: 'the last run is still open.',
  failed: 'the session exited before it started.',
  'folder-missing': 'the workspace folder is missing.',
  'no-account': 'there is no usable account.',
  'not-ready': 'Koloft is not ready yet. Try again in a moment.',
  'unknown-job': 'the task is gone.'
}

export const NOT_PINNED = 'koloft: pin this workspace in the sidebar first.'
const RUNNER_NOT_READY = 'koloft: Koloft is still starting. Try again in a moment.'

export interface CronRunnerApi {
  state(): CronState
  save(input: CronSaveInput): CronSaveResult
  delete(jobId: string): void
  setEnabled(jobId: string, on: boolean): void
  runNow(jobId: string): Promise<CronRunNowResult>
}

export interface CronVerbDeps {
  runner(): CronRunnerApi | null
  pinnedWorkspaceOf(tabId: string): string | undefined
  backendOf(tabId: string): BackendId
  sessionName(tabId: string): string
  toast(text: string): void
  now(): Date
}

export function cronVerb(d: CronVerbDeps): AgentVerb {
  return async (args, caller): Promise<AgentReply> => {
    const parsed = parseCronArgs(args)
    if (!parsed.ok) return refused(`koloft cron: ${parsed.error}`, EXIT_USAGE)
    const workspace = d.pinnedWorkspaceOf(caller.tabId)
    if (!workspace) return refused(NOT_PINNED)
    const runner = d.runner()
    if (!runner) return refused(RUNNER_NOT_READY)
    const { sub, ref, patch } = parsed.value
    const jobsHere = (all: CronJob[]): CronJob[] => all.filter((j) => j.workspacePath === workspace)
    const { jobs: allJobs, live } = runner.state()
    const now = d.now()
    const tell = (did: string, name: string): void =>
      d.toast(`⏰ ${d.sessionName(caller.tabId)} ${did} scheduled task ${name}`)
    const saved = (result: CronSaveResult, did: string, reply: string): AgentReply => {
      if (!result.ok) return refused(`koloft cron: ${result.errors.join(' ')}`)
      tell(did, result.job.name)
      const number = jobsHere(runner.state().jobs).indexOf(result.job) + 1
      return answered(`${reply} task ${number}. ${result.job.name} · ${whenLine(result.job, now)}`)
    }

    const jobs = jobsHere(allJobs)
    if (sub === 'list') return answered(formatList(jobs, live, now))
    if (sub === 'add') {
      const input = newJobInput(patch, workspace, d.backendOf(caller.tabId))
      return saved(runner.save(input), 'added', 'Added')
    }

    const found = findJob(jobs, ref ?? '')
    if (!found.ok) return refused(`koloft cron: ${found.error}`)
    const job = found.value
    if (sub === 'show') return answered(formatShow(job, jobs.indexOf(job) + 1, live, now))
    if (sub === 'edit') return saved(runner.save(mergeEdit(job, patch)), 'changed', 'Changed')
    if (sub === 'rm') {
      runner.delete(job.id)
      tell('removed', job.name)
      return answered(`Removed ${job.name}.`)
    }
    if (sub === 'on' || sub === 'off') {
      runner.setEnabled(job.id, sub === 'on')
      tell(`turned ${sub}`, job.name)
      return answered(`Turned ${sub} ${job.name}. ${whenLine(job, now)}`)
    }
    const result = await runner.runNow(job.id)
    return result.ok
      ? answered(`Started ${job.name} in a new session tab.`)
      : refused(`koloft cron: ${job.name} did not start: ${RUN_REFUSED[result.reason]}`)
  }
}
