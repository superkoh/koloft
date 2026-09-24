import type {
  BackendId,
  CronEffort,
  CronJob,
  CronPermission,
  CronSaveInput,
  HistoryLine,
  Schedule,
  SkillSuggestion
} from '@shared/types'
import { CRON_SAVE_MESSAGES as M } from '@shared/cronMessages'
import { hasWordChar, isValidModelName } from '@shared/cronNames'
import { describeWhen, isValidSchedule, nextRun, parseHHMM } from '@shared/schedule'

export type WhenKind = 'daily' | 'weekly' | 'every'

export interface JobFields {
  backend: BackendId
  name: string
  task: string
  whenKind: WhenKind
  at: string
  days: number[]
  n: number
  unit: 'minutes' | 'hours'
  model: '' | 'fable' | 'opus' | 'sonnet' | 'other'
  modelOther: string
  effort: '' | CronEffort
  permission: CronPermission
}

const NEW_JOB_PERMISSION: Record<BackendId, CronPermission> = {
  claude: 'same',
  codex: 'skipAll'
}

export function emptyFields(backend: BackendId = 'claude'): JobFields {
  return {
    backend,
    name: '',
    task: '',
    whenKind: 'daily',
    at: '09:00',
    days: [],
    n: 1,
    unit: 'hours',
    model: '',
    modelOther: '',
    effort: '',
    permission: NEW_JOB_PERMISSION[backend]
  }
}

export function fieldsToSchedule(f: JobFields): Schedule | null {
  let s: Schedule
  if (f.whenKind === 'every') {
    s = { kind: 'every', n: f.n, unit: f.unit }
  } else if (f.whenKind === 'weekly') {
    const days = [...new Set(f.days)].sort((a, b) => a - b)
    s = days.length === 7 ? { kind: 'daily', at: f.at } : { kind: 'weekly', days, at: f.at }
  } else {
    s = { kind: 'daily', at: f.at }
  }
  return isValidSchedule(s) ? s : null
}

export function scheduleToFields(
  s: Schedule
): Pick<JobFields, 'whenKind' | 'at' | 'days' | 'n' | 'unit'> {
  const blank = emptyFields()
  if (s.kind === 'daily') {
    return { whenKind: 'daily', at: s.at, days: blank.days, n: blank.n, unit: blank.unit }
  }
  if (s.kind === 'weekly') {
    return { whenKind: 'weekly', at: s.at, days: [...s.days], n: blank.n, unit: blank.unit }
  }
  return { whenKind: 'every', at: blank.at, days: blank.days, n: s.n, unit: s.unit }
}

export function modelValue(f: JobFields): string | undefined {
  if (f.model === '') return undefined
  if (f.model === 'other') return f.modelOther.trim()
  return f.model
}

export type ValidateResult =
  | { ok: true; input: Omit<CronSaveInput, 'workspacePath' | 'id'> }
  | { ok: false; errors: Partial<Record<keyof JobFields, string>> }

export function validate(f: JobFields): ValidateResult {
  const errors: Partial<Record<keyof JobFields, string>> = {}

  const name = f.name.trim()
  if (!name) errors.name = M.nameEmpty
  else if (name.startsWith('-')) errors.name = M.nameDash
  else if (!hasWordChar(name)) errors.name = M.nameNoWord
  else if (name.length > 80) errors.name = M.nameLong

  const task = f.task.replace(/\0/g, '').trim()
  if (!task) errors.task = M.taskEmpty
  else if (task.startsWith('-')) errors.task = M.taskDash
  else if (task.length > 4096) errors.task = M.taskLong

  if (f.whenKind === 'weekly' && [...new Set(f.days)].length === 0) {
    errors.days = M.days
  }
  if (f.whenKind !== 'every' && parseHHMM(f.at) === null) {
    errors.at = M.time
  }
  if (f.whenKind === 'every') {
    const cap = f.unit === 'minutes' ? 720 : 24
    if (!Number.isInteger(f.n) || f.n < 1 || f.n > cap) {
      errors.n = M.every
    }
  }

  const model = modelValue(f)
  if (f.model === 'other' && !isValidModelName(model ?? '')) {
    errors.modelOther = M.model
  }

  const schedule = fieldsToSchedule(f)
  if (!schedule && !errors.days && !errors.at && !errors.n) {
    errors.at = M.time
  }

  if (Object.keys(errors).length > 0 || !schedule) return { ok: false, errors }

  const input: Omit<CronSaveInput, 'workspacePath' | 'id'> = {
    backend: f.backend,
    name,
    task,
    schedule,
    permission: f.permission,
    enabled: true
  }
  if (model !== undefined) input.model = model
  if (f.effort) input.effort = f.effort
  return { ok: true, input }
}

export function suggest(text: string, skills: SkillSuggestion[]): SkillSuggestion[] {
  if (!text.startsWith('/')) return []
  const q = text.toLowerCase()
  const out: SkillSuggestion[] = []
  for (const s of skills) {
    if (s.name.toLowerCase().startsWith(q)) {
      out.push(s)
      if (out.length === 8) break
    }
  }
  return out
}

export function histText(h: HistoryLine): string {
  if (h.state === 'closed') return 'Closed by you'
  if (h.state === 'ended') return 'Ended — Koloft quit'
  if (h.state === 'failed') return h.note ? `Could not start — ${h.note}` : 'Could not start'
  const n = h.count ?? 1
  if (h.state === 'missed') {
    return n > 1
      ? `Missed ${n} times — Koloft was closed or asleep`
      : 'Missed — Koloft was closed or asleep'
  }
  return n > 1
    ? `Skipped ${n} times — the last run was still open`
    : 'Skipped — the last run was still open'
}

export function histWhen(h: HistoryLine, now: Date): string {
  const from = describeWhen(new Date(h.dueAt), now)
  if (h.until === undefined || h.until <= h.dueAt) return from
  return `${from} → ${describeWhen(new Date(h.until), now)}`
}

export function histEnd(h: HistoryLine): number {
  return h.until !== undefined && h.until > h.dueAt ? h.until : h.dueAt
}

const SOON_MS = 60 * 60_000

export interface Forecast {
  id: string
  name: string
  more: number
  at: Date
  soon: boolean
  title: string
}

export function forecastFor(jobs: CronJob[], wsPath: string, now: Date): Forecast | null {
  const due = jobs
    .filter((j) => j.enabled && j.workspacePath === wsPath)
    .map((j) => ({ job: j, at: nextRun(j.schedule, now) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  if (due.length === 0) return null
  const first = due[0]
  const lines = due.map((d) => `${d.job.name} · ${describeWhen(d.at, now)}`)
  lines.push('Scheduled jobs…')
  return {
    id: first.job.id,
    name: first.job.name,
    more: due.length - 1,
    at: first.at,
    soon: first.at.getTime() - now.getTime() <= SOON_MS,
    title: lines.join('\n')
  }
}
