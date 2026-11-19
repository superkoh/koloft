import { describe, it, expect } from 'vitest'
import { countLabel } from '../../../../src/plugins/github/renderer/labels'

describe('countLabel', () => {
  it('keeps the exact count below a thousand and shortens from there down to one decimal', () => {
    expect(countLabel(999)).toBe('999')
    expect(countLabel(1000)).toBe('1k')
    expect(countLabel(2749)).toBe('2.7k')
    expect(countLabel(12399)).toBe('12.3k')
  })
})
