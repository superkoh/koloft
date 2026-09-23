import type { KeyboardEvent } from 'react'

/** Enter while an input method (Chinese, Japanese…) is still composing only picks the
 *  candidate word, but the browser reports it as a keydown too — a form that submits on
 *  it throws away a half-typed field. Chromium marks such a
 *  keydown with keyCode 229. */
export function isComposing(e: KeyboardEvent<HTMLElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229
}
