import type { CronJob } from '@shared/types'
import { nextRun } from '@shared/schedule'

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

export function tick(
  jobs: CronJob[],
  now: number,
  lastDue: Map<string, number>,
  bootTime: number
): { fire: Due[]; missed: Due[]; lastDue: Map<string, number> } {
  const next = new Map(lastDue)
  const fire: Due[] = []
  const missed: Due[] = []

  for (const job of jobs) {
    if (!job.enabled) continue
    let seen = next.get(job.id)
    if (seen === undefined) {
      next.set(job.id, now)
      continue
    }
    let due = nextRun(job.schedule, new Date(seen)).getTime()
    while (due <= now) {
      if (due < bootTime || now - due > MISS_WINDOW_MS) missed.push({ jobId: job.id, dueAt: due })
      else fire.push({ jobId: job.id, dueAt: due })
      next.set(job.id, due)
      seen = due
      const after = nextRun(job.schedule, new Date(due)).getTime()
      if (after <= seen) break
      due = after
    }
  }

  return { fire, missed, lastDue: next }
}
