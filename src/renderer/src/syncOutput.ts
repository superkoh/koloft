import type { Terminal } from '@xterm/xterm'

type SyncModeCore = {
  _core?: { coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } } }
}

function syncModes(term: Terminal): { synchronizedOutput?: boolean } | undefined {
  return (term as unknown as SyncModeCore)._core?.coreService?.decPrivateModes
}

export function isSyncWindowOpen(term: Terminal): boolean {
  try {
    return syncModes(term)?.synchronizedOutput === true
  } catch {
    return false
  }
}

// PLATFORM§21 CC§12
export function exitSyncWindow(term: Terminal): void {
  try {
    const modes = syncModes(term)
    if (modes?.synchronizedOutput) modes.synchronizedOutput = false
  } catch {}
}
