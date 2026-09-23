import type { WorkspaceFreshness } from './types'

const FRESH_WINDOW_MS = 15 * 60_000

export function canPull(f: WorkspaceFreshness): boolean {
  return f.state === 'ok' && f.behind > 0 && f.ahead === 0 && !f.dirty && f.onDefault && !f.linked
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
  if (!f || f.state === 'none') return 'hidden'
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
