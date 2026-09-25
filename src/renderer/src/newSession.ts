import { ageLabel, type FreshLineState } from '@shared/freshnessOps'
import type { SessionRow, WorkspaceFreshness, WorktreeInfo } from '@shared/types'
import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import { isValidWorktreeName } from '@shared/worktreeName'

export type RunChoice =
  | ({ kind: 'existing' } & WorktreeInfo)
  | { kind: 'create'; name: string }
  | { kind: 'recover'; recoveryResourceId: string }

// CC§3
export function resolveLaunch(
  choice: RunChoice,
  wsPath: string
): { cwd: string; worktree?: string; worktreeResourceId?: string } {
  if (choice.kind === 'create') return { cwd: wsPath, worktree: choice.name }
  if (choice.kind === 'recover')
    return { cwd: wsPath, worktreeResourceId: choice.recoveryResourceId }
  const host = parseRemoteKey(wsPath)?.host
  return { cwd: host ? formatRemoteKey(host, choice.dir) : choice.dir }
}

export function escPeel(l: {
  locked: boolean
  confirmOpen: boolean
  inList?: boolean
  hasText?: boolean
}): 'none' | 'confirm' | 'list' | 'clear' | 'close' {
  if (l.locked) return 'none'
  if (l.confirmOpen) return 'confirm'
  if (l.inList) return 'list'
  return l.hasText ? 'clear' : 'close'
}

export type WtHot = { where: 'field' } | { where: 'list'; index: number }

export type WtAim =
  | { kind: 'none' }
  | { kind: 'create'; name: string }
  | { kind: 'open'; name: string; dir: string }
  | { kind: 'recover'; name: string; dir: string; recoveryResourceId: string }
  | { kind: 'reserved'; name: string }
  | { kind: 'invalid'; name: string }

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

export function isDimmed(name: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  return q !== '' && !name.toLowerCase().includes(q)
}

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

export type PullPhase = 'idle' | 'pulling' | 'failed'

export type PrimaryKind = 'start' | 'pull' | 'pulling'

export function primaryKind(line: FreshLineState, phase: PullPhase): PrimaryKind {
  if (phase === 'pulling') return 'pulling'
  if (phase === 'failed') return 'start'
  return line === 'stale-pullable' ? 'pull' : 'start'
}

export interface WtAction {
  verb: 'Create' | 'Open' | 'Recover'
  name: string | null
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
  const act = backend
    ? wt.verb
    : wt.name === null
      ? `${wt.verb} worktree`
      : `${wt.verb} worktree “${wt.name}”`
  return named(kind === 'pull' ? `Pull & ${act}` : act)
}

const commits = (n: number): string => `${n} commit${n === 1 ? '' : 's'}`

function blockedReason(f: WorkspaceFreshness): string {
  if (f.linked)
    return "this workspace is a linked worktree; Koloft only pulls a main checkout's default branch."
  if (!f.onDefault) return 'Koloft only pulls the default branch.'
  if (f.dirty) return 'working tree has local changes; Koloft only pulls into a clean tree.'
  return `local commits diverge from ${f.defRef}; merge or rebase outside Koloft.`
}

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

export function pullFailedReason(reason: string): string {
  const r = reason.trim()
  return r.endsWith('.') ? r : r + '.'
}

export function mainRunningCount(rows: SessionRow[]): number {
  return rows.filter((r) => (r.running || r.pending) && r.worktree === 'main').length
}

export function worktreeInUse(w: Pick<WorktreeInfo, 'name' | 'dir'>, rows: SessionRow[]): boolean {
  const nameIsAlsoRootLabel = w.name === 'main'
  return rows.some(
    (r) => r.running && r.worktree === w.name && (!nameIsAlsoRootLabel || r.cwd === w.dir)
  )
}
