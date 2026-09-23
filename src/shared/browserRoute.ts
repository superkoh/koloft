import { previewKindForPath, isWebPagePath } from './preview'

/**
 * Where a target came from. The address bar is its own source rather than a flavour of
 * 'user': SEC-13 gives it a stricter whitelist than an in-page click (http/https/file
 * only), so `data:` is legal from a page and refused when typed.
 */
export type RouteSource = 'agent' | 'user' | 'address'

export type RouteDest = 'browser' | 'preview' | 'system' | 'drop'

export type RouteDropReason =
  /** the scheme is outside the whitelist (SEC-4/SEC-13) — javascript:, chrome://,
   *  devtools://, koloft-file:, zoom:, vscode:, … */
  | 'blocked-scheme'
  /** a legal scheme this source may not use — data: outside a page, mailto:/tel:
   *  without a user action */
  | 'source-not-allowed'
  /** nothing in Koloft renders it (a non-previewable, non-page local file) */
  | 'unsupported-target'

export interface RouteDecision {
  dest: RouteDest
  /** an absolute URL for 'browser' / 'system', an absolute file path for 'preview',
   *  empty for 'drop' */
  target: string
  /** why nothing happens — SEC-4 requires a dropped navigation to tell the user */
  reason?: RouteDropReason
}

export const SEARCH_URL = 'https://duckduckgo.com/?q='

/** host[:port] as the first segment of a scheme-less address-bar entry — a dotted
 *  name, an IPv4 literal, or `localhost`. Anything else is a search query. */
const HOST_LIKE = /^(localhost|[\w-]+(\.[\w-]+)+|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/

function drop(reason: RouteDropReason): RouteDecision {
  return { dest: 'drop', target: '', reason }
}

function schemeOf(target: string): string {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(target)
  return m ? m[0].toLowerCase() : ''
}

function fileUrlFor(p: string): string {
  return `file://${p.split('/').map(encodeURIComponent).join('/')}`
}

/** D5/C-21: a local target lands by extension, never by the scheme that carried it. */
function localTarget(p: string): RouteDecision {
  if (isWebPagePath(p)) return { dest: 'browser', target: fileUrlFor(p) }
  if (previewKindForPath(p)) return { dest: 'preview', target: p }
  return drop('unsupported-target')
}

/** `localhost:5173` parses as a scheme — a port behind the colon is what tells a
 *  scheme-less host entry apart from `zoommtg:`. */
function isHostPort(raw: string): boolean {
  return !/\s/.test(raw) && HOST_LIKE.test(raw.split('/')[0])
}

function addressEntry(raw: string): RouteDecision {
  if (isHostPort(raw)) return { dest: 'browser', target: `http://${raw}` }
  return { dest: 'browser', target: SEARCH_URL + encodeURIComponent(raw) }
}

/**
 * D3: the single routing table (§05B). Main holds it; the `open` shim only hands
 * targets over, so scheme/host judgement never gets a second, drifting copy.
 *
 * The scheme switch is the whitelist itself — every unlisted scheme falls through to a
 * drop, which is what keeps `javascript:` (self-XSS from the address bar) and
 * `chrome://` / `devtools://` out without a block list to keep in sync. `file:` is
 * deliberately absent from the OS hand-off: only http/https/mailto/tel may ever reach
 * the system opener, and only on a user action (SEC-4).
 *
 * A bare path must already be absolute — main resolves a relative one against the open
 * request's cwd before routing.
 */
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

/**
 * SEC-4: the guard on the one choke point that leaves Koloft (`shell.openExternal`, the
 * ↗ escape hatch, the `open` fallback). Routing already decides *whether* to hand a
 * target over; this decides what the OS may ever be handed at all, so a page that
 * reaches the choke point another way still cannot make Koloft launch
 * `file:///Applications/Evil.app` or an arbitrary `vscode:` handler.
 */
export function canOpenExternally(target: string): boolean {
  const scheme = schemeOf(target.trim())
  return scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:' || scheme === 'tel:'
}

/**
 * D4③: two targets share a tab when their origin + path + query match. The PRD leaves
 * the normalization to us; this is the pinned reading (BB-C58):
 *  - scheme, host case and the default port come from the URL parser (`http://H:80/p`
 *    and `http://h/p` are one key);
 *  - a trailing slash on a non-root path is dropped (`/p/` == `/p`);
 *  - query parameters are sorted by name then value and re-encoded, so order and
 *    `+` vs `%20` do not split a tab — the cost is that `?a=1&a=2` and `?a=2&a=1`
 *    also merge;
 *  - the path stays case-sensitive, and the hash is dropped entirely (SEC-15 logs
 *    that `#1..#N` flooding is held off by the per-session cap, not by this key).
 * A target that is not a URL keys as itself.
 */
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
