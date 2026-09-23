import type { WorkspaceFreshness } from './types'

// Pure eligibility rules for the git-freshness feature
// (workspace-git-pull design) §04/§05). Shared so the sidebar popover, the
// C7 dialog and the main-side pull pre-check all judge the same measurement the
// same way — main re-checks the live repo before it execs, this only drives UX.

/** A green "up to date" line is only honest while the fetch behind it is recent —
 *  a stale Tier-1 comparison must never read as up to date (D6/D10). */
const FRESH_WINDOW_MS = 15 * 60_000

/** The one shape Koloft's single write hand touches: a clean MAIN checkout sitting on
 *  the default branch, purely behind it (D3/D5 — a linked worktree is explained,
 *  never pulled). */
export function canPull(f: WorkspaceFreshness): boolean {
  return f.state === 'ok' && f.behind > 0 && f.ahead === 0 && !f.dirty && f.onDefault && !f.linked
}

/** The C7 freshness line's six states (§04 M4). `checking` is the renderer's own
 *  in-flight fetch — it never travels in the pushed data. */
export type FreshLineState =
  'hidden' | 'checking' | 'ok' | 'stale-pullable' | 'stale-blocked' | 'offline'

/** `choiceKind`: which "Run in" option is selected — `main` and `create` both fork
 *  from the root HEAD, an existing worktree does not, so it gets no line at all. */
export function freshLineState(
  f: WorkspaceFreshness | null | undefined,
  inFlight: boolean,
  choiceKind: 'main' | 'create' | 'existing',
  now: number
): FreshLineState {
  if (choiceKind === 'existing') return 'hidden'
  if (inFlight) return 'checking'
  if (!f || f.state === 'none') return 'hidden'
  if (f.state === 'error') return f.behind > 0 ? 'offline' : 'hidden'
  if (f.behind === 0) {
    return f.fetchedAt !== null && now - f.fetchedAt <= FRESH_WINDOW_MS ? 'ok' : 'hidden'
  }
  return canPull(f) ? 'stale-pullable' : 'stale-blocked'
}

/** Age of a timestamp, as the popover/C7 line words it. Every freshness number the
 *  UI shows carries one — the user judges the number by how old it is. */
export function ageLabel(ms: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - ms) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
