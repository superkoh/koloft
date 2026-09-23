import { ageLabel, type FreshLineState } from '@shared/freshnessOps'
import type { SessionRow, WorkspaceFreshness, WorktreeInfo } from '@shared/types'
import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import { isValidWorktreeName } from '@shared/worktreeName'

// The worktree entrance's decisions (new-session-entrances design) §04), kept out
// of the component so the launch branches and the name rule are directly testable.

/** What C8 can act on: `existing` cds into a checkout, `create` hands a brand-new name
 *  to Claude. The main checkout is not among them — ⌘N launches it directly (D1). */
export type RunChoice =
  | ({ kind: 'existing' } & WorktreeInfo & { inUse: boolean })
  | { kind: 'create'; name: string }
  | { kind: 'recover'; recoveryResourceId: string }

/** What to spawn for a chosen row: `-w` is reserved for a genuinely new name, because
 *  it only addresses the `.claude/worktrees/` namespace — pointing it at an existing
 *  checkout elsewhere would create a second worktree of the same name (V2). */
export function resolveLaunch(
  choice: RunChoice,
  wsPath: string
): { cwd: string; worktree?: string; worktreeResourceId?: string } {
  if (choice.kind === 'create') return { cwd: wsPath, worktree: choice.name }
  if (choice.kind === 'recover')
    return { cwd: wsPath, worktreeResourceId: choice.recoveryResourceId }
  // a remote workspace's checkout dir is a path on the machine: it travels as a key
  const host = parseRemoteKey(wsPath)?.host
  return { cwd: host ? formatRemoteKey(host, choice.dir) : choice.dir }
}

/** Which layer Esc peels, outermost last — one ladder for every dialog that stacks the
 *  pull confirm, so the order the features agreed on lives in a single place. An
 *  in-flight pull swallows the key whole (D6: no cancel, no escape) and the stacked
 *  confirm goes before anything inside the dialog. Below that C8 has its own rungs:
 *  hot-in-list outranks the text it would otherwise clear (§04A). C10 has neither, so
 *  it closes on the first press it gets. */
export function escPeel(l: {
  locked: boolean
  confirmOpen: boolean
  /** C8 */
  inList?: boolean
  hasText?: boolean
}): 'none' | 'confirm' | 'list' | 'clear' | 'close' {
  if (l.locked) return 'none'
  if (l.confirmOpen) return 'confirm'
  if (l.inList) return 'list'
  return l.hasText ? 'clear' : 'close'
}

// ── C8 worktree dialog (new-session-entrances design) §04) ─────────────────
// The entrance answers "a worktree" before the dialog opens, so the field means one
// thing (a name) and ⏎ never has to guess (D5). The always-visible list under it is
// the visibility that replaces C7's "⏎ lands on the match" defence.

/** Where the keyboard is: the name field, or one row of the list (§04A). */
export type WtHot = { where: 'field' } | { where: 'list'; index: number }

/** What the primary button acts on, which is whatever hot points at. `reserved` and
 *  `invalid` are refusals that still say Create, so the disabled button keeps
 *  explaining itself (D12). */
export type WtAim =
  | { kind: 'none' }
  | { kind: 'create'; name: string }
  | { kind: 'open'; name: string; dir: string }
  | { kind: 'recover'; name: string; dir: string; recoveryResourceId: string }
  | { kind: 'reserved'; name: string }
  | { kind: 'invalid'; name: string }

/** D5: a name that does not exist yet creates — colliding with an existing prefix does
 *  not change that (the collision stays on screen in the list instead). An exact hit
 *  opens the checkout it names, matched case-insensitively like C7's. `main` is
 *  reserved: `claude -w main` would make a worktree whose name the root bucket already
 *  owns, and every count keyed by that name would then be ambiguous (§04A). A worktree
 *  that IS called `main` is still reachable — that path is a cd, not a `-w`. */
