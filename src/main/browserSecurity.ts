import path from 'path'
import { BROWSER_PARTITION } from '@shared/types'
import { routeFor } from '@shared/browserRoute'

/**
 * The whitelists main enforces around the Browser (PRD §01 SEC-1/SEC-2, §05D-4 SEC-8,
 * §05D-5 SEC-10, §05D-1 SEC-12). Kept pure and apart from the wiring so each one can be
 * driven against the look-alikes it exists to refuse.
 */

/**
 * SEC-2: may the host window navigate here? The renderer runs Koloft's own preload (pty
 * spawn + account tokens) and it is re-injected after every navigation, so one
 * successful hop onto a remote origin is RCE. `appUrl` is the document the window was
 * loaded with — the dev server in dev, the bundled file in a package.
 */
export function isAppNavigation(target: string, appUrl: string): boolean {
  let to: URL
  let app: URL
  try {
    to = new URL(target)
    app = new URL(appUrl)
  } catch {
    return false
  }
  if (app.protocol === 'file:') return to.protocol === 'file:' && to.pathname === app.pathname
  return to.protocol === app.protocol && to.host === app.host
}

/**
 * Is `target` inside one of `roots`? Both sides are resolved first, and a root is a
 * DIRECTORY prefix rather than a string prefix (`/ws-evil` is not under `/ws`).
 *
 * Its one caller is isGuestPreload: a guest may only name a preload script out of
 * Koloft's own build output. (It used to back the `koloft-file://` read fence too;
 * removed that fence, so nothing here restricts which local files may be read.)
 */
export function isUnderAnyRoot(target: string, roots: readonly string[]): boolean {
  const file = path.resolve(target)
  return roots.some((raw) => {
    const root = path.resolve(raw)
    return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  })
}

/** SEC-8: the host a certificate exception is remembered under — the host alone, so a
 *  name spelled in a hash or in the userinfo cannot borrow another host's exception. */
export function certHostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : ''
  } catch {
    return ''
  }
}

/** SEC-8: exact host, never a suffix — an exception on `koloft-a.test` says nothing about
 *  `evil.koloft-a.test` or `koloft-a.test.evil.com`. */
export function certTrusted(hosts: ReadonlySet<string>, hostname: string): boolean {
  return hostname !== '' && hosts.has(hostname.toLowerCase())
}

/**
 * SEC-10: what a basic-auth challenge may ask the user, or null when it may not ask at
 * all. A sub-resource 401 inside someone else's page is a phishing primitive, and a
 * proxy challenge is not the page's to raise.
 *
 * `busy` is the same one-modal-slot rule `jsDialogFor` answers to, from the other
 * producer: a challenge may not paint over a guest that is stopped inside
 * alert/confirm/prompt, since nothing would be left on screen to release it. Refusing
 * costs that one request its credentials — the user reloads and is asked again.
 */
export function authPromptFor(
  details: { url: string; isRequestForNavigation: boolean },
  authInfo: { isProxy: boolean; realm: string },
  busy: boolean
): { origin: string; realm: string } | null {
  if (busy || authInfo.isProxy || !details.isRequestForNavigation) return null
  try {
    return { origin: new URL(details.url).origin, realm: authInfo.realm }
  } catch {
    return null
  }
}

/** SEC-4: how long a guest's own click or keystroke keeps authorizing an OS hand-off.
 *  Chromium's transient activation lasts 5s; a navigation follows the click that caused
 *  it within milliseconds, so this is the far tighter window — long enough for the trip
 *  through the browser process, short enough that a page cannot ride a click the user
 *  made on the page before it. */
export const GESTURE_WINDOW_MS = 1000

/**
 * SEC-4: whether an external-protocol request is the user's. Chromium hands the
 * permission handler no gesture flag, so main answers from the guest's own last input:
 * a page that assigns `location = 'mailto:…'` on a timer has none, and a `mailto:` link
 * the user clicked has one from the same instant.
 */
export function gestureFresh(at: number | undefined, now: number): boolean {
  return at !== undefined && now - at <= GESTURE_WINDOW_MS
}

const JS_DIALOG_KINDS = ['alert', 'confirm', 'prompt'] as const
/** a dialog is a sentence, not a payload: a page that hands over megabytes of text
 *  would paint over the surface it interrupts */
