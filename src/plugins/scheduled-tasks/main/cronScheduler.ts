import type { CronJob } from '@shared/types'
import { nextRun, onceAt } from '@shared/schedule'
import { afterDueAt } from '@shared/cronHistory'

export interface Due {
  jobId: string
  dueAt: number
}

export const MISS_WINDOW_MS = 5 * 60 * 1000
export const TICK_MS = 20 * 1000
export const WAKE_DELAY_MS = 30 * 1000

export function seedLastDue(jobs: CronJob[], bootTime: number): Map<string, number> {
  const m = new Map<string, number>()
  for (const j of jobs) if (j.enabled) m.set(j.id, bootTime - MISS_WINDOW_MS)
  return m
}

function isMissed(due: number, now: number, bootTime: number): boolean {
  return due < bootTime || now - due > MISS_WINDOW_MS
}

export function tick(
  jobs: CronJob[],
  now: number,
  lastDue: Map<string, number>,
  bootTime: number,
  busy: (jobId: string) => boolean = () => false
): { fire: Due[]; missed: Due[]; lastDue: Map<string, number> } {
  const next = new Map(lastDue)
  const fire: Due[] = []
  const missed: Due[] = []

  for (const job of jobs) {
    if (!job.enabled) continue
    const s = job.schedule
    if (s.kind === 'once') {
      const due = onceAt(s).getTime()
      if (due > now) continue
      if (isMissed(due, now, bootTime)) missed.push({ jobId: job.id, dueAt: due })
      else fire.push({ jobId: job.id, dueAt: due })
      continue
    }
    if (s.kind === 'after') {
      if (!busy(job.id) && afterDueAt(job, s) <= now) {
        fire.push({ jobId: job.id, dueAt: now })
      }
      continue
    }
    let seen = next.get(job.id)
    if (seen === undefined) {
      next.set(job.id, now)
      continue
    }
    let due = nextRun(s, new Date(seen))?.getTime()
    while (due !== undefined && due <= now) {
      if (isMissed(due, now, bootTime)) missed.push({ jobId: job.id, dueAt: due })
      else fire.push({ jobId: job.id, dueAt: due })
      next.set(job.id, due)
      seen = due
      const after = nextRun(s, new Date(due))?.getTime()
      if (after === undefined || after <= seen) break
      due = after
    }
  }

  return { fire, missed, lastDue: next }
}
