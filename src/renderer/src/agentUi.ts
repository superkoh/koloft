import { BACKEND_LABEL, capabilitiesFor } from '@shared/sessionBackend'
import type { BackendId, HostId, TabKind } from '@shared/types'

export type SessionBackend = BackendId

export function backendLabel(backend: SessionBackend): string {
  return BACKEND_LABEL[backend]
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
export function hasWorkbench(tab?: { kind: TabKind; host: HostId }): boolean {
  return !!tab && isSessionKind(tab.kind) && capabilitiesFor(tab.kind, tab.host).workbench === true
}
