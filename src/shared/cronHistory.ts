import type { CronJob, HistoryLine, LiveRun } from '@shared/types'
import { describeSchedule, describeWhen, nextRun } from '@shared/schedule'

export function whenLine(job: CronJob, now: Date): string {
  const words = describeSchedule(job.schedule)
  if (!job.enabled) return `${words} · off`
  return `${words} · next ${describeWhen(nextRun(job.schedule, now), now)}`
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

export const LIVE_WORDS: Record<LiveRun['state'], string> = {
  launching: 'starting',
  running: 'working',
  done: 'done — waiting for you'
}

const HIST_WORDS: Record<HistoryLine['state'], string> = {
  closed: 'closed by you',
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
  return h ? { lead: lead(hAt), words: HIST_WORDS[h.state], done: false } : null
}
