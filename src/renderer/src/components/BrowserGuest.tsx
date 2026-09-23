import { createElement, useEffect, useRef, type JSX } from 'react'
import { BROWSER_PARTITION } from '@shared/types'

/** The subset of Electron's <webview> the surface drives. Typed locally so the renderer
 *  needn't depend on electron's types (same convention as FilePane's WebviewEl). */
export type GuestElement = HTMLElement & {
  loadURL(url: string): Promise<void>
  getURL(): string
  reload(): void
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  /** whether a load is in flight — a mount only waits for one that is */
  isLoading(): boolean
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  /** the id main addresses this guest's own webContents by (devtools, D13) */
  getWebContentsId(): number
  findInPage(
    text: string,
    options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
  ): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  /** §07 #3: leaving fullscreen is the PAGE's api — Esc asks it to exit, so the page's
   *  own state and Koloft's stay in step (a Koloft-only exit would leave the page believing
   *  it is still fullscreen) */
  executeJavaScript(code: string): Promise<unknown>
}

export interface GuestFailure {
  code: number
  description: string
  url: string
}

/** a webview with no src never creates its guest, so `did-attach` never fires and the
 *  real url is never loaded; this is the cheapest src that attaches */
const BOOTSTRAP_SRC = 'about:blank'

export interface BrowserGuestProps {
  url: string
  /** false while another tab (or another session) holds the surface */
  visible: boolean
  onElement(el: GuestElement | null): void
  /** the guest exists and can name its own webContents — nothing before this can */
  onAttached(): void
  onLoading(loading: boolean): void
  onNavigate(url: string): void
  onTitle(title: string): void
  onFail(failure: GuestFailure): void
  onCrash(): void
  /** the page called window.close() — §05D-11: it closes its own tab, nothing else */
  onClose(): void
  /** S1: this guest is on the stage — visible (so it produces frames a capture can
   *  read) but painted BEHIND the pane's own background, where the user never sees it */
  staged?: boolean
}

/**
 * SEC-5/SEC-6 — THE guest factory. Every browser guest in Koloft is this one
 * createElement('webview') call: a guest created anywhere else would silently fall back
 * to the default session, where the privileged `koloft-file://` protocol lives. The
 * attribute set is locked (partition + sandbox, no preload, no disablewebsecurity).
 *
 * SEC-7 spike result: `allowpopups` must be ON. Without it Electron drops window.open in
 * the browser process before any window-open handler runs, so main's handler never fires
 * and a popup silently vanishes instead of becoming a tab. What keeps an OS window from
 * opening is that handler always answering `deny` and re-routing the url into a tab (D12),
 * not the absence of this attribute.
 *
 * The url is loaded on `did-attach` + a macrotask (#31918: methods called on a webview
 * before its guest is attached are silently lost), not through the `src` attribute, so
 * a Retry / crash reload / cert proceed can re-issue the same url through one path.
 */
