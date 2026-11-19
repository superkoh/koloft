import { describe, it, expect } from 'vitest'
import {
  enforceGuestAttach,
  isAppNavigation,
  isUnderAnyRoot,
  type GuestAttachPrefs
} from '../../src/main/browserSecurity'

const PROD_APP = 'file:///Users/x/koloft/out/renderer/index.html'
const DEV_APP = 'http://localhost:5173/'

describe('isAppNavigation (SEC-2: the host window may only ever be on its own origin)', () => {
  it('accepts the app document itself, with or without a query/hash', () => {
    expect(isAppNavigation(PROD_APP, PROD_APP)).toBe(true)
    expect(isAppNavigation(`${PROD_APP}#/settings`, PROD_APP)).toBe(true)
    expect(isAppNavigation(`${PROD_APP}?dev=1`, PROD_APP)).toBe(true)
  })

  it('refuses another file on disk, including one reached by traversal', () => {
    expect(isAppNavigation('file:///Users/x/koloft/out/renderer/evil.html', PROD_APP)).toBe(false)
    expect(isAppNavigation('file:///etc/passwd', PROD_APP)).toBe(false)
    expect(isAppNavigation('file:///Users/x/koloft/out/renderer/../../evil.html', PROD_APP)).toBe(
      false
    )
  })

  it('refuses a remote origin, whatever it is dressed as', () => {
    expect(isAppNavigation('http://evil.example/', PROD_APP)).toBe(false)
    expect(isAppNavigation('javascript:alert(1)', PROD_APP)).toBe(false)
    expect(isAppNavigation('', PROD_APP)).toBe(false)
  })

  it('accepts the dev server it was actually loaded from', () => {
    expect(isAppNavigation('http://localhost:5173/index.html', DEV_APP)).toBe(true)
    expect(isAppNavigation('http://localhost:5173/@vite/client', DEV_APP)).toBe(true)
  })

  it('refuses a look-alike of the dev origin', () => {
    expect(isAppNavigation('https://localhost:5173/', DEV_APP)).toBe(false)
    expect(isAppNavigation('http://localhost:5174/', DEV_APP)).toBe(false)
    expect(isAppNavigation('http://localhost:5173.evil.com/', DEV_APP)).toBe(false)
    expect(isAppNavigation('http://evil.com/?next=http://localhost:5173/', DEV_APP)).toBe(false)
  })
})

describe('isUnderAnyRoot (a directory prefix, not a string prefix)', () => {
  const roots = ['/Users/x/ws', '/Users/x/other']

  it('accepts a file under a root, and the root itself', () => {
    expect(isUnderAnyRoot('/Users/x/ws/docs/a.html', roots)).toBe(true)
    expect(isUnderAnyRoot('/Users/x/ws', roots)).toBe(true)
    expect(isUnderAnyRoot('/Users/x/other/b.png', roots)).toBe(true)
  })

  it('refuses a sibling directory that merely shares the prefix', () => {
    expect(isUnderAnyRoot('/Users/x/ws-evil/a.txt', roots)).toBe(false)
    expect(isUnderAnyRoot('/Users/x/wsx', roots)).toBe(false)
  })

  it('refuses a path outside every root, including via traversal', () => {
    expect(isUnderAnyRoot('/Users/x/.ssh/id_rsa', roots)).toBe(false)
    expect(isUnderAnyRoot('/Users/x/ws/../.ssh/id_rsa', roots)).toBe(false)
    expect(isUnderAnyRoot('/Users/x/ws/docs/../../.ssh/id_rsa', roots)).toBe(false)
  })

  it('refuses everything when no root is declared', () => {
    expect(isUnderAnyRoot('/Users/x/ws/docs/a.html', [])).toBe(false)
  })

  it('reads a trailing separator on a root as the same root', () => {
    expect(isUnderAnyRoot('/Users/x/ws/docs/a.html', ['/Users/x/ws/'])).toBe(true)
  })
})

