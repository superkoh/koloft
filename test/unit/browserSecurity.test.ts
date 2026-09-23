import { describe, it, expect } from 'vitest'
import {
  authPromptFor,
  certHostOf,
  certTrusted,
  enforceGuestAttach,
  gestureFresh,
  GESTURE_WINDOW_MS,
  guestMenuItems,
  isAppNavigation,
  isAttachmentResponse,
  isUnderAnyRoot,
  jsDialogFor,
  chromeClientHints,
  standardUserAgent,
  type GuestAttachPrefs,
  type GuestMenuEntry
} from '../../src/main/browserSecurity'

/**
 * The pure decisions behind the main-process security guards (PRD §01 SEC-1/SEC-2,
 * §05D-4 SEC-8, §05D-5 SEC-10, §05D-1 SEC-12). Each one is a whitelist, so the cases
 * that matter are the spoofs that must NOT pass it — an e2e can prove one host is
 * refused, never that a family of look-alikes is.
 */

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

describe('certHostOf / certTrusted (SEC-8: the exception is keyed by host)', () => {
  it('keys on the host alone, lowercased, port dropped', () => {
    expect(certHostOf('https://koloft-a.test:8443/a')).toBe('koloft-a.test')
    expect(certHostOf('https://Koloft-A.TEST/a')).toBe('koloft-a.test')
    expect(certHostOf('https://localhost:8443/')).toBe('localhost')
  })

  it('is not fooled by a host spelled somewhere other than the host', () => {
    expect(certHostOf('https://evil.test/#koloft-a.test')).toBe('evil.test')
    expect(certHostOf('https://koloft-a.test@evil.test/')).toBe('evil.test')
  })

  it('yields nothing for a target that cannot carry a certificate', () => {
    expect(certHostOf('http://koloft-a.test/')).toBe('')
    expect(certHostOf('not a url')).toBe('')
    expect(certHostOf('')).toBe('')
  })

  it('matches the exact host only', () => {
    const hosts = new Set(['koloft-a.test'])
    expect(certTrusted(hosts, 'koloft-a.test')).toBe(true)
    expect(certTrusted(hosts, 'Koloft-A.TEST')).toBe(true)
    expect(certTrusted(hosts, 'koloft-b.test')).toBe(false)
    expect(certTrusted(hosts, 'evil.koloft-a.test')).toBe(false)
    expect(certTrusted(hosts, 'koloft-a.test.evil.com')).toBe(false)
    expect(certTrusted(hosts, '')).toBe(false)
  })
})

describe('authPromptFor (SEC-10: only a main-frame challenge may ask the user)', () => {
  const realm = 'Koloft Staging'

  it('prompts for a navigation challenge, stating origin and realm', () => {
    expect(
      authPromptFor(
        { url: 'http://127.0.0.1:8123/auth', isRequestForNavigation: true },
        { isProxy: false, realm },
        false
      )
    ).toEqual({ origin: 'http://127.0.0.1:8123', realm })
  })

  // the auth challenge and a guest's alert/confirm/prompt share the surface's ONE modal
  // slot: a challenge that painted over a live JS dialog would leave that page blocked
  // inside its call with nothing left on screen able to answer it (§05D-11).
  it('stays silent while the one modal slot is already taken', () => {
    expect(
      authPromptFor(
        { url: 'http://127.0.0.1:8123/auth', isRequestForNavigation: true },
        { isProxy: false, realm },
        true
      )
    ).toBeNull()
  })

  it('stays silent for a sub-resource challenge (a 401 image is phishable)', () => {
    expect(
      authPromptFor(
        { url: 'http://127.0.0.1:8123/auth-img', isRequestForNavigation: false },
        { isProxy: false, realm },
        false
      )
    ).toBeNull()
  })

  it('stays silent for a proxy challenge and for an unreadable url', () => {
    expect(
      authPromptFor(
        { url: 'http://127.0.0.1:8123/auth', isRequestForNavigation: true },
        { isProxy: true, realm },
        false
      )
    ).toBeNull()
    expect(
      authPromptFor(
        { url: 'not a url', isRequestForNavigation: true },
        { isProxy: false, realm },
        false
      )
    ).toBeNull()
  })
})

