import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { LuArrowLeft, LuArrowUpRight, LuX } from 'react-icons/lu'
import { BrowserGuest, type GuestElement } from './BrowserGuest'
import { BrowserModal } from './BrowserModal'
import { useStore } from '../store'

const GUEST_ID_RETRY_MS = 50

export function BrowserOverlay({
  url,
  title,
  onClose
}: {
  url: string
  title?: string
  onClose: () => void
}): JSX.Element {
  const el = useRef<GuestElement | null>(null)
  const guestId = useRef<number | null>(null)
  const attached = useRef(false)
  const [pageTitle, setPageTitle] = useState('')
  const [current, setCurrent] = useState(url)
  const dialog = useStore((s) => s.overlayDialog)
  const setOverlayDialog = useStore((s) => s.setOverlayDialog)

  useEffect(() => {
    setCurrent(url)
    if (attached.current) {
      try {
        void el.current?.loadURL(url).catch(() => {})
      } catch {}
    }
  }, [url])

  // PLATFORM§8
  const register = useCallback((): void => {
    let id: number | undefined
    try {
      id = el.current?.getWebContentsId()
    } catch {
      setTimeout(register, GUEST_ID_RETRY_MS)
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

  const dialogIsThisGuests = dialog && dialog.guestId === guestId.current

  // PLATFORM§24 ADR-0013
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
        onClose={onClose}
      />
      {dialogIsThisGuests && dialog && (
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
