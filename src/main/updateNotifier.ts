import { app } from 'electron'
import type { UpdateCheckResult } from '@shared/types'
import { checkForUpdates, fixturePath } from './updater'

const FIRST_CHECK_AFTER_LAUNCH_BURST_MS = 30_000
// PLATFORM§32
const INTERVAL_MS = 6 * 60 * 60 * 1000
const FIXTURE_TICK_MS = 500

let current: UpdateCheckResult | null = null

export function currentOffer(): UpdateCheckResult | null {
  return current
}

export function startUpdateNotifier(send: (offer: UpdateCheckResult | null) => void): void {
  const fixture = fixturePath()
  if (!app.isPackaged && !fixture) return
  const tick = async (): Promise<void> => {
    try {
      const r = await checkForUpdates()
      current = r.status === 'current' ? null : r
      send(current)
    } catch {}
  }
  setTimeout(() => void tick(), fixture ? 0 : FIRST_CHECK_AFTER_LAUNCH_BURST_MS)
  setInterval(() => void tick(), fixture ? FIXTURE_TICK_MS : INTERVAL_MS)
}
