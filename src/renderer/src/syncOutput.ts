// Exit a DEC-2026 synchronized-output window before a resize repaint.
//
// xterm buffers every row refresh while mode 2026 is set (RenderService's
// SynchronizedOutputHandler), but RenderService.handleResize is not gated on it: the
// WebGL renderer reassigns `canvas.width` — wiping the drawing buffer on the spot —
// and the full refresh that should repaint it is swallowed until `?2026l` or the 1s
// safety timeout. (Introduced in 6.0; re-verified still unfixed in 6.1.0-beta.302,
// where handleResize → _fullRefresh → refreshRows still buffers under the mode —
// so this layer stays across the 6.1 upgrade.) Claude Code wraps every TUI frame in 2026h/l, so a fit landing
// inside a window shows up to a second of black terminal (the occasional black screen on drag
// release / aux layout changes; e2e: sync-output-resize.spec.ts).
//
// The mode is advisory — a terminal may drop out of it at will (xterm's own safety
// timeout does exactly that) — so the resize paths clear it first: the resize's own
// full refresh then flushes the buffered rows and repaints immediately. Worst case is
// one torn frame, and the pty resize is about to SIGWINCH the app into a full redraw
// anyway. The app re-arms the mode with its next 2026h.

import type { Terminal } from '@xterm/xterm'

type SyncModeCore = {
  _core?: { coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } } }
}

export function exitSyncWindow(term: Terminal): void {
  try {
    const modes = (term as unknown as SyncModeCore)._core?.coreService?.decPrivateModes
    if (modes?.synchronizedOutput) modes.synchronizedOutput = false
  } catch {
    /* _core shape changed across an xterm bump — degrade to the 1s safety timeout */
  }
}
