import type { Terminal } from '@xterm/xterm'

/**
 * Swallow the XTVERSION query (CSI > q) so guest apps see no terminal-identity reply.
 *
 * xterm ≥ 6.1.0-beta answers it with "xterm.js(<version>)", and Claude Code keys its
 * fullscreen scroll engine on that exact reply: an "xterm.js" identity switches wheel
 * scrolling to a paced drain (2–3 lines per frame regardless of input velocity), where
 * "no reply" keeps the native profile that drains proportionally. Koloft hosts Claude Code
 * as its primary guest, so the terminal must stay unidentified — the same state every
 * xterm ≤ 6.0 build shipped in.
 *
 * Note: Claude Code also skips its DEC-2026 probe when TERM_PROGRAM=Apple_Terminal
 * (which Koloft sets); with this mask in place, removing that spoof would still leave the
 * probe skipped, because "no XTVERSION reply" is the other half of the same gate.
 */
export function suppressXtversionReply(term: Terminal): void {
  // Custom CSI handlers run before xterm's built-in one; returning true ends dispatch,
  // so the built-in XTVERSION responder never fires. Catches both CSI > 0 q and CSI > q.
  term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => true)
}