export function BrowserGuest({
  url,
  visible,
  staged,
  onElement,
  onAttached,
  onLoading,
  onNavigate,
  onTitle,
  onFail,
  onCrash,
  onClose
}: BrowserGuestProps): JSX.Element {
  const ref = useRef<GuestElement | null>(null)
  // read through refs: the listeners below are attached once per mount, and rebinding
  // them on every render would drop events fired in between
  const cb = useRef({ onAttached, onLoading, onNavigate, onTitle, onFail, onCrash, onClose })
  cb.current = { onAttached, onLoading, onNavigate, onTitle, onFail, onCrash, onClose }
  const target = useRef(url)
  target.current = url
  /** a load the element refused before it could name its guest, owed to `dom-ready` */
  const waiting = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    onElement(el)

    const load = (): void => {
      // the bootstrap src IS about:blank, so a tab whose target is about:blank is
      // already there. Loading it a second time is a second navigation, and a client
      // that took the page between the two is left holding a frame that gets detached
      // out from under it ("Frame has been detached" — measured with a real CDP client).
      if (target.current === BOOTSTRAP_SRC) return
      try {
        void el.loadURL(target.current).catch(() => {
          /* a load rejected at the API boundary still reports through did-fail-load */
        })
      } catch {
        // #31918's other half, and the reason `did-attach` is not enough: for a few ms
        // after it the element still cannot name its guest, and every method on it THROWS
        // — synchronously, so no rejection and no did-fail-load ever says so. A load lost
        // here leaves the tab on `about:blank` for good (measured: ~1 mount in 3). The
        // event the message itself names is the one to wait for.
        waiting.current = true
      }
    }
    const onAttach = (): void => {
      // R5/BB-N03 (the mute) is main's, at web-contents-created — same reason.
      setTimeout(load, 0)
      cb.current.onAttached()
    }
    const onDomReady = (): void => {
      if (!waiting.current) return
      waiting.current = false
      load()
    }
    const onStart = (): void => cb.current.onLoading(true)
    const onStop = (): void => cb.current.onLoading(false)
    const onNav = (e: Event): void => {
      const url = (e as Event & { url: string }).url
      // the `src` below is an attach detail, not a page the tab is on: reporting its
      // navigation would overwrite the url the tab was just sent to, and the mount would
      // then load about:blank instead of it (the target is read at did-attach)
      if (url === BOOTSTRAP_SRC && target.current && target.current !== BOOTSTRAP_SRC) return
      cb.current.onNavigate(url)
    }
    const onTitleEv = (e: Event): void => cb.current.onTitle((e as Event & { title: string }).title)
    const onFailEv = (e: Event): void => {
      const f = e as Event & {
        errorCode: number
        errorDescription: string
        validatedURL: string
        isMainFrame: boolean
      }
      // a sub-resource that 404s is the page's business, not the surface's; and -3
      // (ABORTED) is what a Stop or a redirect away looks like
      if (!f.isMainFrame || f.errorCode === -3) return
      cb.current.onFail({
        code: f.errorCode,
        description: f.errorDescription,
        url: f.validatedURL || target.current
      })
    }
    const onGone = (): void => cb.current.onCrash()
    const onCloseEv = (): void => cb.current.onClose()

    el.addEventListener('did-attach', onAttach)
    el.addEventListener('dom-ready', onDomReady)
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('did-navigate-in-page', onNav)
    el.addEventListener('page-title-updated', onTitleEv)
    el.addEventListener('did-fail-load', onFailEv)
    el.addEventListener('render-process-gone', onGone)
    el.addEventListener('crashed', onGone)
    el.addEventListener('close', onCloseEv)
    return () => {
      el.removeEventListener('did-attach', onAttach)
      el.removeEventListener('dom-ready', onDomReady)
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-navigate', onNav)
      el.removeEventListener('did-navigate-in-page', onNav)
      el.removeEventListener('page-title-updated', onTitleEv)
      el.removeEventListener('did-fail-load', onFailEv)
      el.removeEventListener('render-process-gone', onGone)
      el.removeEventListener('crashed', onGone)
      el.removeEventListener('close', onCloseEv)
      onElement(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createElement('webview', {
    ref,
    className: 'bguest' + (staged ? ' staged' : ''),
    // the real url still goes through loadURL so the #31918 ordering guard keeps holding
    src: BOOTSTRAP_SRC,
    partition: BROWSER_PARTITION,
    // SEC-7: required for main's window-open handler to ever fire — see the note above
    allowpopups: true,
    // sandbox is the one preference a webview cannot inherit from the host
    webpreferences: 'sandbox=yes',
    // §05D-9: a network PDF renders in place through PDFium instead of costing the
    // user a download plus a trip outside Koloft
    plugins: true,
    // §07 #3 (B11): a page's fullscreen button. The guest is ALLOWED to go fullscreen;
    // what "fullscreen" means is Koloft's call — the pane fills the center row and the Koloft
    // window itself never enters macOS fullscreen, which would carry the user out of the
    // window this whole feature exists to keep them in.
    allowfullscreen: true,
    // R1 guardrail ①: a hidden guest is hidden with visibility, never display:none —
    // under #28677 display:none freezes rAF and wedges visibilityState, and the guest
    // must stay alive (D8) while another tab or session holds the surface. Left to
    // inherit when shown, so hiding the whole surface still hides every guest.
    style: { visibility: visible ? undefined : 'hidden' }
  })
}
