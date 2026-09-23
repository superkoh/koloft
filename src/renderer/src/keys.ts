import type { KeyboardEvent } from 'react'

const CHROMIUM_IME_COMPOSING_KEYCODE = 229

export function isComposing(e: KeyboardEvent<HTMLElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === CHROMIUM_IME_COMPOSING_KEYCODE
}
