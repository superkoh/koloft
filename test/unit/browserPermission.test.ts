import { describe, it, expect } from 'vitest'
import {
  permissionAsk,
  permissionKey,
  permissionOriginOf,
  type PermissionAsk
} from '../../src/main/browserPermission'

// PLATFORM§11
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

  // PLATFORM§11
  it('refuses the screen share that arrives disguised as a media request', () => {
    expect(
      permissionAsk('media', { requestingUrl: 'https://a.test/', mediaTypes: [] })
    ).toMatchObject({
      kind: 'refuse',
      origin: 'https://a.test'
    })
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
    expect(permissionAsk('media', { requestingUrl: '', mediaTypes: ['audio'] })).toMatchObject({
      kind: 'refuse'
    })
    expect(permissionAsk('notifications', {})).toMatchObject({ kind: 'refuse' })
  })

  it('refuses a sub-frame challenge rather than asking in the main frame’s name', () => {
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
    expect(permissionKey('https://a.test', 'camera-and-microphone')).toBe(
      permissionKey('https://a.test', 'camera-and-microphone')
    )
  })
})

// PLATFORM§11
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

describe('SEC-3: nothing is granted by accident', () => {
  const site = { requestingUrl: 'https://a.test/', isMainFrame: true }

  it('keeps clipboard READ behind a prompt — it hands over whatever was copied last', () => {
    expect(permissionAsk('clipboard-read', site)).toMatchObject({ kind: 'ask' })
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

  // PLATFORM§11
  it('allows the page filling its own surface, because refusing it breaks fullscreen', () => {
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
    expect(permissionAsk('storage-access', { requestingUrl: 'https://a.test/' })).toMatchObject({
      tell: false
    })
    expect(
      permissionAsk('usb', { requestingUrl: 'https://ads.example/', isMainFrame: false })
    ).toMatchObject({ tell: false })
  })
})