const DIALOG_TEXT_MAX = 1000

function dialogText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, DIALOG_TEXT_MAX) : ''
}

/**
 * §05D-11: what a guest's window.alert/confirm/prompt becomes on the way to Koloft's own
 * modal, or null when it must be answered with a cancel instead of asked. The request
 * crosses from a page's own renderer, so nothing in it is trusted: the kind is matched
 * against the three the modal renders, the text is text, and the origin in the header
 * is read off the asking frame — never off the payload, or a page could sign its
 * message as another site (the SEC-10 rule, same reason).
 *
 * `busy` refuses a second dialog while one is unanswered: the surface has one modal
 * slot, and a page blocked on a question nobody is ever shown never runs again.
 */
export function jsDialogFor(
  request: { kind?: unknown; message?: unknown; defaultValue?: unknown },
  frameUrl: string,
  busy: boolean
): {
  kind: (typeof JS_DIALOG_KINDS)[number]
  origin: string
  message: string
  defaultValue: string
} | null {
  if (busy) return null
  const kind = JS_DIALOG_KINDS.find((k) => k === request.kind)
  if (!kind) return null
  let frame: URL
  try {
    frame = new URL(frameUrl)
  } catch {
    return null
  }
  return {
    kind,
    // an opaque origin serializes to the literal "null", which reads as a site name
    origin: frame.origin === 'null' ? `${frame.protocol}//` : frame.origin,
    message: dialogText(request.message),
    defaultValue: kind === 'prompt' ? dialogText(request.defaultValue) : ''
  }
}

/**
 * SEC-12: the guest is a Chromium browser and says so — the Electron and app tokens are
 * a misleading self-description, not an identity. Nothing else about the string moves,
 * and this is applied to the browser partition only.
 */
