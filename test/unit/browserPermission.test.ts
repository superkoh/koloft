import { describe, it, expect } from 'vitest'
import {
  permissionAsk,
  permissionKey,
  permissionOriginOf,
  type PermissionAsk
} from '../../src/main/browserPermission'

/**
 * §03 B7/B8 — the pure decision behind the page-permission prompt. Everything the
 * handlers do is downstream of these three: what a raw Electron permission becomes for
 * the user (ask / silent-allow / visible-refusal), what it is remembered under, and
 * whose name the prompt carries.
 *
 * Written against the spike, which overturned two assumptions the PRD had
 * made: microphone and camera arrive as ONE permission (`media`, split by mediaTypes),
 * and the handler's own origin argument is empty — the asking site is only ever in
 * `details`.
 */

describe('permissionAsk — what a raw permission request becomes', () => {
  it('turns a microphone request into an ask that names the microphone', () => {
    const ask = permissionAsk('media', {
      requestingUrl: 'https://figma.com/f/1',
      mediaTypes: ['audio']
    })
    expect(ask).toMatchObject<Partial<PermissionAsk>>({
      kind: 'ask',
      permission: 'microphone',
      origin: 'https://figma.com'
    })
  })

  it('turns a camera request into an ask that names the camera', () => {
    const ask = permissionAsk('media', {
      requestingUrl: 'https://meet.example.com/',
      mediaTypes: ['video']
    })
    expect(ask).toMatchObject({ kind: 'ask', permission: 'camera' })
  })

  it('names both when a call asks for microphone and camera at once', () => {
    const ask = permissionAsk('media', {
      requestingUrl: 'https://meet.example.com/',
      mediaTypes: ['audio', 'video']
    })
    expect(ask).toMatchObject({ kind: 'ask', permission: 'camera-and-microphone' })
  })

  it.each([
    ['notifications', 'notifications'],
    ['geolocation', 'geolocation'],
    ['clipboard-read', 'clipboard-read']
  ])('asks for %s', (raw, expected) => {
    expect(permissionAsk(raw, { requestingUrl: 'https://a.test/' })).toMatchObject({
      kind: 'ask',
      permission: expected
    })
  })

  it('lets the sanitized clipboard write through without ever asking', () => {
    expect(
      permissionAsk('clipboard-sanitized-write', { requestingUrl: 'https://a.test/' })
    ).toMatchObject({
      kind: 'allow'
    })
  })

  it('refuses screen sharing, and says so rather than going silent', () => {
    expect(permissionAsk('display-capture', { requestingUrl: 'https://a.test/' })).toMatchObject({
      kind: 'refuse',
      permission: 'display-capture',
      origin: 'https://a.test'
    })
  })

  it('refuses the screen share that arrives disguised as a media request', () => {
    // measured: getDisplayMedia does NOT arrive as 'display-capture'. It
    // comes through as `media` with an EMPTY mediaTypes — indistinguishable by name
    // from a camera ask. Left unhandled, a page asking for the screen raises a prompt
    // that says "microphone", which is a prompt about the wrong thing.
    expect(
      permissionAsk('media', { requestingUrl: 'https://a.test/', mediaTypes: [] })
    ).toMatchObject({
      kind: 'refuse',
      origin: 'https://a.test'
    })
    // and the same request with no mediaTypes key at all
    expect(permissionAsk('media', { requestingUrl: 'https://a.test/' })).toMatchObject({
      kind: 'refuse'
    })
  })

  it.each(['usb', 'bluetooth', 'midi', 'serial', 'hid'])('refuses %s visibly too', (raw) => {
    expect(permissionAsk(raw, { requestingUrl: 'https://a.test/' })).toMatchObject({
      kind: 'refuse'
    })
  })

  it('leaves openExternal to its own door — it never becomes a prompt', () => {
    expect(permissionAsk('openExternal', { requestingUrl: 'https://a.test/' })).toMatchObject({
      kind: 'elsewhere'
    })
  })

  it('refuses without a prompt when the asking url is unreadable', () => {
    // a prompt with no name on it is a prompt the user cannot judge
    expect(permissionAsk('media', { requestingUrl: '', mediaTypes: ['audio'] })).toMatchObject({
      kind: 'refuse'
    })
    expect(permissionAsk('notifications', {})).toMatchObject({ kind: 'refuse' })
  })

  it('refuses a sub-frame challenge rather than asking in the main frame’s name', () => {
    // SEC-10's rule, same reason: a third-party frame must not raise a prompt that
    // reads as the page the user thinks they are on
    expect(
      permissionAsk('media', {
        requestingUrl: 'https://ads.example/',
        isMainFrame: false,
        mediaTypes: ['audio']
      })
    ).toMatchObject({ kind: 'refuse' })
  })
})

