import { canPull } from '@shared/freshnessOps'
import { shortenHome } from './browseModel'
import { pickerBehindNote } from './freshnessView'
import type { WorkspaceRows } from '@shared/types'
import { welcomeTarget } from './sessionRows'

export type PickerMode = 'main' | 'worktree'

export interface PickerRow {
  ws: WorkspaceRows
  digit: number | null
}

const LAST_DIGIT = 9

export function pickerRows(rows: WorkspaceRows[], mode: PickerMode): PickerRow[] {
  return rows
    .filter((w) => !w.workspace.missing && (mode === 'main' || w.workspace.isGit))
    .map((ws, i) => ({ ws, digit: i < LAST_DIGIT ? i + 1 : null }))
}

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

export function pullable(ws: WorkspaceRows): boolean {
  const f = ws.workspace.freshness
  return !!f && canPull(f)
}

export function skipPicker(rows: WorkspaceRows[], mode: PickerMode): boolean {
  const visible = pickerRows(rows, mode)
  if (visible.length !== 1) return false
  return mode === 'worktree' || !pullable(visible[0].ws)
}

export function digitPick(rows: PickerRow[], digit: number): number | null {
  const at = rows.findIndex((r) => r.digit === digit)
  return at < 0 ? null : at
}

export function rowNote(ws: WorkspaceRows, home: string, now: number): string {
  const { path, isGit, freshness } = ws.workspace
  const short = shortenHome(path, home)
  if (!isGit) return `no git · ${short}`
  const behind = pickerBehindNote(freshness, now)
  return behind ? `${behind} · ${short}` : short
}
