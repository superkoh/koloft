import path from 'path'
import { BROWSER_PARTITION } from '@shared/types'
import { routeFor } from '@shared/browserRoute'

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

export function isUnderAnyRoot(target: string, roots: readonly string[]): boolean {
  const file = path.resolve(target)
  return roots.some((raw) => {
    const root = path.resolve(raw)
    return file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
  })
}

export function certHostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : ''
  } catch {
    return ''
  }
}

export function certTrusted(hosts: ReadonlySet<string>, hostname: string): boolean {
  return hostname !== '' && hosts.has(hostname.toLowerCase())
}

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

// PLATFORM§11
export const GESTURE_WINDOW_MS = 1000

export function gestureFresh(at: number | undefined, now: number): boolean {
  return at !== undefined && now - at <= GESTURE_WINDOW_MS
}

const JS_DIALOG_KINDS = ['alert', 'confirm', 'prompt'] as const
const DIALOG_TEXT_MAX = 1000

function dialogText(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, DIALOG_TEXT_MAX) : ''
}

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
    origin: frame.origin === 'null' ? `${frame.protocol}//` : frame.origin,
    message: dialogText(request.message),
    defaultValue: kind === 'prompt' ? dialogText(request.defaultValue) : ''
  }
}

export function standardUserAgent(fallback: string, appName: string): string {
  const app = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return fallback
    .replace(new RegExp(`\\s*\\b(?:Electron|${app})/\\S+`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// PLATFORM§14
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

// PLATFORM§8
export interface GuestAttachPrefs {
  preload?: string
  nodeIntegration?: boolean
  contextIsolation?: boolean
  webSecurity?: boolean
  disablePopups?: boolean
  allowFileAccessFromFileUrls?: boolean
  autoplayPolicy?: string
}

export function enforceGuestAttach(
  prefs: GuestAttachPrefs,
  params: Record<string, string>,
  hostPreload: string
): boolean {
  prefs.nodeIntegration = false
  prefs.contextIsolation = true
  prefs.webSecurity = true
  prefs.allowFileAccessFromFileUrls = false
  // PLATFORM§13
  prefs.autoplayPolicy = 'document-user-activation-required'
  if (!isGuestPreload(prefs.preload, hostPreload)) delete prefs.preload
  const browserGuest = params.partition === BROWSER_PARTITION
  // PLATFORM§8
  prefs.disablePopups = !browserGuest
  return browserGuest || (params.src ?? '').toLowerCase().startsWith('koloft-file://')
}

// PLATFORM§13
export function isAttachmentResponse(headers: Record<string, string | string[]>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-disposition') continue
    const values = Array.isArray(value) ? value : [value]
    if (values.some((v) => /^\s*attachment\s*(;|$)/i.test(String(v)))) return true
  }
  return false
}

export type GuestMenuAction = 'copy-link' | 'open-link' | 'save-image'

export interface GuestMenuEntry {
  action: GuestMenuAction
  label: string
  target: string
}

function opensInNewTab(link: string): boolean {
  const decision = routeFor(link, 'user')
  return decision.dest === 'browser' && !decision.target.toLowerCase().startsWith('file:')
}

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

function isGuestPreload(preload: string | undefined, hostPreload: string): boolean {
  if (!preload) return false
  const host = path.resolve(hostPreload)
  return path.resolve(preload) !== host && isUnderAnyRoot(preload, [path.dirname(host)])
}
