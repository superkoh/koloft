/**
 * the one decision a CDP client's mount cannot get wrong: which
 * `did-stop-loading` is the one it has been waiting for.
 *
 * A fresh guest boots on `about:blank` and only then loads its real url (BrowserGuest's
 * #31918 ordering guard). On the happy path Chromium folds the two together, so the only
 * stop the surface ever sees is the real page's. It is the other path this exists for:
 * when the first `loadURL` throws (~1 mount in 3, measured) the real load is re-issued at
 * `dom-ready`, and about:blank's own stop arrives BEFORE it — 3 ms before, measured. Left
 * unfiltered that stop ends the mount, the client is handed the page ~170 ms before the
 * real one commits, and its first action on it dies with "Frame has been detached".
 *
 * The rule lives out here, away from the component, because the trigger cannot be asked
 * for: the throw is Electron's own timing, so a test built on it would pass two runs in
 * three whatever the code did. Out here it is a plain question with plain answers.
 */

/** the src every guest attaches on — BrowserGuest's BOOTSTRAP_SRC */
const BLANK = 'about:blank'

export interface StopEvidence {
  /** where the guest says it is right now (`getURL()`) */
  guestUrl: string
  /** where the tab has been sent — its pending url, else the url it holds */
  targetUrl: string
  /** whether the guest still has a load in flight (`isLoading()`) */
  isLoading: boolean
}

/**
 * Whether this stop ends the mount's wait. Two ways for it to be the wrong stop:
 *  - the guest still has a load in flight — the real one is already going, and this stop
 *    belongs to the boot page it is about to replace;
 *  - the guest is still sitting on the boot page while the tab was sent somewhere else —
 *    the re-issued load has been asked for but has not started.
 * Anything else is the page the client asked for. A tab whose target IS about:blank (a
 * `newPage()` with no url) is already there when the boot page stops, and settles here —
 * as does one with no url at all, which is the same tab.
 *
 * Nothing here is a deadline: the mount's own grace period still covers a page that
 * never stops loading at all, so a wrong "no" costs latency, never the mount.
 */
export function stopEndsMount({ guestUrl, targetUrl, isLoading }: StopEvidence): boolean {
  if (isLoading) return false
  const target = targetUrl || BLANK
  if (target === BLANK) return true
  return guestUrl !== BLANK && guestUrl !== ''
}