function existingWorktreeAim(w: WorktreeInfo): WtAim {
  return w.recoveryResourceId
    ? { kind: 'recover', name: w.name, dir: w.dir, recoveryResourceId: w.recoveryResourceId }
    : { kind: 'open', name: w.name, dir: w.dir }
}

export function worktreeBaseMode(aim: WtAim): 'existing' | 'create' {
  return aim.kind === 'open' || aim.kind === 'recover' ? 'existing' : 'create'
}

export function worktreeAim(worktrees: WorktreeInfo[], query: string, hot: WtHot): WtAim {
  if (hot.where === 'list') {
    const w = worktrees[hot.index]
    return w ? existingWorktreeAim(w) : { kind: 'none' }
  }
  const name = query.trim()
  if (!name) return { kind: 'none' }
  const hit = worktrees.find((w) => w.name.toLowerCase() === name.toLowerCase())
  if (hit) return existingWorktreeAim(hit)
  if (name.toLowerCase() === 'main') return { kind: 'reserved', name }
  return isValidWorktreeName(name) ? { kind: 'create', name } : { kind: 'invalid', name }
}

/** D6: most recently worked in, first — so "(⇧⌘N) ↓ ⏎" lands back where the user was.
 *  Activity comes from the pushed rows, i.e. the working set: a worktree whose sessions
 *  have all left it has none at all and tails the list by name (§04B boundary). */
export function sortWorktrees<T extends { name: string }>(worktrees: T[], rows: SessionRow[]): T[] {
  const activity = new Map<string, number>()
  for (const r of rows) {
    const seen = activity.get(r.worktree)
    if (seen === undefined || r.mtime > seen) activity.set(r.worktree, r.mtime)
  }
  return [...worktrees].sort((a, b) => {
    const am = activity.get(a.name)
    const bm = activity.get(b.name)
    if (am !== undefined && bm !== undefined) return bm - am
    if (am !== undefined) return -1
    if (bm !== undefined) return 1
    return a.name.localeCompare(b.name)
  })
}

/** D6: typing filters by dimming only. Removing or reordering rows would take the
 *  collision warning off screen exactly when it matters — while the colliding name is
 *  being typed. */
export function isDimmed(name: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  return q !== '' && !name.toLowerCase().includes(q)
}

/** §04A's key table: ↓ walks into the list and past the dimmed rows, ↑ walks back and
 *  falls out of the first lit one into the field. Neither key ever leaves hot on a
 *  dimmed row — the primary speaks for hot, and a dimmed row is not what was asked for. */
export function moveHot(hot: WtHot, names: string[], query: string, dir: 'down' | 'up'): WtHot {
  const lit = (i: number): boolean => !isDimmed(names[i], query)
  if (dir === 'down') {
    for (let i = hot.where === 'list' ? hot.index + 1 : 0; i < names.length; i++) {
      if (lit(i)) return { where: 'list', index: i }
    }
    return hot
  }
  if (hot.where === 'field') return hot
  for (let i = hot.index - 1; i >= 0; i--) {
    if (lit(i)) return { where: 'list', index: i }
  }
  return { where: 'field' }
}

// ── git freshness (workspace-git-pull design) §04 M4 / D6) ─────────────────

/** Where the dialog's own pull attempt stands. `failed` is a brake: the button goes
 *  back to Start and never morphs again, because a pull that just failed will fail
 *  again — starting on the current HEAD is the only honest option left (D6). */
export type PullPhase = 'idle' | 'pulling' | 'failed'

export type PrimaryKind = 'start' | 'pull' | 'pulling'

export function primaryKind(line: FreshLineState, phase: PullPhase): PrimaryKind {
  if (phase === 'pulling') return 'pulling'
  if (phase === 'failed') return 'start'
  return line === 'stale-pullable' ? 'pull' : 'start'
}

/** C8's primary spells the whole action out (D12), because in that dialog ⏎ is the
 *  only thing standing between a typed name and a new worktree: the verb follows hot,
 *  the name is the one that will be acted on, and a pullable base prefixes the pull.
 *  Without the context this is C7's own three-word button. */
