import { describe, it, expect } from 'vitest'
import { allowCrashReload } from '../../src/main/crashGuard'

// M1: auto-reload after render-process-gone, at most 2 per 30s window.
// An e2e can't practically drive three crashes inside the window; a too-loose
// guard is an infinite reload loop that manifests nowhere near this decision.

describe('allowCrashReload', () => {
  const now = 1_000_000_000

  it('allows the first crash reload', () => {
    expect(allowCrashReload([], now)).toBe(true)
  })

  it('allows a second reload inside the window', () => {
    expect(allowCrashReload([now - 5_000], now)).toBe(true)
  })

  it('denies the third reload inside 30s — crash loop', () => {
    expect(allowCrashReload([now - 5_000, now - 1_000], now)).toBe(false)
  })

  it('forgets reloads older than the 30s window', () => {
    expect(allowCrashReload([now - 31_000, now - 1_000], now)).toBe(true)
    expect(allowCrashReload([now - 45_000, now - 31_000], now)).toBe(true)
  })
})
