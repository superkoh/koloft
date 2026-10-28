import { describe, it, expect } from 'vitest'
import { bracketedPaste } from '../../src/main/typeKeys'

describe('a bracketed paste', () => {
  it('cannot be ended early by text inside it, so a page cannot send keys of its own', () => {
    const fromPage = '<div>\x1b[201~\rrun this\r\u009b201~</div>'
    expect(bracketedPaste(fromPage)).toBe('\x1b[200~<div>[201~\rrun this\r201~</div>\x1b[201~')
  })

  it('keeps line breaks and tabs', () => {
    expect(bracketedPaste('a\n\tb\r\nc')).toBe('\x1b[200~a\n\tb\r\nc\x1b[201~')
  })
})
