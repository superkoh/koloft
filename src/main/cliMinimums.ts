import { AGY_INSTALLER_URL } from './toolInstall'

// CC§16 CODEX§7
export const MIN_CLAUDE_VERSION = '2.1.293'
export const MIN_CODEX_VERSION = '0.161.0'
export const TESTED_CODEX_LINE = '0.166'
// MUSE§1
export const MIN_MUSE_VERSION = '1.4.7'
export const TESTED_MUSE_LINE = '1.4'
// AGY§3
export const MIN_AGY_VERSION = '1.4.0'
export const TESTED_AGY_LINE = '1.4'

function ensureMinimumFn(s: {
  tool: string
  product: string
  min: string
  update: string
  byHand: string
}): string {
  return `${s.tool}_meets_minimum() {
  kmin_v="$("$1" --version 2>/dev/null | sed -n '1s/^[^0-9]*\\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\).*/\\1/p')"
  [ -z "$kmin_v" ] && return 0
  awk -v a="$kmin_v" -v b="${s.min}" 'BEGIN { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) if (x[i] + 0 != y[i] + 0) exit (x[i] + 0 < y[i] + 0); exit 0 }'
}
ensure_${s.tool}_minimum() {
  ${s.tool}_meets_minimum "$1" && return 0
  printf '[Koloft] ${s.product} %s is older than %s, the oldest this Koloft supports. Updating it now...\\n' "$kmin_v" "${s.min}" >&2
  ${s.update}
  ${s.tool}_meets_minimum "$1" && return 0
  printf '[Koloft] ${s.product} is still older than %s. ${s.byHand}, then start the session again.\\n' "${s.min}" >&2
  return 1
}`
}

export const ENSURE_CLAUDE_MINIMUM_FN = ensureMinimumFn({
  tool: 'claude',
  product: 'Claude Code',
  min: MIN_CLAUDE_VERSION,
  update: '"$1" update',
  byHand: 'Run "claude update" yourself'
})

// MUSE§1 MUSE§14
export const ENSURE_MUSE_MINIMUM_FN = ensureMinimumFn({
  tool: 'muse',
  product: 'Muse Code',
  min: MIN_MUSE_VERSION,
  update: 'MUSE_SYNC_UPDATE=1 "$1" --version >/dev/null 2>&1',
  byHand: 'Run "muse --version" there with a working network'
})

export const AGY_UPDATE_TIMEOUT_MS = 5 * 60_000

// AGY§3
export const ENSURE_AGY_MINIMUM_FN = ensureMinimumFn({
  tool: 'agy',
  product: 'Antigravity CLI',
  min: MIN_AGY_VERSION,
  update: `if command -v timeout >/dev/null 2>&1; then timeout ${AGY_UPDATE_TIMEOUT_MS / 1000} "$1" update; else "$1" update; fi`,
  byHand: `Run "agy update" there as a user who can write the folder agy is in, or install agy for yourself with "curl -fsSL ${AGY_INSTALLER_URL} | bash"`
})
