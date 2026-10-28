import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

export const PICK_BUTTON_LABEL = 'Pick an element'
export const PICK_MSG_PAGE_NOT_SHOWN = 'The page is not showing — reload it first'
export const PICK_MSG_FAILED = 'Koloft could not read that element.'

export function useElementPick(
  pasteTab: string | null,
  guestId: () => number,
  pageKey: string | null,
  blocked: string | null,
  onReturnFocus: () => void
): { picking: boolean; togglePick: () => void } {
  const [picking, setPicking] = useState(false)
  const current = useRef<{ guest: number } | null>(null)
  const blockedNow = useRef(blocked)
  blockedNow.current = blocked

  const stop = useCallback((): void => {
    const held = current.current
    if (!held) return
    current.current = null
    setPicking(false)
    window.api.browser.stopPick(held.guest)
  }, [])

  const togglePick = useCallback((): void => {
    if (current.current) return stop()
    const guest = guestId()
    if (!guest || !pasteTab || blockedNow.current) return
    const held = { guest }
    current.current = held
    setPicking(true)
    void window.api.browser
      .pickElement(guest, pasteTab)
      .then(async (text) => {
        if (current.current !== held) return
        current.current = null
        setPicking(false)
        if (!text || blockedNow.current) return
        await window.api.terminal.paste(pasteTab, text)
        onReturnFocus()
      })
      .catch(() => {
        if (current.current === held) {
          current.current = null
          setPicking(false)
        }
        useStore.getState().showToast(PICK_MSG_FAILED)
      })
  }, [guestId, pasteTab, onReturnFocus, stop])

  useEffect(() => stop, [pageKey, pasteTab, stop])

  useEffect(() => {
    if (blocked) stop()
  }, [blocked, stop])

  useEffect(() => {
    if (!picking) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      stop()
    }
    const onDown = (e: MouseEvent): void => {
      const button = (e.target as Element | null)?.closest?.('button')
      if (button?.getAttribute('aria-label') !== PICK_BUTTON_LABEL) stop()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [picking, stop])

  return { picking, togglePick }
}
