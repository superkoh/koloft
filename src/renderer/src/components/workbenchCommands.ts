import type { BrowserCommand } from '@shared/types'

/**
 * The commands the Workbench panel accepts from App.tsx's keyboard arbitration.
 *
 * They arrive as one signal object rather than as N callbacks for the reason the former
 * `BrowserCommandSignal` did: re-firing the SAME command has to be observable, so a
 * second ⌘R is a second reload rather than a no-op the props diff swallows. The nonce is
 * that observability.
 *
 * Why this is a separate module from the panel: `App.tsx` owns the arbitration (which
 * surface holds the focus) and the panel owns the execution, and neither should have to
 * import the other's component module to name a command.
 */

/** Everything the menu already forwards, minus the two app-level toggles it keeps for
 *  itself (⇧⌘B expands the panel, ⌘⏎ enters T3 — both are App's, not the panel's). */
type MenuCommand = Exclude<BrowserCommand, 'toggle-browser' | 'toggle-focus-mode'>

export type WorkbenchCommand =
  | MenuCommand
  /** ⌘F — FR-35. In-pane find on the ACTIVE tab, whichever kind it is: DOM find for
   *  `file`/`files`, the guest's `findInPage` for `web`, nothing for an image. */
  | 'find'
  /** ⌘⌥→ / ⌘⌥← — FR-53. Cycle in strip order, wrapping at both ends. */
  | 'cycle-next'
  | 'cycle-prev'
  /** ⌘⇧F — FR-45. Activate the `files` tab and drop the focus into its search box; a
   *  second press closes search and clears the query, wherever the focus sits. App has
   *  already expanded a collapsed panel to T2 by the time this arrives, so the panel
   *  only has to own the tab activation and the search toggle. */
  | 'find-files'
  /** ⌘S — file-edit B-16. Save the active tab's edit buffer. Fires whenever the panel
   *  has the focus, dirty or not: B-15 puts "nothing to save" here rather than on a
   *  greyed menu item, so the panel answers a clean buffer by doing nothing. */
  | 'save'
  /** Esc — FR-54's ladder, consumed by the first match: image zoom → find bar → menus →
   *  T3→T2. Never collapses to T1 and never closes a tab, so the panel answers it
   *  itself rather than App guessing which rung is live. */
  | 'escape'

/** one dispatched command; re-firing the same id bumps `nonce` */
export interface WorkbenchCommandSignal {
  id: WorkbenchCommand
  nonce: number
}

/**
 * FR-54 — what the Esc ladder actually consumed, reported back so App can take the last
 * rung. The panel owns the first three rungs (they are its own overlays); the T3→T2 rung
 * is App's layout state, so the panel says "nothing of mine was open" and App steps down.
 */
export type EscapeOutcome = 'consumed' | 'fell-through'
