import { previewKindForPath, isWebPagePath } from './preview'
import { formatRemoteKey, parseRemoteKey, resolveOnHost, type RemoteKey } from './remoteKey'

export type RouteSource = 'agent' | 'user' | 'address'

export type RouteDest = 'browser' | 'preview' | 'system' | 'drop'

export type RouteDropReason = 'blocked-scheme' | 'source-not-allowed' | 'unsupported-target'

export interface RouteDecision {
  dest: RouteDest
  target: string
  reason?: RouteDropReason
}

export const SEARCH_URL = 'https://duckduckgo.com/?q='

const HOST_LIKE = /^(localhost|[\w-]+(\.[\w-]+)+|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/

function drop(reason: RouteDropReason): RouteDecision {
  return { dest: 'drop', target: '', reason }
}

export function schemeOf(target: string): string {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(target)
  return m ? m[0].toLowerCase() : ''
}

function encodedPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

function fileUrlFor(p: string): string {
  return `file://${encodedPath(p)}`
}

export const MACHINE_PAGE_SCHEME = 'koloft-machine'

function hexOf(text: string): string {
  return [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function textOfHex(hex: string): string {
  return new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16)))
}

export function machinePageUrl(host: string, p: string): string {
  return `${MACHINE_PAGE_SCHEME}://${hexOf(host)}${encodedPath(p)}`
}

export function machinePageOf(url: string): RemoteKey | null {
  const u = urlOrNull(url)
  if (u?.protocol !== `${MACHINE_PAGE_SCHEME}:` || !/^(?:[0-9a-f]{2})+$/.test(u.hostname))
    return null
  try {
    return parseRemoteKey(formatRemoteKey(textOfHex(u.hostname), decodeURIComponent(u.pathname)))
  } catch {
    return null
  }
}

export function pagePathOf(url: string): string | null {
  const machine = machinePageOf(url)
  return machine ? formatRemoteKey(machine.host, machine.path) : fileUrlPath(url)
}

function machineTarget(key: string): RouteDecision {
  const remote = parseRemoteKey(key)
  return remote && isWebPagePath(remote.path)
    ? { dest: 'browser', target: machinePageUrl(remote.host, remote.path) }
    : drop('blocked-scheme')
}

function localTarget(p: string): RouteDecision {
  if (isWebPagePath(p)) return { dest: 'browser', target: fileUrlFor(p) }
  if (previewKindForPath(p)) return { dest: 'preview', target: p }
  return drop('unsupported-target')
}

function isHostPort(raw: string): boolean {
  const host = raw.split('/')[0]
  return !/\s/.test(raw) && HOST_LIKE.test(host) && !isWebPagePath(host)
}

function addressEntry(raw: string): RouteDecision {
  if (raw.startsWith('/')) return localTarget(raw)
  if (isHostPort(raw)) return { dest: 'browser', target: `http://${raw}` }
  return { dest: 'browser', target: SEARCH_URL + encodeURIComponent(raw) }
}

export function fileUrlPath(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'file:' ? decodeURIComponent(u.pathname) : null
  } catch {
    return null
  }
}

export function folderFileOf(
  entry: string,
  root: string | null
): { path: string; suffix: string } | null {
  if (!root || schemeOf(entry) || /^~?\//.test(entry) || /\s/.test(entry)) return null
  const path = resolveOnHost(`${root}/`, entry)
  if (!path.startsWith(`${root}/`)) return null
  const at = entry.search(/[?#]/)
  return { path, suffix: at < 0 ? '' : entry.slice(at) }
}

export function routeFor(target: string, source: RouteSource): RouteDecision {
  const raw = target.trim()
  if (!raw) return drop('unsupported-target')
  switch (schemeOf(raw)) {
    case '':
      return source === 'address' ? addressEntry(raw) : localTarget(raw)
    case 'http:':
    case 'https:':
    case `${MACHINE_PAGE_SCHEME}:`:
      return { dest: 'browser', target: raw }
    case 'ssh:':
      return machineTarget(raw)
    case 'file:': {
      if (source === 'address') return { dest: 'browser', target: raw }
      const p = fileUrlPath(raw)
      return p === null ? drop('unsupported-target') : localTarget(p)
    }
    case 'about:':
      return raw.toLowerCase() === 'about:blank'
        ? { dest: 'browser', target: 'about:blank' }
        : drop('blocked-scheme')
    case 'data:':
      return source === 'user' ? { dest: 'browser', target: raw } : drop('source-not-allowed')
    case 'mailto:':
    case 'tel:':
      return source === 'user' ? { dest: 'system', target: raw } : drop('source-not-allowed')
    default:
      return source === 'address' && isHostPort(raw) ? addressEntry(raw) : drop('blocked-scheme')
  }
}

export function opensAsWebTab(path: string): boolean {
  return routeFor(path, 'user').dest === 'browser'
}

export function canOpenExternally(target: string): boolean {
  const scheme = schemeOf(target.trim())
  return scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:' || scheme === 'tel:'
}

const DISCORD_DESKTOP_APP_HOST = '127.0.0.1'
const DISCORD_DESKTOP_APP_FIRST_PORT = 6463
const DISCORD_DESKTOP_APP_LAST_PORT = 6472
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function urlOrNull(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

// PLATFORM§39
export function webPageReachesDiscordDesktopApp(
  target: string,
  initiatorOrigin: string | undefined
): boolean {
  if (!initiatorOrigin) return false
  const from = urlOrNull(initiatorOrigin)
  if (from && LOOPBACK_HOSTS.has(from.hostname)) return false
  const to = urlOrNull(target)
  const port = Number(to?.port)
  return (
    to?.hostname === DISCORD_DESKTOP_APP_HOST &&
    port >= DISCORD_DESKTOP_APP_FIRST_PORT &&
    port <= DISCORD_DESKTOP_APP_LAST_PORT
  )
}

export function dedupKey(target: string): string {
  let u: URL
  try {
    u = new URL(target.trim())
  } catch {
    return target.trim()
  }
  const params = [...u.searchParams].sort((a, b) =>
    `${a[0]}=${a[1]}` < `${b[0]}=${b[1]}` ? -1 : 1
  )
  const query = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const path =
    u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname
  return `${u.protocol}//${u.host}${path}${query ? `?${query}` : ''}`
}
