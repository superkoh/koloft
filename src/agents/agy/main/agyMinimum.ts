import { ensureMinimumFn } from '../../../main/cliMinimums'
import { AGY_INSTALLER_URL } from '../shared/agyInstaller'

// AGY§3
export const MIN_AGY_VERSION = '1.4.0'
export const TESTED_AGY_LINE = '1.4'

export const AGY_UPDATE_TIMEOUT_MS = 5 * 60_000

// AGY§3
export const ENSURE_AGY_MINIMUM_FN = ensureMinimumFn({
  tool: 'agy',
  product: 'Antigravity CLI',
  min: MIN_AGY_VERSION,
  update: `if command -v timeout >/dev/null 2>&1; then timeout ${AGY_UPDATE_TIMEOUT_MS / 1000} "$1" update; else "$1" update; fi`,
  byHand: `Run "agy update" there as a user who can write the folder agy is in, or install agy for yourself with "curl -fsSL ${AGY_INSTALLER_URL} | bash"`
})
