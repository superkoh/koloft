import type { CronJob, HistoryLine, LiveRun } from '@shared/types'
import { describeSchedule, describeWhen, nextRun, onceAt, stepMs } from '@shared/schedule'

export function oncePassed(job: CronJob, now: Date): boolean {
  return job.schedule.kind === 'once' && onceAt(job.schedule).getTime() <= now.getTime()
}

export function afterDueAt(job: CronJob, s: Parameters<typeof stepMs>[0]): number {
  return (job.waitFrom ?? job.createdAt) + stepMs(s)
}

export function nextDue(job: CronJob, now: Date, live: LiveRun[]): Date | null {
  if (!job.enabled) return null
  const s = job.schedule
  if (s.kind !== 'after') return nextRun(s, now)
  if (liveOf(live, job.id)) return null
  return new Date(Math.max(afterDueAt(job, s), now.getTime()))
}

export function nextWords(job: CronJob, now: Date, live: LiveRun[]): string {
  if (oncePassed(job, now)) return 'time passed'
  if (!job.enabled) return 'off'
  const next = nextDue(job, now, live)
  return next ? `next ${describeWhen(next, now)}` : 'waits for the open run to end'
}

export function whenLine(job: CronJob, now: Date, live: LiveRun[]): string {
  return `${describeSchedule(job.schedule)} · ${nextWords(job, now, live)}`
}

export function histText(h: HistoryLine): string {
  const base = histBase(h)
  return h.note ? `${base} — ${h.note}` : base
}

function histBase(h: HistoryLine): string {
  if (h.state === 'closed') return 'Closed by you'
  if (h.state === 'finished') return 'Done — closed itself'
  if (h.state === 'ended') return 'Ended — Koloft quit'
  if (h.state === 'failed') return 'Could not start'
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

export function histFolder(h: HistoryLine): string {
  if (h.removed) return 'folder removed'
  return h.kept ? `folder kept: ${h.kept}` : ''
}

export function histWhen(h: HistoryLine, now: Date): string {
  const from = describeWhen(new Date(h.dueAt), now)
  if (h.until === undefined || h.until <= h.dueAt) return from
  return `${from} → ${describeWhen(new Date(h.until), now)}`
}

export function histEnd(h: HistoryLine): number {
  return h.until !== undefined && h.until > h.dueAt ? h.until : h.dueAt
}

export const LIVE_WORDS: Record<LiveRun['state'], string> = {
  queued: 'queued — waiting for the machine',
  launching: 'starting',
  running: 'working',
  done: 'done — waiting for you'
}

export const HIST_WORDS: Record<HistoryLine['state'], string> = {
  closed: 'closed by you',
  finished: 'done — closed itself',
  ended: 'ended — Koloft quit',
  failed: 'could not start',
  skipped: 'skipped',
  missed: 'missed'
}

export function liveOf(live: LiveRun[], jobId: string): LiveRun | undefined {
  return live.find((l) => l.jobId === jobId)
}

export function lastRunOf(
  job: CronJob,
  live: LiveRun[],
  now: Date
): { lead: string; words: string; done: boolean } | null {
  const run = liveOf(live, job.id)
  const h: HistoryLine | undefined = job.history[0]
  const hAt = h ? histEnd(h) : 0
  const lead = (dueAt: number): string => `last run ${describeWhen(new Date(dueAt), now)} · `
  if (run && (!h || run.dueAt >= hAt)) {
    return { lead: lead(run.dueAt), words: LIVE_WORDS[run.state], done: run.state === 'done' }
  }
  return h ? { lead: lead(hAt), words: HIST_WORDS[h.state], done: h.state === 'finished' } : null
}
