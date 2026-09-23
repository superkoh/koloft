const AUTO_RELOAD_WINDOW_MS = 30_000
const MAX_AUTO_RELOADS_PER_WINDOW = 2

export function allowCrashReload(recent: number[], now: number): boolean {
  return recent.filter((t) => now - t < AUTO_RELOAD_WINDOW_MS).length < MAX_AUTO_RELOADS_PER_WINDOW
}
