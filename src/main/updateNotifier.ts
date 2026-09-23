import { app } from 'electron'
import type { UpdateCheckResult } from '@shared/types'
import { checkForUpdates, fixturePath } from './updater'

// 30s: past the launch burst, before the user has settled into a session. 6h: Koloft
// stays open for days, and four anonymous GitHub API calls a day is nowhere near its
// 60/hour limit. Against the fixture (E2E) the ticks are fast enough for a spec to rewrite
// the file and watch the banner follow.
const FIRST_DELAY_MS = 30_000
const INTERVAL_MS = 6 * 60 * 60 * 1000
const FIXTURE_TICK_MS = 500

// Kept for the renderer to pull on mount: the first check can beat its listener, and a
// renderer reload loses the push anyway.
let current: UpdateCheckResult | null = null

export function currentOffer(): UpdateCheckResult | null {
  return current
}

/** Background update checks that feed the sidebar banner. Unpackaged runs have no Koloft
 *  bundle to compare against, so they only run against the fixture. */
export function startUpdateNotifier(send: (offer: UpdateCheckResult | null) => void): void {
  const fixture = fixturePath()
  if (!app.isPackaged && !fixture) return
  const tick = async (): Promise<void> => {
    try {
      const r = await checkForUpdates()
      current = r.status === 'current' ? null : r
      send(current)
    } catch {
      // offline / rate-limited / mid-install: the banner only ever reports a fact, never
      // an error — the manual check is where errors are shown. Wait for the next tick.
    }
  }
  setTimeout(() => void tick(), fixture ? 0 : FIRST_DELAY_MS)
  setInterval(() => void tick(), fixture ? FIXTURE_TICK_MS : INTERVAL_MS)
}
