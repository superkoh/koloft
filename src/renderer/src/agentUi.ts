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

/** What a refused launch says on screen. Electron wraps every rejection from main in its
 *  own "Error invoking remote method" preamble, which is noise to the reader. */
export function launchErrorMessage(e: unknown): string {
  return e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']*': Error: /, '')
    : 'Could not start session.'
}

export function hasWorkbench(tab?: { kind: TabKind; cwd: string }): boolean {
  return (
    !!tab &&
    tab.kind !== 'shell' &&
    SESSION_CAPABILITIES[tab.kind].workbench &&
    !isRemoteKey(tab.cwd)
  )
}