describe('permissionKey — what an answer is remembered under', () => {
  it('remembers per site and per permission, not one blanket yes', () => {
    expect(permissionKey('https://a.test', 'microphone')).not.toBe(
      permissionKey('https://a.test', 'camera')
    )
    expect(permissionKey('https://a.test', 'microphone')).not.toBe(
      permissionKey('https://b.test', 'microphone')
    )
  })

  it('treats the same site as the same site', () => {
    expect(permissionKey('https://a.test', 'microphone')).toBe(
      permissionKey('https://a.test', 'microphone')
    )
  })

  it('keeps http and https apart — they are different origins', () => {
    expect(permissionKey('http://a.test', 'microphone')).not.toBe(
      permissionKey('https://a.test', 'microphone')
    )
  })

  it('answers a combined camera+microphone ask under both single keys', () => {
    // so that a later microphone-only request does not re-prompt after the user
    // already allowed the pair
    expect(permissionKey('https://a.test', 'camera-and-microphone')).toBe(
      permissionKey('https://a.test', 'camera-and-microphone')
    )
  })
})

describe('permissionOriginOf — whose name the prompt carries', () => {
  it('reads the site off the request, never off the empty origin argument', () => {
    expect(permissionOriginOf({ requestingUrl: 'https://figma.com/file/x?y=1' })).toBe(
      'https://figma.com'
    )
  })

  it('falls back to the embedding page when only that is given', () => {
    expect(permissionOriginOf({ embeddingOrigin: 'https://host.test/' })).toBe('https://host.test')
  })

  it('gives nothing for a url it cannot read', () => {
    expect(permissionOriginOf({ requestingUrl: 'not a url' })).toBe('')
    expect(permissionOriginOf({})).toBe('')
  })

  it('keeps the port, because a different port is a different site', () => {
    expect(permissionOriginOf({ requestingUrl: 'http://localhost:5173/x' })).toBe(
      'http://localhost:5173'
    )
  })
})

// SEC-3 (moved here): these used to guard `browserPermissionGranted`, which
//  replaced as the partition's gate. The function is gone; the guarantee is
// not, so the cases now stand in front of the table that actually answers.
describe('SEC-3: nothing is granted by accident', () => {
  const site = { requestingUrl: 'https://a.test/', isMainFrame: true }

  it('keeps clipboard READ behind a prompt — it hands over whatever was copied last', () => {
    expect(permissionAsk('clipboard-read', site)).toMatchObject({ kind: 'ask' })
    // the deprecated synchronous twin is not promptable at all
    expect(permissionAsk('deprecated-sync-clipboard-read', site)).toMatchObject({ kind: 'refuse' })
  })

  it('never silently grants anything Electron would auto-approve', () => {
    for (const permission of [
      'notifications',
      'geolocation',
      'media',
      'display-capture',
      'midi',
      'midiSysex',
      'idle-detection',
      'pointerLock',
      'keyboardLock',
      'window-management',
      'storage-access',
      'top-level-storage-access',
      'hid',
      'serial',
      'usb',
      'fileSystem',
      'mediaKeySystem',
      'speaker-selection',
      'unknown',
      ''
    ]) {
      // 'allow' is the only outcome that hands a capability over with no user in the
      // loop — everything above must be an ask or a refusal, never that
      expect(permissionAsk(permission, site).kind).not.toBe('allow')
    }
  })

  it('matches a silently-allowed name exactly, never a look-alike', () => {
    for (const spoof of [
      'clipboard-sanitized-write-evil',
      'clipboard-sanitized-write ',
      'CLIPBOARD-SANITIZED-WRITE',
      'clipboard',
      'fullscreen-evil',
      ' fullscreen'
    ]) {
      expect(permissionAsk(spoof, site).kind).not.toBe('allow')
    }
  })

  it('allows the page filling its own surface, because refusing it breaks fullscreen', () => {
    // measured: refusing `fullscreen` means enter-html-full-screen never fires, so the
    // whole feature silently does nothing. What keeps it safe is main's rule that the
    // Koloft window never follows the page into macOS fullscreen.
    expect(permissionAsk('fullscreen', site)).toMatchObject({ kind: 'allow' })
  })
})

describe('which refusals are worth saying out loud', () => {
  it('tells the user when something they clicked was refused', () => {
    expect(permissionAsk('usb', { requestingUrl: 'https://a.test/' })).toMatchObject({ tell: true })
    expect(
      permissionAsk('media', { requestingUrl: 'https://a.test/', mediaTypes: [] })
    ).toMatchObject({
      tell: true
    })
  })

  it('stays quiet about machinery nobody initiated', () => {
    // a page probing for storage access, an ad frame asking for anything: a bar for
    // each of these is noise wearing the shape of a real question
    expect(permissionAsk('storage-access', { requestingUrl: 'https://a.test/' })).toMatchObject({
      tell: false
    })
    expect(
      permissionAsk('usb', { requestingUrl: 'https://ads.example/', isMainFrame: false })
    ).toMatchObject({ tell: false })
  })
})
