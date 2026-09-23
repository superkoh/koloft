import type { Terminal } from '@xterm/xterm'

type SyncModeCore = {
  _core?: { coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } } }
}

// PLATFORM§21 CC§12
export function exitSyncWindow(term: Terminal): void {
  try {
    const modes = (term as unknown as SyncModeCore)._core?.coreService?.decPrivateModes
    if (modes?.synchronizedOutput) modes.synchronizedOutput = false
  } catch {}
}
