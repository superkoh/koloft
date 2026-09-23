import { SESSION_CAPABILITIES } from '@shared/sessionBackend'
import { isRemoteKey } from '@shared/remoteKey'
import type { BackendId, TabKind } from '@shared/types'

export type SessionBackend = BackendId

export function backendLabel(backend?: SessionBackend): string {
  return backend === 'codex' ? 'Codex' : 'Claude'
}

export function isSessionKind(kind?: TabKind | string): kind is BackendId {
  return kind === 'claude' || kind === 'codex'
}

// PLATFORM§6
const ELECTRON_INVOKE_ERROR_PREAMBLE = /^Error invoking remote method '[^']*': Error: /

export function launchErrorMessage(e: unknown): string {
  return e instanceof Error
    ? e.message.replace(ELECTRON_INVOKE_ERROR_PREAMBLE, '')
    : 'Could not start session.'
}

// ADR-0025
export function hasWorkbench(tab?: { kind: TabKind; cwd: string }): boolean {
  return (
    !!tab &&
    tab.kind !== 'shell' &&
    SESSION_CAPABILITIES[tab.kind].workbench &&
    !isRemoteKey(tab.cwd)
  )
}
