import { backendIdOf, capabilitiesFor } from '@shared/sessionBackend'
import { hostOf } from '@shared/remoteKey'
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

export function resumeFailureMessage(
  code: Extract<SessionResumeResult, { ok: false }>['code'],
  message?: string
): string {
  if (code === 'backend') return message || 'Resume failed'
  return code === 'cwd-missing' ? 'Folder is gone — cannot resume here' : 'Resume failed'
}

// ADR-0025
export function hasWorkbench(tab?: { kind: TabKind; cwd: string }): boolean {
  return (
    !!tab &&
    isSessionKind(tab.kind) &&
    capabilitiesFor(tab.kind, hostOf(tab.cwd)).workbench === true
  )
}