export interface WtAction {
  verb: 'Create' | 'Open' | 'Recover'
  /** null before anything is typed — the verb still shows, the button is just off */
  name: string | null
  /** the ref an in-flight pull is fast-forwarding onto */
  ref?: string
}

export function primaryLabel(kind: PrimaryKind, wt?: WtAction, backend?: string): string {
  const named = (label: string): string => (backend ? `${label} · ${backend}` : label)
  if (!wt) {
    if (kind === 'pull') return named('Pull & Start')
    if (kind === 'pulling') return 'Pulling…'
    return named('Start')
  }
  if (kind === 'pulling') return wt.ref ? `Pulling ${wt.ref}…` : 'Pulling…'
  // Two method buttons plus Cancel have to share a 540px footer without wrapping, so a
  // named button carries only the verb — the field above and the hint line under it
  // already show the name, and the dialog's title says "worktree".
  const act = backend
    ? wt.verb
    : wt.name === null
      ? `${wt.verb} worktree`
      : `${wt.verb} worktree “${wt.name}”`
  return named(kind === 'pull' ? `Pull & ${act}` : act)
}

const commits = (n: number): string => `${n} commit${n === 1 ? '' : 's'}`

/** Priority follows the popover's (§04 M2): linked worktree, non-default branch,
 *  then dirty tree, then divergence — offline is a state of its own, never a blocked
 *  reason. */
function blockedReason(f: WorkspaceFreshness): string {
  if (f.linked)
    return "this workspace is a linked worktree; Koloft only pulls a main checkout's default branch."
  if (!f.onDefault) return 'Koloft only pulls the default branch.'
  if (f.dirty) return 'working tree has local changes; Koloft only pulls into a clean tree.'
  return `local commits diverge from ${f.defRef}; merge or rebase outside Koloft.`
}

/** The freshness line's wording, split at the bold clause. Every number it shows
 *  carries its fetch age — a stale comparison must never read as authoritative
 *  (D10) — and "never fetched" is said out loud rather than left blank when no fetch
 *  ever landed. `null` for the states that paint no line (hidden) or a fixed busy one. */
export function freshLineCopy(
  line: FreshLineState,
  f: WorkspaceFreshness,
  now: number
): { strong: string; rest: string } | null {
  const age = f.fetchedAt === null ? null : ageLabel(f.fetchedAt, now)
  const behind = `${f.branch} is ${commits(f.behind)} behind ${f.defRef}`
  if (line === 'ok') {
    return {
      strong: `${f.branch} is up to date`,
      rest: age ? ` — fetched ${age}.` : ' — never fetched.'
    }
  }
  if (line === 'stale-pullable') {
    return {
      strong: behind,
      rest: `${age ? ` (fetched ${age})` : ' (never fetched)'} — Pull & Start will fast-forward first.`
    }
  }
  if (line === 'stale-blocked') {
    return {
      strong: behind,
      rest: ` — ${blockedReason(f)} Start uses the current HEAD.`
    }
  }
  if (line === 'offline') {
    return {
      strong: behind,
      rest: `${
        age ? ` (last fetch ${age})` : ' (never fetched)'
      } — can't reach origin. Start uses the current HEAD.`
    }
  }
  return null
}

/** git's own last fatal/error line already ends in a period; a Koloft-side reason
 *  ('state changed') does not, and the hint sentence continues after it. */
export function pullFailedReason(reason: string): string {
  const r = reason.trim()
  return r.endsWith('.') ? r : r + '.'
}

/** The D4 guard's number: Koloft sessions the pull would change files under. Only the
 *  root bucket — worktree sessions have their own checkouts. */
export function mainRunningCount(rows: SessionRow[]): number {
  return rows.filter((r) => (r.running || r.pending) && r.worktree === 'main').length
}
