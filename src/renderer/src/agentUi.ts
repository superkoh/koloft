import { backendIdOf } from '@shared/sessionBackend'
import type { BackendId, SessionResumeResult, TabKind } from '@shared/types'

export type SessionBackend = BackendId

export function isSessionKind(kind?: TabKind | string): kind is BackendId {
  return backendIdOf(kind) !== undefined
}

// PLATFORM§6
const ELECTRON_INVOKE_ERROR_PREAMBLE = /^Error invoking remote method '[^']*': Error: /

export function ipcErrorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(ELECTRON_INVOKE_ERROR_PREAMBLE, '')
}

export function launchErrorMessage(e: unknown): string {
  return e instanceof Error ? ipcErrorText(e) : 'Could not start session.'
}

export function resumeFailureMessage(res: Extract<SessionResumeResult, { ok: false }>): string {
  if (res.code === 'backend') return res.message || 'Resume failed'
  return res.code === 'cwd-missing' ? 'Folder is gone — cannot resume here' : 'Resume failed'
}

export function hasWorkbench(tab?: { kind: TabKind; cwd: string }): boolean {
  return !!tab && isSessionKind(tab.kind)
}