describe('standardUserAgent (SEC-12: self-describe as plain Chromium)', () => {
  const base =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '

  it('drops the Electron and app tokens and nothing else', () => {
    expect(
      standardUserAgent(
        `${base}Koloft/0.11.0 Chrome/140.0.0.0 Electron/43.0.0 Safari/537.36`,
        'Koloft'
      )
    ).toBe(`${base}Chrome/140.0.0.0 Safari/537.36`)
  })

  it('drops the app token whatever its case', () => {
    expect(standardUserAgent(`${base}koloft/0.11.0 Chrome/140.0.0.0 Safari/537.36`, 'Koloft')).toBe(
      `${base}Chrome/140.0.0.0 Safari/537.36`
    )
  })

  it('leaves a string that carries neither token alone', () => {
    const plain = `${base}Chrome/140.0.0.0 Safari/537.36`
    expect(standardUserAgent(plain, 'Koloft')).toBe(plain)
  })
})

describe('jsDialogFor (§05D-11: what a guest may ask, and what it may never dress up as)', () => {
  const page = 'http://localhost:5173/app?q=1#frag'

  it('carries the three kinds through, naming the frame origin rather than the page', () => {
    expect(jsDialogFor({ kind: 'alert', message: 'hi' }, page, false)).toEqual({
      kind: 'alert',
      origin: 'http://localhost:5173',
      message: 'hi',
      defaultValue: ''
    })
    expect(jsDialogFor({ kind: 'confirm', message: 'sure?' }, page, false)?.kind).toBe('confirm')
    expect(
      jsDialogFor({ kind: 'prompt', message: 'name', defaultValue: 'x' }, page, false)
    ).toEqual({
      kind: 'prompt',
      origin: 'http://localhost:5173',
      message: 'name',
      defaultValue: 'x'
    })
  })

  it('refuses a kind Koloft has no modal for', () => {
    expect(jsDialogFor({ kind: 'beforeunload', message: 'stay?' }, page, false)).toBeNull()
    expect(jsDialogFor({ kind: 'auth' }, page, false)).toBeNull()
    expect(jsDialogFor({ kind: 42 }, page, false)).toBeNull()
    expect(jsDialogFor({}, page, false)).toBeNull()
  })

  it('refuses a frame whose origin cannot be named', () => {
    expect(jsDialogFor({ kind: 'alert', message: 'hi' }, '', false)).toBeNull()
    expect(jsDialogFor({ kind: 'alert', message: 'hi' }, 'not a url', false)).toBeNull()
  })

  it('names an opaque origin by its scheme instead of the literal "null"', () => {
    expect(jsDialogFor({ kind: 'alert' }, 'file:///Users/x/a.html', false)?.origin).toBe('file://')
  })

  it('refuses a second dialog while one is still unanswered', () => {
    // one modal slot: a second page would otherwise block on a question nobody sees
    expect(jsDialogFor({ kind: 'confirm', message: 'sure?' }, page, true)).toBeNull()
  })

  it('takes text as text, clamped — never an object, and never a page-sized string', () => {
    const d = jsDialogFor(
      { kind: 'prompt', message: 'x'.repeat(5000), defaultValue: { toString: () => 'y' } },
      page,
      false
    )
    expect(d?.message.length).toBe(1000)
    expect(d?.defaultValue).toBe('')
    expect(jsDialogFor({ kind: 'alert', message: 12 }, page, false)?.message).toBe('')
  })

  it('leaves a prompt default off the other two kinds', () => {
    expect(jsDialogFor({ kind: 'confirm', defaultValue: 'x' }, page, false)?.defaultValue).toBe('')
  })
})

