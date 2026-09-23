import type { CronJob } from '@shared/types'
import { nextRun } from '@shared/schedule'

/** Decides which scheduled jobs are due. Pure: no timers, no fs, no
 *  Electron — the runner owns the clock and calls `tick` on it.
 *
 *  Three rules live here, and each is a promise to the person who made the job:
 *
 *  - **The 5-minute window.** A due that is more than 5 minutes old is reported
 *    `missed` instead of started. Waking a Mac at lunchtime should not fire the
 *    07:00 job into a workspace nobody is watching; a run that starts is one the
 *    person could plausibly still want.
 *  - **Boot seeding.** At start-up every enabled job is seeded at
 *    `bootTime - 5 minutes`, not at `bootTime`. Seeding at boot would hide a due
 *    that landed while Koloft was starting; seeding 5 minutes back lets `tick` see
 *    it. Anything found before `bootTime` is reported `missed`, because Koloft was
 *    not running then and cannot honestly say it ran. Only the dues `tick`
 *    actually walks over get a line, so a week-long shutdown writes at most the
 *    handful inside that window — never one line per missed day.
 *
 *  One tick CAN return a great many dues: a Mac asleep from Friday to Monday with Koloft
 *  open leaves 2880 of them behind for an "every minute" job, and every one is real —
 *  the person's job truly did not run then. Reporting them is the runner's job, and it
 *  folds a tick's misses into ONE history line rather than writing the file 2880 times
 *  (`writeMissed`). Cutting the walk short here instead would be cheaper and wrong: a
 *  due six minutes old after a wake-up is exactly the one a person wants to see.
 *  - **An edit re-seeds with `now`.** Saving, enabling or disabling a job drops
 *    its seed, and the next `tick` sets it to the current time (step 1 below).
 *    So a schedule you just changed never replays the past: it starts from the
 *    moment you changed it.
 *
 *  A due is consumed the moment `tick` returns it — `lastDue` has already moved
 *  past it — so whatever verdict the runner reaches later, it can never fire again. */

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
      // new, edited or just switched on: start from here, replay nothing
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
      // a next run that does not move forward would spin this loop for ever
      if (after <= seen) break
      due = after
    }
  }

  return { fire, missed, lastDue: next }
}
