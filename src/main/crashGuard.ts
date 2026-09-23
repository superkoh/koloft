/** M1: whether an automatic renderer reload after render-process-gone is
 *  still allowed — at most 2 auto-reloads per 30s window, so a renderer that crashes
 *  on boot can't reload forever. `recent` holds the timestamps of previous auto
 *  reloads (caller appends on each allowed reload). */
const WINDOW_MS = 30_000
const MAX_RELOADS = 2

export function allowCrashReload(recent: number[], now: number): boolean {
  return recent.filter((t) => now - t < WINDOW_MS).length < MAX_RELOADS
}
