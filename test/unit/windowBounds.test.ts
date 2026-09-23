import { describe, it, expect } from 'vitest'
import {
  fullscreenOption,
  usableBounds,
  windowMinWidth,
  type WinBounds
} from '../../src/main/windowBounds'

// PLATFORM§5
describe('windowState: fullscreen restore must never pass an explicit false', () => {
  it('restores fullscreen with an explicit true', () => {
    expect(fullscreenOption(true)).toEqual({ fullscreen: true })
  })

  it('omits the key entirely for a non-fullscreen restore', () => {
    expect('fullscreen' in fullscreenOption(false)).toBe(false)
  })
})

const LAPTOP_WORKAREA: WinBounds = { x: 0, y: 25, width: 1728, height: 1060 }
const EXTERNAL_TO_THE_RIGHT: WinBounds = { x: 1728, y: 0, width: 2560, height: 1415 }

describe('windowState: saved bounds are restored only while they stay on-screen', () => {
  it('keeps bounds that sit on a connected display', () => {
    const b = { x: 120, y: 80, width: 1200, height: 800 }
    expect(usableBounds(b, [LAPTOP_WORKAREA])).toEqual(b)
  })

  it('keeps bounds on a secondary display, and drops them once it is unplugged', () => {
    const onSide = { x: 2000, y: 100, width: 1400, height: 900 }
    expect(usableBounds(onSide, [LAPTOP_WORKAREA, EXTERNAL_TO_THE_RIGHT])).toEqual(onSide)
    expect(usableBounds(onSide, [LAPTOP_WORKAREA])).toBeNull()
  })

  it('keeps bounds straddling two displays while enough of the window remains grabbable', () => {
    const straddle = { x: 1500, y: 100, width: 1200, height: 800 }
    expect(usableBounds(straddle, [LAPTOP_WORKAREA, EXTERNAL_TO_THE_RIGHT])).toEqual(straddle)
  })

  it('drops bounds whose title bar fell above the display or below its grab margin', () => {
    expect(
      usableBounds({ x: 100, y: -300, width: 1200, height: 800 }, [LAPTOP_WORKAREA])
    ).toBeNull()
    expect(
      usableBounds({ x: 100, y: 1050, width: 1200, height: 800 }, [LAPTOP_WORKAREA])
    ).toBeNull()
  })

  it('rejects malformed state instead of crashing the launch', () => {
    expect(usableBounds(undefined, [LAPTOP_WORKAREA])).toBeNull()
    expect(usableBounds('wat', [LAPTOP_WORKAREA])).toBeNull()
    expect(usableBounds({ x: '10', y: 10, width: 1200, height: 800 }, [LAPTOP_WORKAREA])).toBeNull()
    expect(usableBounds({ x: 10, y: 10, width: NaN, height: 800 }, [LAPTOP_WORKAREA])).toBeNull()
    expect(usableBounds({ x: 10, y: 10, width: 50, height: 50 }, [LAPTOP_WORKAREA])).toBeNull()
  })
})

// PLATFORM§5
describe('windowState (B1/BB-C55): the 1020 minimum must not force-resize an older saved window', () => {
  it('applies the full minimum to a default or wider-than-minimum launch', () => {
    expect(windowMinWidth(undefined)).toBe(1020)
    expect(windowMinWidth(1440)).toBe(1020)
    expect(windowMinWidth(1020)).toBe(1020)
  })

  it('yields to a restored width saved below the minimum', () => {
    expect(windowMinWidth(900)).toBe(900)
    expect(windowMinWidth(700)).toBe(700)
  })
})
