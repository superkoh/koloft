import { describe, it, expect } from 'vitest'
import {
  clampSideWidth,
  SIDE_READ_MIN,
  SIDE_WIDTH_MIN
} from '../../src/renderer/src/components/filesSide'

describe('clampSideWidth', () => {
  it('keeps the Files left column between its minimum and what leaves the reading column its minimum', () => {
    const container = 800
    expect(clampSideWidth(SIDE_WIDTH_MIN - 50, container)).toBe(SIDE_WIDTH_MIN)
    expect(clampSideWidth(300.4, container)).toBe(300)
    expect(clampSideWidth(container, container)).toBe(container - SIDE_READ_MIN)
  })

  it('a container too narrow for both columns keeps the left column at its minimum', () => {
    const tooNarrow = SIDE_WIDTH_MIN + SIDE_READ_MIN - 90
    expect(clampSideWidth(SIDE_WIDTH_MIN + 50, tooNarrow)).toBe(SIDE_WIDTH_MIN)
  })
})
