import type { LoginProgress } from '@shared/types'

/** The store's account-flow login slice: what the always-mounted App-level
 *  subscription writes and the Accounts pane renders (FR-06). */
export interface LoginFlowState {
  /** set when re-authenticating an existing row — the name is fixed */
  reauthName?: string
  progress: LoginProgress | null
}

/** FR-06 terminal-phase rules: only `saved` auto-clears (after its 1.2s beat);
 *  `failed` persists until the user acknowledges, everything else stays live. */
export function loginClearDelay(p: LoginProgress): number | null {
  return p.phase === 'saved' ? 1200 : null
}

/** Guard for the scheduled saved-clear: by the time the timer fires the user may
 *  have started a new login — clear only if the slice still holds the exact
 *  progress the timer was scheduled for. */
export function savedClearDue(cur: LoginFlowState | null, scheduledFor: LoginProgress): boolean {
  return cur?.progress === scheduledFor
}
