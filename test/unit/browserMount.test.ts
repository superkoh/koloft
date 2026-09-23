import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { stopEndsMount } from '../../src/renderer/src/components/browserMount'

// PLATFORM§8
describe('stopEndsMount', () => {
  it('takes the stop of the page the tab was actually sent to', () => {
    expect(
      stopEndsMount({ guestUrl: 'http://x/a', targetUrl: 'http://x/a', isLoading: false })
    ).toBe(true)
  })

  it('ignores the boot page stopping while the real load is already in flight', () => {
    expect(
      stopEndsMount({ guestUrl: 'about:blank', targetUrl: 'http://x/a', isLoading: true })
    ).toBe(false)
  })

  it('ignores a stop that leaves the guest on the boot page, load or no load', () => {
    expect(
      stopEndsMount({ guestUrl: 'about:blank', targetUrl: 'http://x/a', isLoading: false })
    ).toBe(false)
  })

  it('ignores a stop from a guest that cannot say where it is', () => {
    expect(stopEndsMount({ guestUrl: '', targetUrl: 'http://x/a', isLoading: false })).toBe(false)
  })

  it('settles a tab whose target IS the boot page — a newPage() with no url', () => {
    expect(
      stopEndsMount({ guestUrl: 'about:blank', targetUrl: 'about:blank', isLoading: false })
    ).toBe(true)
    expect(stopEndsMount({ guestUrl: 'about:blank', targetUrl: '', isLoading: false })).toBe(true)
  })
})

describe('the panel asks it', () => {
  const PANE = path.join(
    __dirname,
    '..',
    '..',
    'src',
    'renderer',
    'src',
    'components',
    'WorkbenchPane.tsx'
  )

  it("WorkbenchPane's stop handler settles only through stopEndsMount", () => {
    const src = fs.readFileSync(PANE, 'utf8')
    const start = src.indexOf('onLoading: (loading: boolean)')
    expect(start).toBeGreaterThan(-1)
    const handler = src.slice(start, src.indexOf('onNavigate:', start))
    expect(handler).toContain('stopEndsMount')
    expect(handler.indexOf('pendingSettles')).toBeGreaterThan(handler.indexOf('stopEndsMount'))
  })
})
