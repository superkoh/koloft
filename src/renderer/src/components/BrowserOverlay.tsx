import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { LuArrowLeft, LuArrowUpRight, LuX } from 'react-icons/lu'
import { BrowserGuest, type GuestElement } from './BrowserGuest'
import { BrowserModal } from './BrowserModal'
import { useStore } from '../store'

/**
 * R1 — THE app-level browser surface: one page, three controls, owing
 * nothing to any session. It generalises the Chrome Web Store's own overlay (§04 of
 * browser-extensions, which is now just a caller): a page that has no session to land
 * in used to leave for macOS, and lands here instead, so nothing forces the user out of
 * the Koloft window.
 *
 * Deliberately not a browser: no tab strip, no editable address bar. It is a temporary
 * landing surface for pages the product itself produced — a link with nowhere to go,
 * the releases page — and every page it holds can still be handed on to the user's real
 * browser with ↗ (the escape hatch stays a choice, D15/SEC-4).
 *
 * Layered at z 110: over the Settings modal (100), under the extension ask (130), so an
 * install's confirm still lands on top of it (BB-67).
 */
export function BrowserOverlay({
  url,
  title,
  onClose
}: {
  url: string
  /** a fixed caption for a caller that owns its page (the Web Store); otherwise the
   *  page's own title is shown */
  title?: string
  onClose: () => void
}): JSX.Element {
  const el = useRef<GuestElement | null>(null)
  /** the webContents id main knows this guest by — held so the unmount can withdraw it */
  const guestId = useRef<number | null>(null)
  const attached = useRef(false)
  const [pageTitle, setPageTitle] = useState('')
  const [current, setCurrent] = useState(url)
  const dialog = useStore((s) => s.overlayDialog)
  const setOverlayDialog = useStore((s) => s.setOverlayDialog)

  // §02 "second landing": the page is REPLACED in place rather than the overlay being
  // rebuilt, so the guest's own history survives and Back returns to the page that was
  // replaced (BB-13). Before the guest attaches there is nothing to drive — BrowserGuest
  // reads the current target at attach time, so the new url is already the one it loads.
  useEffect(() => {
    setCurrent(url)
    if (attached.current) {
      try {
        void el.current?.loadURL(url).catch(() => {
          /* reported through did-fail-load like any other navigation */
        })
      } catch {
        /* #31918: for a few ms after did-attach the element cannot drive its guest —
           a second landing inside that window is lost (never seen) */
      }
    }
  }, [url])

  // #31918 (the same trap BrowserGuest's own load path is built around): for a few ms
  // after `did-attach` every method on the element THROWS synchronously — including
  // getWebContentsId. An id lost here is not cosmetic: main would then treat this page
  // as an ordinary strip guest, and its popups would land in some session's tab set —
  // the one thing R1 exists to prevent (found by BB-14, which caught exactly that).
  // (a retry that outlives the component finds `el` already null — BrowserGuest clears
  // it on unmount — and registers nothing)
  const register = useCallback((): void => {
    let id: number | undefined
    try {
      id = el.current?.getWebContentsId()
    } catch {
      setTimeout(register, 50)
      return
    }
    if (typeof id !== 'number') return
    guestId.current = id
    window.api.browser.setOverlayGuest(id, true)
  }, [])

  const onAttached = useCallback((): void => {
    attached.current = true
    register()
  }, [register])

  useEffect(() => {
    return () => {
      const id = guestId.current
      if (id !== null) window.api.browser.setOverlayGuest(id, false)
    }
  }, [])

  const back = useCallback((): void => el.current?.goBack(), [])
  const external = useCallback((): void => {
    window.api.browser.openExternal(current)
  }, [current])

  // the modal is drawn HERE rather than in the Browser pane (§02): the pane belongs to a
  // session and may not even be mounted, which would leave the asking page blocked for
  // good. Matched on the guest, so the Settings overlay and this one never both draw it.
  const mine = dialog && dialog.guestId === guestId.current

  // portal to <body>: rendered from inside the Settings modal (the Web Store caller), a
  // `fixed` box would be trapped by the modal's transformed box and shrink to its size
  // — a manual-test find from the store overlay this component generalises.
  return createPortal(
    <div className="wovl">
      <div className="wovl-head">
        <button className="mini" aria-label="Back" onClick={back}>
          <LuArrowLeft size={14} />
        </button>
        <b>{title ?? pageTitle ?? ''}</b>
        <button className="mini" aria-label="Open in system browser" onClick={external}>
          <LuArrowUpRight size={14} />
        </button>
        <button className="mini" aria-label="Close" onClick={onClose}>
          <LuX size={14} />
        </button>
      </div>
      <BrowserGuest
        url={url}
        visible
        onElement={(node) => {
          el.current = node
        }}
        onAttached={onAttached}
        onLoading={() => {}}
        onNavigate={setCurrent}
        onTitle={setPageTitle}
        onFail={() => {}}
        onCrash={() => {}}
        /* §05D-11: window.close() closes the surface the page is in — here, the overlay */
        onClose={onClose}
      />
      {mine && dialog && (
        <BrowserModal
          dialog={dialog}
          onAnswer={(id, answer) => {
            window.api.browser.answerJsDialog(id, answer)
            setOverlayDialog(null)
          }}
        />
      )}
    </div>,
    document.body
  )
}
