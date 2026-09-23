import type {
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

/** The scheduled-jobs form's rules, kept out of the dialog so every refusal and
 *  every shape change is testable without a DOM. Pure: no React, no window, no fs.
 *
 *  Why the form refuses at all: the task text and the job name ride to `claude` as
 *  environment variables and a positional argument after `--`, so a name or a text the
 *  launch line could not carry has to be stopped here, before it is ever saved. The
 *  main process re-runs these same rules in `CronRunner.save` — the form is the polite
 *  half, not the guard. */

/** Which of the three "When" shapes the chips are on. */
export type WhenKind = 'daily' | 'weekly' | 'every'

/** Everything the form holds. `at`, `days`, `n` and `unit` all stay filled while the
 *  chips move, so switching back to a preset finds what was typed there before. */
export interface JobFields {
  name: string
  task: string
  whenKind: WhenKind
  /** `HH:MM` straight out of `<input type="time">` (empty when the box is cleared) */
  at: string
  /** 0 = Sunday … 6 = Saturday */
  days: number[]
  n: number
  unit: 'minutes' | 'hours'
  model: '' | 'fable' | 'opus' | 'sonnet' | 'other'
  modelOther: string
  effort: '' | CronEffort
  permission: CronPermission
}

/** What a brand-new job starts as. */
export function emptyFields(): JobFields {
  return {
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
    permission: 'same'
  }
}

/** The saved shape of the "When" row, or null while it says nothing valid yet.
 *  All seven days ticked is stored as `daily`: one rule, one set of words, and the
 *  weekly shape never has to carry a seven-entry list. */
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

/** The other way round, for the edit form. The parts a schedule does not carry keep
 *  their fresh-form values, so the chips it does not light are still usable. */
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

/** '' → no model key at all (whatever a new session would use); a chip → its alias;
 *  Other… → what was typed. */
export function modelValue(f: JobFields): string | undefined {
  if (f.model === '') return undefined
  if (f.model === 'other') return f.modelOther.trim()
  return f.model
}

export type ValidateResult =
  | { ok: true; input: Omit<CronSaveInput, 'workspacePath' | 'id'> }
  | { ok: false; errors: Partial<Record<keyof JobFields, string>> }

/** Every message a person can be shown about this form lives here, one per field.
 *  `enabled` is not a form field — a fresh job starts on, and an edit keeps whatever
 *  the card's switch says, so the caller overwrites it. */
export function validate(f: JobFields): ValidateResult {
  const errors: Partial<Record<keyof JobFields, string>> = {}

  // a name starting with '-' would reach claude as a flag-shaped `--name` value, so
  // it is refused here for the same reason the task text is
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
  // a schedule that still says nothing has already put its own message on a field;
  // this only catches a shape no message covers, and it never reports twice
  if (!schedule && !errors.days && !errors.at && !errors.n) {
    errors.at = M.time
  }

  if (Object.keys(errors).length > 0 || !schedule) return { ok: false, errors }

  const input: Omit<CronSaveInput, 'workspacePath' | 'id'> = {
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

/** What the box under "What to run" lists. Nothing at all until the text starts with
 *  a '/': the field takes any message, and a plain sentence must not be nagged at.
 *  The whole text is the prefix, so the trailing space a picked name leaves behind
 *  closes the list by itself. */
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

/** The outcomes written out for the History list (§7.4). A row can stand for a RUN of
 *  outcomes, not just one: skips fold while a run stays open, misses fold while the Mac
 *  sleeps through a stretch of them. Folding is what keeps a job that is due every
 *  minute from spending all 20 lines of history on one quiet morning. */
export function histText(h: HistoryLine): string {
  if (h.state === 'closed') return 'Closed by you'
  if (h.state === 'ended') return 'Ended — Koloft quit'
  if (h.state === 'failed') return h.note ? `Could not start — ${h.note}` : 'Could not start'
  const n = h.count ?? 1
  // "closed or asleep", not "was not running": a Mac that naps with Koloft open, or a
  // window shut for more than five minutes, writes this very line while Koloft was
  // running fine — and "not running" sends the person hunting for a crash.
  if (h.state === 'missed') {
    return n > 1
      ? `Missed ${n} times — Koloft was closed or asleep`
      : 'Missed — Koloft was closed or asleep'
  }
  return n > 1
    ? `Skipped ${n} times — the last run was still open`
    : 'Skipped — the last run was still open'
}

/** When a row happened. A folded row covers a stretch of time, so it names both ends —
 *  otherwise ten skips all read as having happened at the first one's minute, which is
 *  the very thing `until` is written down for. */
export function histWhen(h: HistoryLine, now: Date): string {
  const from = describeWhen(new Date(h.dueAt), now)
  if (h.until === undefined || h.until <= h.dueAt) return from
  return `${from} → ${describeWhen(new Date(h.until), now)}`
}

/** The NEWEST moment a row stands for — what the card means by "last run". For a folded
 *  row that is the far end: a nap of 85 missed dues must not report the minute the nap
 *  began as the last thing that happened. */
export function histEnd(h: HistoryLine): number {
  return h.until !== undefined && h.until > h.dueAt ? h.until : h.dueAt
}

/** How near a run has to be for the sidebar's forecast row to call it soon. */
const SOON_MS = 60 * 60_000

/** Everything the sidebar's forecast row says. */
export interface Forecast {
  /** the job that runs next — the row names it, and a click opens its card */
  id: string
  name: string
  /** how many OTHER switched-on jobs the workspace has; 0 means this is the only one */
  more: number
  at: Date
  /** the run is an hour away or less, so the row says the time in the accent colour */
  soon: boolean
  /** the hover text: every switched-on job, nearest first, then the door's own words */
  title: string
}

/** What the workspace's session list says above its rows: when the next switched-on
 *  job runs. Null when nothing is switched on — the row is then not there.
 *
 *  It is one row and not a badge on the workspace head because the head is already
 *  full (name, the git mark, the hover button) and a narrow sidebar was eating
 *  the folder name. */
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
