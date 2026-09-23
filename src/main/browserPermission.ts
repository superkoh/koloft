/**
 * §03 B7/B8 — the page-permission decision, kept apart from the handlers that call it
 * so the whole table is testable without a session.
 *
 * The shape is set by what Electron actually hands over (2026-08-18 spikes, run against
 * this app's own Electron):
 *
 *   - microphone and camera are ONE permission, `media`, told apart by `mediaTypes`;
 *     the user is still asked about them separately, because "media" (as one lump) is not a thing
 *     anyone can judge.
 *   - `getDisplayMedia` arrives as `media` too, with an EMPTY `mediaTypes` — screen
 *     sharing wearing a device's name.
 *   - the handlers' `origin` argument is empty in this version. The asking site is only
 *     ever in `details`, so that is the single place it is read from — which is also
 *     what makes the prompt's name Koloft's word rather than the page's (SEC-10's rule).
 *   - a denied permission surfaces to the page as a real error, never a hang. So the
 *     silence users read as "broken" is ours to fix with a notice, nothing more.
 *
 * This table is the ONLY gate for every Chromium permission, so anything absent from it
 * is refused. That is the safe default and the reason each addition is deliberate.
 */

/** what the user is actually being asked about — one line they can judge */
export type PermissionName =
  | 'microphone'
  | 'camera'
  | 'camera-and-microphone'
  | 'notifications'
  | 'geolocation'
  | 'clipboard-read'

/** the families that may raise a prompt (B7). Everything else is refused. */
const PROMPTABLE = new Set(['media', 'notifications', 'geolocation', 'clipboard-read'])

/**
 * Granted without ever asking.
 *
 *  - `clipboard-sanitized-write` is what a page's "Copy" button uses, writing sanitized
 *    text Chromium itself produces — Koloft never reads the system clipboard for a page.
 *  - `fullscreen` is the page filling the surface it is already in. Asking would be
 *    asking about nothing: what makes it safe is not consent but §07 #3's rule that the
 *    Koloft WINDOW never follows the page into macOS fullscreen, enforced in main. Refusing
 *    it (as an earlier revision did) silently disables the whole fullscreen feature —
 *    `enter-html-full-screen` never fires at all.
 */
const SILENT_ALLOW = new Set(['clipboard-sanitized-write', 'fullscreen'])

/** SEC-4 keeps this one: Electron would call shell.openExternal itself, around Koloft's
 *  own whitelist and around the choke point every hand-off is read from. */
const ELSEWHERE = new Set(['openExternal'])

export interface PermissionDetails {
  requestingUrl?: string
  embeddingOrigin?: string
  securityOrigin?: string
  isMainFrame?: boolean
  /** request handler: which of audio/video a `media` call wants */
  mediaTypes?: string[]
  /** check handler: the singular form of the same thing */
  mediaType?: string
}

export type PermissionAsk =
  /** raise the prompt bar and hold the page's call until it is answered */
  | { kind: 'ask'; permission: PermissionName; origin: string }
  /** allow with no prompt at all */
  | { kind: 'allow' }
  /** deny. `tell` is whether the user is owed a notice: a refusal they can connect to
   *  something they just did is worth saying, machinery they never initiated is noise. */
  | { kind: 'refuse'; permission: string; origin: string; tell: boolean }
  /** not this table's business; another door already owns it */
  | { kind: 'elsewhere' }

/** The origin the prompt speaks in the name of. Never the page's own claim about
 *  itself: it is read off the request Chromium made, which the page cannot forge. */
export function permissionOriginOf(details: PermissionDetails): string {
  for (const candidate of [
    details.requestingUrl,
    details.securityOrigin,
    details.embeddingOrigin
  ]) {
    if (!candidate) continue
    try {
      const origin = new URL(candidate).origin
      if (origin && origin !== 'null') return origin
    } catch {
      // fall through to the next candidate
    }
  }
  return ''
}

/**
 * `media` covers both devices; which one is being asked for decides what the prompt
 * says. The check handler names one device, the request handler lists them.
 *
 * `null` means this `media` request is NOT a device at all: `getDisplayMedia` — screen
 * sharing — arrives as `media` with an EMPTY mediaTypes (measured, not documented
 * anywhere). Treated as a device it would raise a prompt about the microphone for a
 * page that asked for the screen, which is worse than no prompt.
 */
function mediaName(details: PermissionDetails): PermissionName | null {
  const types = details.mediaTypes ?? (details.mediaType ? [details.mediaType] : [])
  const audio = types.includes('audio')
  const video = types.includes('video')
  if (audio && video) return 'camera-and-microphone'
  if (video) return 'camera'
  if (audio) return 'microphone'
  return null
}

/**
 * Refusals worth announcing: the ones a user can connect to something they just did.
 * A page's own machinery asks for things nobody clicked (storage access, idle
 * detection, an ad frame's fullscreen), and a bar for each of those is noise wearing
 * the same shape as a real answer.
 */
const TELL_ABOUT = new Set([
  'display-capture',
  'media',
  'usb',
  'bluetooth',
  'serial',
  'hid',
  'midi'
])

/**
 * The one table both permission handlers answer from.
 *
 * A request with no readable origin, or one from a sub-frame, is refused rather than
 * asked: a prompt the user cannot attribute is a prompt they cannot judge, and a
 * third-party frame must never raise one that reads as the site they think they are on.
 */
export function permissionAsk(permission: string, details: PermissionDetails): PermissionAsk {
  if (ELSEWHERE.has(permission)) return { kind: 'elsewhere' }
  if (SILENT_ALLOW.has(permission)) return { kind: 'allow' }

  const origin = permissionOriginOf(details)
  const tell = TELL_ABOUT.has(permission)
  if (!origin) return { kind: 'refuse', permission, origin: '', tell: false }
  // a sub-frame gets no bar and no notice: whatever it says would carry a name the
  // user did not navigate to
  if (details.isMainFrame === false) return { kind: 'refuse', permission, origin, tell: false }
  if (!PROMPTABLE.has(permission)) return { kind: 'refuse', permission, origin, tell }

  if (permission === 'media') {
    const device = mediaName(details)
    // screen sharing in disguise — refuse, and let the notice say it was the screen
    if (!device) return { kind: 'refuse', permission: 'display-capture', origin, tell: true }
    return { kind: 'ask', permission: device, origin }
  }
  return { kind: 'ask', permission: permission as PermissionName, origin }
}

/** What one answer is filed under: this site, this permission. Not a blanket yes —
 *  allowing a microphone must never hand over the camera (B8). */
export function permissionKey(origin: string, permission: PermissionName): string {
  return `${origin} ${permission}`
}

/** The keys one answer settles. A user who allowed the camera+microphone pair has
 *  answered for each device too, so a later single-device call does not ask again. */
export function permissionKeysFor(origin: string, permission: PermissionName): string[] {
  if (permission === 'camera-and-microphone') {
    return [
      permissionKey(origin, 'camera-and-microphone'),
      permissionKey(origin, 'camera'),
      permissionKey(origin, 'microphone')
    ]
  }
  return [permissionKey(origin, permission)]
}
