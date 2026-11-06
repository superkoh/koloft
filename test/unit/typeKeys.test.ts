import { describe, it, expect } from 'vitest'
import { bracketedPaste, clicksTheMouse, pressesAKey } from '../../src/main/typeKeys'

describe('what the owner sends a terminal', () => {
  it('counts as a key press for arrows, Shift+Tab, Esc and text, and not for mouse, focus or the terminal’s own replies', () => {
    for (const key of ['\x1b[B', '\x1b[A', '\x1b[C', '\x1b[Z', '\x1b', '\t', '2', 'hello'])
      expect(pressesAKey(key)).toBe(true)
    for (const report of [
      '\x1b[<0;5;21M\x1b[<0;5;21m',
      '\x1b[I',
      '\x1b[O',
      '\x1b[12;40R',
      '\x1b[?1;2c',
      ''
    ])
      expect(pressesAKey(report)).toBe(false)
  })

  // CC§14
  it('counts as a mouse click only for a button press, not for hover or the wheel', () => {
    expect(clicksTheMouse('\x1b[<0;5;21M\x1b[<0;5;21m')).toBe(true)
    for (const report of ['\x1b[<35;5;21M', '\x1b[<65;5;19M', '\x1b[B'])
      expect(clicksTheMouse(report)).toBe(false)
  })
})

describe('a bracketed paste', () => {
  it('cannot be ended early by text inside it, so a page cannot send keys of its own', () => {
    const fromPage = '<div>\x1b[201~\rrun this\r\u009b201~</div>'
    expect(bracketedPaste(fromPage)).toBe('\x1b[200~<div>[201~\rrun this\r201~</div>\x1b[201~')
  })

  it('keeps line breaks and tabs', () => {
    expect(bracketedPaste('a\n\tb\r\nc')).toBe('\x1b[200~a\n\tb\r\nc\x1b[201~')
  })
})
