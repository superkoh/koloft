/**
 * file-edit B-26 — the latch that lets a SYNCHRONOUS `before-quit` ask an
 * ASYNCHRONOUS question.
 *
 * Electron hands `before-quit` one chance to say yes or no, right now. There is no way
 * to hold the quit open while a dialog is on screen, so quitting is split into three
 * passes over the same handler: block and ask, sit still while the question is up, then
 * let the second quit through once the answer arrives. This module is the whole
 * decision; `index.ts` owns the sending and the timer, because those are the parts that
 * need Electron.
 *
 * The clock arrives as an argument rather than being read here, so the one branch that
 * matters most — the renderer that never answers — is reachable without waiting five
 * real seconds for it.
 */

/**
 * How long a quit waits for the renderer to say anything at all before going ahead.
 *
 * This is NOT "how long the user has to decide". The renderer answers within a frame
 * either way: it approves, or it says it is taking the question (`reset`) and the
 * deadline stops applying. Silence past this window therefore means the renderer is
 * wedged — and a wedged renderer could not have written the file to disk anyway, so
 * holding the app open forever protects nothing and only strands the user.
 */
export const QUIT_ANSWER_GRACE_MS = 5000

/** What `before-quit` should do this time round. */
export type QuitDecision =
  /** let it through — approved, or the renderer never answered */
  | 'allow'
  /** first pass: block it and put the question up */
  | 'ask'
  /** blocked already and the question is still up — block again, ask nothing */
  | 'wait'

let approved = false
let askedAt: number | null = null
/** what is waiting on the renderer's answer — see `withApproval`. A plain ⌘Q has none. */
let pendingAction: (() => void) | null = null
/** how to unwind that action if the user says no (the installer's single-flight latch) */
let pendingDecline: (() => void) | null = null

export function quitDecision(now: number): QuitDecision {
  if (approved) return 'allow'
  if (askedAt === null) {
    askedAt = now
    return 'ask'
  }
  return now - askedAt >= QUIT_ANSWER_GRACE_MS ? 'allow' : 'wait'
}

/** The renderer says the quit may go ahead. The next pass allows it. */
export function approve(): void {
  approved = true
}

/** Put the question to the renderer; false when there is no renderer to ask. Injected so
 *  this module stays free of Electron, and so a test can answer for it. */
let askRenderer: () => boolean = () => false

export function setQuitAsk(fn: () => boolean): void {
  askRenderer = fn
}

/**
 * Run `action` only once the renderer agrees that ending the process is safe.
 *
 * `before-quit` cannot use this — it is synchronous and must answer now — but the two
 * paths that end the process on their OWN schedule can, and must. The updater spawns a
 * detached script that waits about thirty seconds for our PID and then replaces the app
 * bundle; Restart arms `app.relaunch()`. Both used to fire before the unsaved question
 * was asked, which turned "let me think about it" into a bundle swapped underneath a
 * running Koloft, and turned Cancel into a relaunch that stayed armed for the next quit.
 *
 * Returns whether the action already ran, so the caller knows if an answer is still
 * coming and a give-up timer is worth arming.
 *
 * `onDecline` unwinds what the caller latched on the way in. The installer needs it: its
 * single-flight flag is set before the download begins and THROWS on the next attempt, so
 * a cancel with no unwind would leave Install dead for the rest of the session.
 */
export function withApproval(
  action: () => void,
  now: number,
  onDecline?: () => void
): 'ran' | 'waiting' {
  if (approved) {
    action()
    return 'ran'
  }
  if (!askRenderer()) {
    // nobody to ask means no editor and so nothing unsaved
    approved = true
    action()
    return 'ran'
  }
  pendingAction = action
  pendingDecline = onDecline ?? null
  askedAt = now
  return 'waiting'
}

/**
 * The renderer approved. Run whatever was waiting on that answer, or `fallback` for a
 * plain quit that had no action of its own.
 *
 * The waiting action is taken BEFORE it runs: it ends the process, and leaving it armed
 * would let a later approval fire the installer a second time.
 */
export function approveAndRun(fallback: () => void): void {
  approved = true
  const run = pendingAction ?? fallback
  pendingAction = null
  pendingDecline = null
  run()
}

/**
 * The user said no. Nothing runs — not now, and not when some later quit is approved,
 * which is the whole reason a cancel cannot simply stay silent.
 */
export function declineQuit(): void {
  const unwind = pendingDecline
  pendingAction = null
  pendingDecline = null
  reset()
  unwind?.()
}

/**
 * Back to square one: no approval, no deadline running.
 *
 * Called when the renderer takes the question on itself — the user is now looking at a
 * dialog, and the silence deadline must not fire out from under them. A cancel goes
 * through `declineQuit` instead, which also unwinds whatever was waiting on the answer.
 */
export function reset(): void {
  approved = false
  askedAt = null
}
