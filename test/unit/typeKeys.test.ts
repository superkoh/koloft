import { describe, it, expect } from 'vitest'
import { bracketedPaste, clicksTheMouse, pasteFor, pressesAKey } from '../../src/main/typeKeys'

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

describe('a paste from the Workbench into a session', () => {
  // CC§18 CODEX§23 MUSE§7
  it('starts with two line feeds inside the paste for Claude Code, Codex and Muse, so a picked element or failing checks put in before Enter do not run on from the note typed after a comment', () => {
    for (const kind of ['claude', 'codex', 'muse'] as const)
      expect(pasteFor('checks\n\n', kind)).toBe('\x1b[200~\n\nchecks\n\n\x1b[201~')
  })

  // AGY§15
  it('types the two line feeds before an Antigravity paste and its last line feeds after it, since agy keeps a typed line feed and drops those at a paste’s end', () => {
    expect(pasteFor('checks\n\n', 'agy')).toBe('\n\n\x1b[200~checks\x1b[201~\n\n')
    expect(pasteFor('picked', 'agy')).toBe('\n\n\x1b[200~picked\x1b[201~')
  })
})
