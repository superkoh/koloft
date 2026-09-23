import { canPull } from '@shared/freshnessOps'
import { shortenHome } from './browseModel'
import { pickerBehindNote } from './freshnessView'
import type { WorkspaceRows } from '@shared/types'
import { welcomeTarget } from './sessionRows'

// C10, the mini workspace picker (new-session-entrances design) §03A, D13). The
// component draws these rows; everything that decides WHICH workspace a keystroke means
// lives here, because a digit is a promise about a row number.

export type PickerMode = 'main' | 'worktree'

/** One offered workspace. `digit` is the number the row prints and answers to — the
 *  tenth visible row and beyond print none, so the keys stay single-press (D13). */
export interface PickerRow {
  ws: WorkspaceRows
  digit: number | null
}

/** Highest row number a single keystroke can address. */
const LAST_DIGIT = 9

/** The rows a mode offers, in `workspaces[]` order (= the sidebar's). A vanished folder
 *  cannot host anything, so it is hidden in both modes; ⇧⌘N additionally hides what has
 *  no worktrees to speak of (D10). Digits follow what is left, never the pinned index. */
export function pickerRows(rows: WorkspaceRows[], mode: PickerMode): PickerRow[] {
  return rows
    .filter((w) => !w.workspace.missing && (mode === 'main' || w.workspace.isGit))
    .map((ws, i) => ({ ws, digit: i < LAST_DIGIT ? i + 1 : null }))
}

/**
 * Where the keyboard starts: the last-touched chain (A2), evaluated over the rows THIS
 * mode shows — so a last-touched workspace this mode hides falls through to the first
 * visible one instead of preselecting nothing.
 */
export function preselectIndex(
  rows: WorkspaceRows[],
  mode: PickerMode,
  lastPath: string | null
): number {
  const visible = pickerRows(rows, mode).map((r) => r.ws)
  const target = welcomeTarget(visible, lastPath)
  const at = target ? visible.indexOf(target) : -1
  return at < 0 ? 0 : at
}

/** D3: the one freshness state the ⌘N path acts on — everything else launches straight
 *  through (D14). Judged by the shared rule, on the resident measurement. */
export function pullable(ws: WorkspaceRows): boolean {
  const f = ws.workspace.freshness
  return !!f && canPull(f)
}

/**
 * Whether the picker gets out of the way entirely (§03A). One visible row leaves nothing
 * to choose — but in ⌘N mode confirming IS the launch, so a behind-and-pullable row keeps
 * the picker up as the D6a gate; in ⇧⌘N mode confirming only opens C8, which carries its
 * own gate, so it skips unconditionally.
 */
export function skipPicker(rows: WorkspaceRows[], mode: PickerMode): boolean {
  const visible = pickerRows(rows, mode)
  if (visible.length !== 1) return false
  return mode === 'worktree' || !pullable(visible[0].ws)
}

/** Which row a digit picks, or null when no row prints that digit — an unanswered digit
 *  leaves the picker exactly as it was. */
export function digitPick(rows: PickerRow[], digit: number): number | null {
  const at = rows.findIndex((r) => r.digit === digit)
  return at < 0 ? null : at
}

/** The row's note: the sidebar's own badge policy (via freshnessView, one home for
 *  the rules — review #9), then the short path (§03A). `behind n` / `no git` never
 *  apply at once, since a folder that is not a repo is never measured. */
export function rowNote(ws: WorkspaceRows, home: string, now: number): string {
  const { path, isGit, freshness } = ws.workspace
  const short = shortenHome(path, home)
  if (!isGit) return `no git · ${short}`
  const behind = pickerBehindNote(freshness, now)
  return behind ? `${behind} · ${short}` : short
}
