import { previewKindForPath, isWebPagePath } from './preview'

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

function fileUrlFor(p: string): string {
  return `file://${p.split('/').map(encodeURIComponent).join('/')}`
}

function localTarget(p: string): RouteDecision {
  if (isWebPagePath(p)) return { dest: 'browser', target: fileUrlFor(p) }
  if (previewKindForPath(p)) return { dest: 'preview', target: p }
  return drop('unsupported-target')
}

function isHostPort(raw: string): boolean {
  return !/\s/.test(raw) && HOST_LIKE.test(raw.split('/')[0])
}

function addressEntry(raw: string): RouteDecision {
  if (isHostPort(raw)) return { dest: 'browser', target: `http://${raw}` }
  return { dest: 'browser', target: SEARCH_URL + encodeURIComponent(raw) }
}

export function routeFor(target: string, source: RouteSource): RouteDecision {
  const raw = target.trim()
  if (!raw) return drop('unsupported-target')
  switch (schemeOf(raw)) {
    case '':
      return source === 'address' ? addressEntry(raw) : localTarget(raw)
    case 'http:':
    case 'https:':
      return { dest: 'browser', target: raw }
    case 'file:': {
      if (source === 'address') return { dest: 'browser', target: raw }
      let p: string
      try {
        p = decodeURIComponent(new URL(raw).pathname)
      } catch {
        return drop('unsupported-target')
      }
      return localTarget(p)
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

export function canOpenExternally(target: string): boolean {
  const scheme = schemeOf(target.trim())
  return scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:' || scheme === 'tel:'
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
