import { describe, it, expect } from 'vitest'
import {
  fullscreenOption,
  usableBounds,
  windowMinWidth,
  type WinBounds
} from '../../src/main/windowBounds'

// Requirement: a window closed in fullscreen reopens in fullscreen, but the option must
// be OMITTED otherwise — Electron interprets an explicit `fullscreen: false` construction
// option as "disable the macOS green-button fullscreen action" (zoom/maximize-only).
describe('windowState: fullscreen restore must never pass an explicit false', () => {
  it('restores fullscreen with an explicit true', () => {
    expect(fullscreenOption(true)).toEqual({ fullscreen: true })
  })

  it('omits the key entirely for a non-fullscreen restore', () => {
    expect('fullscreen' in fullscreenOption(false)).toBe(false)
  })
})

// Requirement: the window must reopen with its last geometry, but NEVER off-screen —
// bounds saved on a since-unplugged monitor fall back to the default (null here).
const MAIN: WinBounds = { x: 0, y: 25, width: 1728, height: 1060 } // laptop workArea
const SIDE: WinBounds = { x: 1728, y: 0, width: 2560, height: 1415 } // external, to the right

describe('windowState: saved bounds are restored only while they stay on-screen', () => {
  it('keeps bounds that sit on a connected display', () => {
    const b = { x: 120, y: 80, width: 1200, height: 800 }
    expect(usableBounds(b, [MAIN])).toEqual(b)
  })

  it('keeps bounds on a secondary display, and drops them once it is unplugged', () => {
    const onSide = { x: 2000, y: 100, width: 1400, height: 900 }
    expect(usableBounds(onSide, [MAIN, SIDE])).toEqual(onSide) // both connected → restore
    expect(usableBounds(onSide, [MAIN])).toBeNull() // side monitor gone → default window
  })

  it('keeps bounds straddling two displays while enough of the window remains grabbable', () => {
    const straddle = { x: 1500, y: 100, width: 1200, height: 800 }
    expect(usableBounds(straddle, [MAIN, SIDE])).toEqual(straddle)
  })

  it('drops bounds whose title bar fell above the display or below its grab margin', () => {
    expect(usableBounds({ x: 100, y: -300, width: 1200, height: 800 }, [MAIN])).toBeNull()
    expect(usableBounds({ x: 100, y: 1050, width: 1200, height: 800 }, [MAIN])).toBeNull()
  })

  it('rejects malformed state instead of crashing the launch', () => {
    expect(usableBounds(undefined, [MAIN])).toBeNull()
    expect(usableBounds('wat', [MAIN])).toBeNull()
    expect(usableBounds({ x: '10', y: 10, width: 1200, height: 800 }, [MAIN])).toBeNull()
    expect(usableBounds({ x: 10, y: 10, width: NaN, height: 800 }, [MAIN])).toBeNull()
    expect(usableBounds({ x: 10, y: 10, width: 50, height: 50 }, [MAIN])).toBeNull()
  })
})

// Requirement (B1/BB-C55): the Browser needs the window minimum at 1020 so the aux
// column can always reach its 440 floor — but an upgrading user whose 900-wide geometry
// predates that minimum must get their window back at 900 rather than clamped up to
// 1020 (Electron clamps construction bounds against minWidth, so the minimum yields).
describe('windowState: the 1020 minimum must not force-resize an older saved window', () => {
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
