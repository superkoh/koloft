import type { AccountKind, LoginProgress, SignInProgress } from '@shared/types'

export interface LoginFlowState {
  kind: AccountKind
  reauthName?: string
  progress: LoginProgress | null
}

const SAVED_BEAT_MS = 1200

export function loginClearDelay(p: LoginProgress): number | null {
  return p.phase === 'saved' ? SAVED_BEAT_MS : null
}

export function savedClearDue(cur: LoginFlowState | null, scheduledFor: LoginProgress): boolean {
  return cur?.progress === scheduledFor
}

export function progressOfTheOpenBox(
  box: LoginFlowState | null,
  news: SignInProgress | null
): LoginProgress | null {
  if (!box || !news || news.kind !== box.kind || news.phase === 'inATab') return null
  const { phase, name, url, tail, tab } = news
  return {
    phase,
    name,
    ...(url !== undefined && { url }),
    ...(tail !== undefined && { tail }),
    ...(tab && { tabId: tab.tabId, ...(tab.cwd !== undefined && { cwd: tab.cwd }) })
  }
}
