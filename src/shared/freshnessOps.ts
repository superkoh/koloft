import type { SessionInfo, WorkspaceFreshness, WorkspacePullSummary } from './types'
import { basename } from './preview'
import { statusUnavailable } from './sessionBackend'

const FRESH_WINDOW_MS = 15 * 60_000

export function freshnessShown(f: WorkspaceFreshness | null | undefined): f is WorkspaceFreshness {
  return !!f && f.state !== 'none'
}

export function canPull(f: WorkspaceFreshness): boolean {
  return f.state === 'ok' && f.behind > 0 && f.ahead === 0 && !f.dirty && f.onDefault && !f.linked
}

export function busyInCheckout(
  sessions: Pick<SessionInfo, 'alive' | 'remote' | 'treeRoot' | 'status' | 'details'>[],
  root: string
): number {
  return sessions.filter(
    (s) =>
      s.alive &&
      !s.remote &&
      s.treeRoot === root &&
      (s.status === 'working' || s.status === 'approval' || statusUnavailable(s))
  ).length
}

export function pullToast(wsPath: string, branch: string, s: WorkspacePullSummary): string {
  return `${basename(wsPath)} · ${branch}: fast-forwarded ${s.count} commit${
    s.count === 1 ? '' : 's'
  } (${s.from} → ${s.to})`
}

export type FreshLineState =
  'hidden' | 'checking' | 'ok' | 'stale-pullable' | 'stale-blocked' | 'offline'

export function freshLineState(
  f: WorkspaceFreshness | null | undefined,
  inFlight: boolean,
  choiceKind: 'main' | 'create' | 'existing',
  now: number
): FreshLineState {
  if (choiceKind === 'existing') return 'hidden'
  if (inFlight) return 'checking'
  if (!freshnessShown(f)) return 'hidden'
  if (f.state === 'error') return f.behind > 0 ? 'offline' : 'hidden'
  if (f.behind === 0) {
    return f.fetchedAt !== null && now - f.fetchedAt <= FRESH_WINDOW_MS ? 'ok' : 'hidden'
  }
  return canPull(f) ? 'stale-pullable' : 'stale-blocked'
}

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