describe('enforceGuestAttach (SEC-5/SEC-6: what a <webview> may attach as)', () => {
  const HOST_PRELOAD = '/Applications/Koloft.app/Contents/Resources/app/out/preload/index.js'
  const GUEST_PRELOAD = '/Applications/Koloft.app/Contents/Resources/app/out/preload/guest.js'

  const browserParams = (extra: Record<string, string> = {}): Record<string, string> => ({
    partition: 'persist:koloft-browser',
    src: '',
    ...extra
  })

  it('admits a guest on the browser partition and hardens what it asked for', () => {
    const prefs = {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
    expect(enforceGuestAttach(prefs, browserParams(), HOST_PRELOAD)).toBe(true)
    expect(prefs).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      autoplayPolicy: 'document-user-activation-required',
      disablePopups: false,
      nodeIntegrationInSubFrames: true
    })
  })

  // PLATFORM§13
  it('BB-N03: refuses autoplay to every guest, whatever it asked for', () => {
    const browser: GuestAttachPrefs = { autoplayPolicy: 'no-user-gesture-required' }
    enforceGuestAttach(browser, browserParams(), HOST_PRELOAD)
    expect(browser.autoplayPolicy).toBe('document-user-activation-required')

    const viewer: GuestAttachPrefs = { autoplayPolicy: 'no-user-gesture-required' }
    enforceGuestAttach(
      viewer,
      { partition: '', src: 'koloft-file://localhost/x/a.pdf' },
      HOST_PRELOAD
    )
    expect(viewer.autoplayPolicy).toBe('document-user-activation-required')
  })

  it('strips a preload the guest is not entitled to, including the privileged one', () => {
    const foreign = { preload: '/tmp/evil.js' }
    enforceGuestAttach(foreign, browserParams(), HOST_PRELOAD)
    expect(foreign.preload).toBeUndefined()

    const host = { preload: HOST_PRELOAD }
    enforceGuestAttach(host, browserParams(), HOST_PRELOAD)
    expect(host.preload).toBeUndefined()

    const traversal = { preload: `${GUEST_PRELOAD}/../../../evil.js` }
    enforceGuestAttach(traversal, browserParams(), HOST_PRELOAD)
    expect(traversal.preload).toBeUndefined()
  })

  it('keeps the sanctioned guest preload Koloft ships beside the host one', () => {
    const prefs = { preload: GUEST_PRELOAD }
    enforceGuestAttach(prefs, browserParams(), HOST_PRELOAD)
    expect(prefs.preload).toBe(GUEST_PRELOAD)
  })

  it('refuses a guest that named no partition, or another one', () => {
    expect(enforceGuestAttach({}, { partition: '', src: 'https://evil.test/' }, HOST_PRELOAD)).toBe(
      false
    )
    expect(
      enforceGuestAttach({}, { partition: 'persist:koloft-browser-evil', src: '' }, HOST_PRELOAD)
    ).toBe(false)
    expect(enforceGuestAttach({}, { src: 'https://evil.test/' }, HOST_PRELOAD)).toBe(false)
  })

  // PLATFORM§14
  it('runs the guest preload in a web page’s cross-site iframes too, so a captcha frame passes as Chrome', () => {
    const prefs: GuestAttachPrefs = {}
    enforceGuestAttach(prefs, browserParams(), HOST_PRELOAD)
    expect(prefs.nodeIntegrationInSubFrames).toBe(true)
  })

  it("admits Preview's own koloft-file:// viewer, with popups still off (D6)", () => {
    const prefs: GuestAttachPrefs = { nodeIntegration: true, nodeIntegrationInSubFrames: true }
    expect(
      enforceGuestAttach(
        prefs,
        { partition: '', src: 'koloft-file://localhost/Users/x/a.pdf' },
        HOST_PRELOAD
      )
    ).toBe(true)
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.disablePopups).toBe(true)
    expect(prefs.nodeIntegrationInSubFrames).toBe(false)
  })

  it('is not fooled by a scheme that merely starts like the viewer one', () => {
    expect(
      enforceGuestAttach({}, { partition: '', src: 'koloft-file.evil://x/a.pdf' }, HOST_PRELOAD)
    ).toBe(false)
    expect(
      enforceGuestAttach(
        {},
        { partition: '', src: 'https://evil.test/#koloft-file:' },
        HOST_PRELOAD
      )
    ).toBe(false)
  })
})
