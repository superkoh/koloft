import type { LoginProgress } from '@shared/types'

export interface LoginFlowState {
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