export function standardUserAgent(fallback: string, appName: string): string {
  const app = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return fallback
    .replace(new RegExp(`\\s*\\b(?:Electron|${app})/\\S+`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * SEC-12b: SEC-12 leaves the guest's UA claiming Chrome, but Electron sends NO Sec-CH-UA
 * Client Hints at all (verified on live HTTPS) — a Chrome UA with no Client
 * Hints is itself the tell an embedder gives off (Google's sign-in gate reads them
 * server-side). Real Chrome always sends these three low-entropy hints on secure
 * contexts. This builds them from the guest's own UA — brand list carrying Google Chrome
 * at the Chrome major, so UA, Client Hints, `navigator.userAgentData` (guest preload) and
 * the genuinely-Chrome BoringSSL TLS stack tell one story. Null for a non-Chrome UA.
 */
export function chromeClientHints(ua: string): Record<string, string> | null {
  const major = /Chrome\/(\d+)/.exec(ua)
  if (!major) return null
  const v = major[1]
  const platform = /Windows/.test(ua)
    ? 'Windows'
    : /Mac/.test(ua)
      ? 'macOS'
      : /(Linux|X11|CrOS)/.test(ua)
        ? 'Linux'
        : 'Unknown'
  return {
    'Sec-CH-UA': `"Not;A=Brand";v="8", "Chromium";v="${v}", "Google Chrome";v="${v}"`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': `"${platform}"`
  }
}

/** The guest preferences this file decides on. `disablePopups` and
 *  `allowFileAccessFromFileUrls` are absent from Electron's WebPreferences typings and
 *  present in the object the attach event hands over: the first is what
 *  guest-view-manager derives from the `allowpopups` attribute, the second is a name the
 *  free-form `webpreferences` attribute string can carry into a guest. */
export interface GuestAttachPrefs {
  preload?: string
  nodeIntegration?: boolean
  contextIsolation?: boolean
  webSecurity?: boolean
  disablePopups?: boolean
  allowFileAccessFromFileUrls?: boolean
  autoplayPolicy?: string
}

/**
 * SEC-5/SEC-6: the profile every <webview> attaches with, forced at attach time rather
 * than trusted from the tag. The renderer's factory already authors it — this is what
 * keeps it true for a call site that forgets, since a guest that misses `partition`
 * lands silently in the default session, where the privileged `koloft-file://` reader
 * lives. Returns false when the attach may not happen at all.
 *
 * Two guests are legitimate: a Browser guest on the browser partition, and Preview's own
 * viewer, which is in the default session BECAUSE it reads `koloft-file://` (D6) and is
 * therefore admitted by what it loads. Anything else is refused.
 */
export function enforceGuestAttach(
  prefs: GuestAttachPrefs,
  params: Record<string, string>,
  hostPreload: string
): boolean {
  prefs.nodeIntegration = false
  prefs.contextIsolation = true
  prefs.webSecurity = true
  prefs.allowFileAccessFromFileUrls = false
  // R5/BB-N03: Electron ships autoplay wide open, so a page loads and is already making
  // noise. Muting the guest is not enough — a muted stream still counts as playing, and
  // the only state in which a guest is provably silent is one where its audio never
  // started. The document's own user activation is what unlocks it, exactly as in Chrome.
  prefs.autoplayPolicy = 'document-user-activation-required'
  if (!isGuestPreload(prefs.preload, hostPreload)) delete prefs.preload
  const browserGuest = params.partition === BROWSER_PARTITION
  // D12: a Browser guest's window.open must REACH main's window-open handler to become a
  // tab — Electron drops it inside the browser process while popups are off, and the
  // handler is what refuses the OS window. Nothing else may raise one at all.
  prefs.disablePopups = !browserGuest
  return browserGuest || (params.src ?? '').toLowerCase().startsWith('koloft-file://')
}

/**
 * G0-3: is this response a download by its own declaration? An attachment is never
 * rendered, so nothing about its bytes is in question — yet Chromium still MIME-sniffs
 * it, and until that sniff settles the transfer belongs to the frame that asked rather
 * than to the session. A body that trickles (or one shorter than the sniff buffer) can
 * sit there for its whole lifetime, so closing that tab cancels a download the user
 * already started. Marking exactly these responses `nosniff` is what hands them to the
 * session at the headers instead.
 *
 * Header names arrive in whatever case the server sent, and one may repeat.
 */
export function isAttachmentResponse(headers: Record<string, string | string[]>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-disposition') continue
    const values = Array.isArray(value) ? value : [value]
    // `attachment` is the disposition TYPE — a filename that merely contains the word
    // ("inline; filename=attachment.pdf") is not one
    if (values.some((v) => /^\s*attachment\s*(;|$)/i.test(String(v)))) return true
  }
  return false
}

export type GuestMenuAction = 'copy-link' | 'open-link' | 'save-image'

export interface GuestMenuEntry {
  action: GuestMenuAction
  label: string
  /** what the action operates on — the link for the first two, the image for the last */
  target: string
}

/**
 * SEC-4/D3: a link may be offered a tab only if the one routing table would give it one.
 * `file:` is the subtraction: Chromium refuses a remote page's `file:` link inside its
 * own renderer (setupGuestLinkReports), and a menu item that reaches main directly would
 * be the way around that refusal — the address bar stays the way to a local page.
 */
function opensInNewTab(link: string): boolean {
  const decision = routeFor(link, 'user')
  return decision.dest === 'browser' && !decision.target.toLowerCase().startsWith('file:')
}

/**
 * §05D-10/G0-1: what the guest's right-click menu offers for one click, or nothing at
 * all. The three items the PRD names and no others: a guest is a page Koloft hosts, not a
 * place to grow a second command surface.
 */
export function guestMenuItems(params: {
  linkURL: string
  srcURL: string
  mediaType: string
}): GuestMenuEntry[] {
  const items: GuestMenuEntry[] = []
  if (params.linkURL) {
    items.push({ action: 'copy-link', label: 'Copy Link', target: params.linkURL })
    if (opensInNewTab(params.linkURL)) {
      items.push({ action: 'open-link', label: 'Open Link in New Tab', target: params.linkURL })
    }
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ action: 'save-image', label: 'Save Image', target: params.srcURL })
  }
  return items
}

/** A preload runs before the page with the guest's privileges, so only Koloft's own build
 *  output is one — and never the host's, which carries the pty/account bridge (SEC-2). */
function isGuestPreload(preload: string | undefined, hostPreload: string): boolean {
  if (!preload) return false
  const host = path.resolve(hostPreload)
  return path.resolve(preload) !== host && isUnderAnyRoot(preload, [path.dirname(host)])
}