// SEC-5/SEC-6 — the attach-time enforcement of the guest profile. The renderer's factory
// authors these attributes; this is what makes them true for a call site that forgets.
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
      webSecurity: false,
      allowFileAccessFromFileUrls: true
    }
    expect(enforceGuestAttach(prefs, browserParams(), HOST_PRELOAD)).toBe(true)
    expect(prefs).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowFileAccessFromFileUrls: false,
      // R5/BB-N03: a page may not start making noise on its own
      autoplayPolicy: 'document-user-activation-required',
      // D12: window.open has to reach main's handler to become a tab; the handler is
      // what refuses the OS window
      disablePopups: false
    })
  })

  // BB-N03: muting a guest does not make it inaudible — a muted stream still reports as
  // playing — so silence has to come from the audio never starting. Preview's viewer is
  // held to the same rule: it is a page Koloft opened for the user to LOOK at.
  it('refuses autoplay to every guest, whatever it asked for', () => {
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
    // the default session is where the privileged koloft-file:// reader lives (SEC-6)
    expect(enforceGuestAttach({}, { partition: '', src: 'https://evil.test/' }, HOST_PRELOAD)).toBe(
      false
    )
    expect(
      enforceGuestAttach({}, { partition: 'persist:koloft-browser-evil', src: '' }, HOST_PRELOAD)
    ).toBe(false)
    expect(enforceGuestAttach({}, { src: 'https://evil.test/' }, HOST_PRELOAD)).toBe(false)
  })

  it("admits Preview's own koloft-file:// viewer, with popups still off (D6)", () => {
    const prefs: GuestAttachPrefs = { nodeIntegration: true }
    expect(
      enforceGuestAttach(
        prefs,
        { partition: '', src: 'koloft-file://localhost/Users/x/a.pdf' },
        HOST_PRELOAD
      )
    ).toBe(true)
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.disablePopups).toBe(true)
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

describe("gestureFresh (SEC-4 — an OS hand-off is the user's, not the page's)", () => {
  it('refuses a guest that has never had input at all', () => {
    expect(gestureFresh(undefined, 1_000_000)).toBe(false)
  })

  it('carries the click that caused the navigation, and nothing older', () => {
    const now = 1_000_000
    expect(gestureFresh(now, now)).toBe(true)
    expect(gestureFresh(now - GESTURE_WINDOW_MS, now)).toBe(true)
    expect(gestureFresh(now - GESTURE_WINDOW_MS - 1, now)).toBe(false)
  })
})

// G0-3 — a download belongs to the person, not to the guest that started it. Chromium
// only hands the transfer to the session once the response's type is settled, and the
// MIME sniff of a trickling body settles at its LAST byte; a tab closed in between takes
// the download with it. These are the responses Koloft marks `nosniff` to settle at once.
describe('isAttachmentResponse (G0-3: a download declared by its own headers)', () => {
  it('reads the disposition whatever case the server spelled the header in', () => {
    expect(isAttachmentResponse({ 'content-disposition': ['attachment; filename="a.bin"'] })).toBe(
      true
    )
    expect(isAttachmentResponse({ 'Content-Disposition': 'ATTACHMENT' })).toBe(true)
    expect(isAttachmentResponse({ 'CONTENT-DISPOSITION': ['  attachment  '] })).toBe(true)
  })

  it('leaves an inline response alone, including one whose filename says attachment', () => {
    expect(isAttachmentResponse({ 'content-disposition': ['inline'] })).toBe(false)
    expect(
      isAttachmentResponse({ 'content-disposition': ['inline; filename="attachment.pdf"'] })
    ).toBe(false)
    expect(isAttachmentResponse({ 'content-type': ['text/html'] })).toBe(false)
    expect(isAttachmentResponse({})).toBe(false)
  })

  it('finds the attachment among repeated and neighbouring headers', () => {
    expect(
      isAttachmentResponse({
        'content-type': ['application/octet-stream'],
        'content-disposition': ['inline', 'attachment; filename="b.bin"']
      })
    ).toBe(true)
  })
})

// §05D-10/G0-1 — the guest's only mouse entry point. What one right-click offers is a
// judgement about its target alone, so it is settled here rather than in the listener:
// an e2e can show one menu, never that the three items stay the three items.
describe('guestMenuItems (§05D-10: the guest right-click menu)', () => {
  const click = (over: Partial<Parameters<typeof guestMenuItems>[0]>): GuestMenuEntry[] =>
    guestMenuItems({ linkURL: '', srcURL: '', mediaType: 'none', ...over })
  const actions = (items: GuestMenuEntry[]): string[] => items.map((i) => i.action)

  it('offers copy and open-in-new-tab on a link, both aimed at the link', () => {
    const items = click({ linkURL: 'https://example.com/a?b=1' })
    expect(actions(items)).toEqual(['copy-link', 'open-link'])
    expect(items.every((i) => i.target === 'https://example.com/a?b=1')).toBe(true)
    expect(items.map((i) => i.label)).toEqual(['Copy Link', 'Open Link in New Tab'])
  })

  it('offers save-image on an image, aimed at the image source', () => {
    const items = click({ srcURL: 'https://example.com/cat.png', mediaType: 'image' })
    expect(items).toEqual([
      { action: 'save-image', label: 'Save Image', target: 'https://example.com/cat.png' }
    ])
  })

  it('offers all three on an image inside a link', () => {
    const items = click({
      linkURL: 'https://example.com/photo',
      srcURL: 'https://cdn.example.com/cat.png',
      mediaType: 'image'
    })
    expect(actions(items)).toEqual(['copy-link', 'open-link', 'save-image'])
    expect(items[2].target).toBe('https://cdn.example.com/cat.png')
  })

  it('offers nothing on bare page text — no menu at all, not an empty one', () => {
    expect(click({})).toEqual([])
  })

  // SEC-4/D3: the routing table decides what may become a tab. `javascript:` is self-XSS
  // and a remote page's `file:` link is refused inside Chromium — the menu may not be the
  // way around either. Copying the text of one is harmless and stays.
  it('withholds open-in-new-tab from a link that cannot become a tab', () => {
    expect(actions(click({ linkURL: 'javascript:alert(1)' }))).toEqual(['copy-link'])
    expect(actions(click({ linkURL: 'file:///etc/passwd' }))).toEqual(['copy-link'])
    expect(actions(click({ linkURL: 'file:///Users/x/notes.html' }))).toEqual(['copy-link'])
    expect(actions(click({ linkURL: 'mailto:someone@example.com' }))).toEqual(['copy-link'])
    expect(actions(click({ linkURL: 'chrome://settings' }))).toEqual(['copy-link'])
  })

  it('keeps open-in-new-tab for the schemes a tab is made of', () => {
    expect(actions(click({ linkURL: 'http://localhost:5173/x' }))).toEqual([
      'copy-link',
      'open-link'
    ])
    expect(actions(click({ linkURL: 'https://example.com/' }))).toEqual(['copy-link', 'open-link'])
  })

  it('is an IMAGE menu — other media, and an image with no source, offer nothing', () => {
    expect(click({ srcURL: 'https://example.com/clip.mp4', mediaType: 'video' })).toEqual([])
    expect(click({ srcURL: 'https://example.com/song.mp3', mediaType: 'audio' })).toEqual([])
    expect(click({ srcURL: 'https://example.com/x', mediaType: 'canvas' })).toEqual([])
    expect(click({ srcURL: '', mediaType: 'image' })).toEqual([])
  })
})

describe('chromeClientHints (Electron sends NO Sec-CH-UA; real Chrome always does)', () => {
  const macUA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.212 Safari/537.36'

  it('builds the three low-entropy hints, brand list carrying Google Chrome at the Chrome major', () => {
    const h = chromeClientHints(macUA)
    expect(h).toEqual({
      'Sec-CH-UA': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"macOS"'
    })
  })

  it('reads the platform from the UA', () => {
    expect(
      chromeClientHints(macUA.replace('Macintosh; Intel Mac OS X 10_15_7', 'Windows NT 10.0'))?.[
        'Sec-CH-UA-Platform'
      ]
    ).toBe('"Windows"')
    expect(
      chromeClientHints(macUA.replace('Macintosh; Intel Mac OS X 10_15_7', 'X11; Linux x86_64'))?.[
        'Sec-CH-UA-Platform'
      ]
    ).toBe('"Linux"')
  })

  it('falls back to "Unknown" when the UA names no recognizable platform', () => {
    expect(
      chromeClientHints('Mozilla/5.0 (Foo) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36')?.[
        'Sec-CH-UA-Platform'
      ]
    ).toBe('"Unknown"')
  })

  it('returns null for a UA with no Chrome token (nothing to model)', () => {
    expect(chromeClientHints('Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/141.0')).toBeNull()
    expect(chromeClientHints('')).toBeNull()
  })
})
