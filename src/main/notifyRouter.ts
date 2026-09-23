/**
 * Notification routing — the outlet matrix as one pure function so the whole
 * thing is unit-testable with no Electron. index.ts feeds it each freshly-raised
 * AttentionEvent and acts on the decision; the dock badge is handled separately (it
 * mirrors the pending COUNT on every change, not per-event).
 *
 * The matrix, for a raised event (the focused + active-tab case never reaches here —
 * it's suppressed in attention.ts before an event is raised):
 *   window focused                             → NOTHING: the user is at the app and
 *                                                the sidebar's status dot already says it
 *   window unfocused / minimized / other Space → OS notification
 *   background test launch (D8, hard rule)     → nothing at all; no OS-level outlet
 * A disabled category (D3) emits nothing at all. Sound is opt-in, approval-only, and
 * independent of focus — it is the channel for "your eyes aren't on the sidebar".
 *
 * The focused case used to raise an in-window toast. That outlet went out with the rest
 * of the in-app attention UI (roll-up / Needs-you strip / row badge): D4 already
 * conceded that the status dot alone suffices for the tab the user is watching, and
 * real use showed the same holds for the tabs they aren't. The sidebar has no collapse
 * and a min-width clamp, so "focused" does imply "the dot is on screen".
 */

import type { AttentionEvent, AttentionKind, Settings } from '@shared/types'

export interface RouteContext {
  /** the Koloft window is focused right now */
  windowFocused: boolean
  /** running under KOLOFT_TEST_BACKGROUND — no OS-level outlet may be used (D8) */
  backgroundTest: boolean
}

export interface RouteDecision {
  /** raise an OS Notification */
  os: boolean
  /** beep (shell.beep) */
  sound: boolean
}

const NONE: RouteDecision = { os: false, sound: false }

/** Is this event's category switched on? A disabled category is fully silent. */
function categoryEnabled(kind: AttentionKind, s: Settings): boolean {
  switch (kind) {
    case 'turn-done':
      return s.notifyTurnDone
    case 'approval':
      return s.notifyApproval
    case 'exited':
      return s.notifyExited
  }
}

/** What the Dock badge should read for a pending count — or null for "don't touch the
 *  Dock at all" (D8: a background test launch must never alter the real user's Dock).
 *  '' clears the badge: both "disabled" and "nothing pending" must actively clear,
 *  or a stale count would outlive its markers / survive turning the setting off. */
export function dockBadgeText(
  pendingCount: number,
  dockBadgeEnabled: boolean,
  backgroundTest: boolean
): string | null {
  if (backgroundTest) return null
  if (!dockBadgeEnabled || pendingCount <= 0) return ''
  return String(pendingCount)
}

export function route(event: AttentionEvent, ctx: RouteContext, settings: Settings): RouteDecision {
  // a category the user turned off notifies through NO outlet (the pending set and the
  // dock badge are unaffected — those are wired independently upstream)
  if (!categoryEnabled(event.kind, settings)) return NONE
  // D8 hard rule: a hidden test window may never construct a Notification, touch the
  // Dock, or beep. With the in-window toast gone there is no outlet a background launch
  // could safely use, so it gets none — and the e2e observable is attention:list.
  if (ctx.backgroundTest) return NONE
  // sound is opt-in and approval-only — the one category worth a beep (D3). Unlike the
  // OS notification it does NOT depend on focus: it exists for the case where the user
  // is at the app but not looking at the sidebar.
  const sound = event.kind === 'approval' && settings.notifyApprovalSound
  // away → the dot can't reach them, so send an OS notification. At the app → the dot
  // is already on screen, and a banner on top of it is telling them twice.
  return { os: !ctx.windowFocused, sound }
}
