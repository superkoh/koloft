import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { stopEndsMount } from '../../src/renderer/src/components/browserMount'

/**
 * which `did-stop-loading` finishes a CDP mount.
 *
 * The bug this pins: a fresh guest boots on `about:blank` and loads its real url after.
 * When that first `loadURL` throws (electron#31918 — BrowserGuest's own comment measures
 * it at about 1 mount in 3) the load is re-issued at `dom-ready`, and the boot page's own
 * stop lands FIRST. The surface used to take that stop as "the page is ready", hand the
 * client a frame that was about to be replaced, and the client's first action died with
 * "Frame has been detached".
 *
 * It lives in a unit test rather than an e2e case because the throw is Electron's own
 * timing: a case built on it would go green two runs in three no matter what the code did.
 */
describe('stopEndsMount', () => {
  it('takes the stop of the page the tab was actually sent to', () => {
    expect(
      stopEndsMount({ guestUrl: 'http://x/a', targetUrl: 'http://x/a', isLoading: false })
    ).toBe(true)
  })

  it('ignores the boot page stopping while the real load is already in flight', () => {
    // the measured shape: about:blank stops at +394 ms with a load still going
    expect(
      stopEndsMount({ guestUrl: 'about:blank', targetUrl: 'http://x/a', isLoading: true })
    ).toBe(false)
  })

  it('ignores a stop that leaves the guest on the boot page, load or no load', () => {
    // the re-issued load has been asked for at dom-ready but has not started yet
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
    // a tab with no url at all is the same tab
    expect(stopEndsMount({ guestUrl: 'about:blank', targetUrl: '', isLoading: false })).toBe(true)
  })
})

/**
 * The rule is only worth having where the mount reads it. The panel's `onLoading(false)`
 * is the single place a pending settle is released, and it used to release it with no
 * question asked — so this asserts the question is still being asked there.
 */
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
    // the rule is asked…
    expect(handler).toContain('stopEndsMount')
    // …and the only release in there comes after the answer, never before it
    expect(handler.indexOf('pendingSettles')).toBeGreaterThan(handler.indexOf('stopEndsMount'))
  })
})
