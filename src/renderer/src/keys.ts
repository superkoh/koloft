import type { KeyboardEvent } from 'react'

const CHROMIUM_IME_COMPOSING_KEYCODE = 229

export function keepCaretInSessionTerminal(e: { preventDefault(): void }): void {
  if (document.activeElement?.closest('.term-island .xterm')) e.preventDefault()
}

export function isComposing(e: KeyboardEvent<HTMLElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === CHROMIUM_IME_COMPOSING_KEYCODE
}
