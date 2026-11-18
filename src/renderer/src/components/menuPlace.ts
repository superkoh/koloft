import { useLayoutEffect } from 'react'

const MENU_W = 190
const MENU_ITEM_H = 31
export const MENU_PAD_H = 10

export function useDismissOnOutside(open: boolean, dismiss: (none: null) => void): void {
  // PLATFORM§25
  useLayoutEffect(() => {
    if (!open) return
    const close = (): void => dismiss(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, dismiss])
}

export function menuPosFor(el: HTMLElement, itemCount: number): { left: number; top: number } {
  const r = el.getBoundingClientRect()
  let left = r.right - 6
  if (left + MENU_W > window.innerWidth - 4) left = Math.max(4, r.left - MENU_W + 6)
  const estH = itemCount * MENU_ITEM_H + MENU_PAD_H
  const top = Math.min(r.top, Math.max(4, window.innerHeight - estH - 4))
  return { left, top }
}
