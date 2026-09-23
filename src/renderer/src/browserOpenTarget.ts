import type { SessionInfo } from '@shared/types'

/**
 * Which session an inbound `browser:open` should land in.
 *
 * - The tab the request names, when that tab is a session with a sessionId (D3: an
 *   open resolves to the session that owns the tab, not whatever is on screen).
 * - Otherwise, for a `'user'`-sourced open only (an extension's `chrome.tabs.create` or
 *   the Web Store button — neither of which names a tab at all), the fallback is a LIVE
 *   session, preferring the one the user is actually looking at. An `open` typed in a
 *   terminal tab's shell does NOT reach the fallback: R12 maps its pty to the
 *   conversation tab that owns the shell before the request gets here, so it matches a
 *   bound tab on the first line. A dead session's strip cannot mint a guest, so its
 *   tab would hang the caller on the report timeout: never a dead one.
 * - An `'agent'` open gets no fallback: it keeps its own-tab semantics (D1).
 *
 * `undefined` means there is nowhere to land — the caller drops the request.
 */
export function browserOpenTargetSession(
  sessions: SessionInfo[],
  request: { tabId: string; source: 'agent' | 'user' },
  activeTabId?: string | null
): SessionInfo | undefined {
  const bound = sessions.find((s) => s.tabId === request.tabId && s.sessionId)
  if (bound || request.source !== 'user') return bound
  const live = (s: SessionInfo): boolean => !!(s.alive && s.sessionId)
  return sessions.find((s) => s.tabId === activeTabId && live(s)) ?? sessions.find(live)
}

/**
 * R1 — HOW a landing on the global overlay is presented, which is a
 * different question from the routing table's `source`. That tag is a security label
 * (SEC-14: whatever a session tab's process fires is judged as an agent's), and the
 * split here is "did the user just do this themselves":
 *
 *  - the tab that fired it is still open and is NOT a session — the global terminal or
 *    a plain shell, where the only thing that can type `open` is the user — so the page
 *    is what they just asked for: show it at once.
 *  - anything else — a session tab (an agent's own request) or a tab that has already
 *    closed (the late `open` of a background process) — lands in the background with a
 *    toast and an unread mark, so no surface is ever forced open behind the user's back.
 */
export function overlayPresentation(
  request: { tabId: string },
  /** every tab that still exists — the strip's AND the global terminal island's shells,
   *  which are the very case this rule is named for and live in their own list */
  tabs: { id: string }[],
  sessions: SessionInfo[]
): 'now' | 'background' {
  const stillOpen = tabs.some((t) => t.id === request.tabId)
  const isSession = sessions.some((s) => s.tabId === request.tabId)
  return stillOpen && !isSession ? 'now' : 'background'
}
