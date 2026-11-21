import { describe, it, expect } from 'vitest'
import {
  authPromptFor,
  certHostOf,
  certTrusted,
  gestureFresh,
  GESTURE_WINDOW_MS,
  guestMenuItems,
  isAttachmentResponse,
  jsDialogFor,
  chromeClientHints,
  standardUserAgent,
  type GuestMenuEntry
} from '../../../../src/plugins/workbench/main/pageRules'

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

  // PLATFORM§11
  it("gives a click one second, not Chromium's 5 s activation, so a page cannot ride a click made on it earlier", () => {
    const now = 1_000_000
    expect(gestureFresh(now - 1000, now)).toBe(true)
    expect(gestureFresh(now - 1001, now)).toBe(false)
    expect(gestureFresh(now - 4000, now)).toBe(false)
  })
})

// PLATFORM§13
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
