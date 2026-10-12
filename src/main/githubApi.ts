export const GITHUB_API_URL = process.env.KOLOFT_GITHUB_API_URL || 'https://api.github.com'
const API_TIMEOUT_MS = 10_000
const UNREACHABLE_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN'])
const SCOPES_KOLOFT_NEEDS = ['repo', 'read:org'] as const

export type WhoAmI =
  | { ok: true; login: string; id: number; name: string; scopes: string[] }
  | { ok: false; error: 'expired' | 'offline' | 'failed' }

export type PushAccess =
  | { kind: 'push'; allowed: boolean }
  | { kind: 'none' }
  | { kind: 'expired' }
  | { kind: 'org-blocked'; org: string }
  | { kind: 'offline' }

function unreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
  const code = (e.cause as { code?: string } | undefined)?.code
  return (code !== undefined && UNREACHABLE_CODES.has(code)) || e.message === 'fetch failed'
}

function apiGet(route: string, token: string): Promise<Response> {
  return fetch(`${GITHUB_API_URL}${route}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Koloft'
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
}

// PLATFORM§32
export function scopesOf(header: string | null): string[] {
  return (header ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function missingScope(scopes: string[]): string | undefined {
  return SCOPES_KOLOFT_NEEDS.find((s) => !scopes.includes(s))
}

// PLATFORM§32
export async function whoami(token: string): Promise<WhoAmI> {
  try {
    const res = await apiGet('/user', token)
    if (res.status === 401) return { ok: false, error: 'expired' }
    if (!res.ok) return { ok: false, error: 'failed' }
    const body = (await res.json()) as { login?: unknown; id?: unknown; name?: unknown }
    if (typeof body.login !== 'string' || typeof body.id !== 'number')
      return { ok: false, error: 'failed' }
    return {
      ok: true,
      login: body.login,
      id: body.id,
      name: typeof body.name === 'string' && body.name ? body.name : body.login,
      scopes: scopesOf(res.headers.get('x-oauth-scopes'))
    }
  } catch (e) {
    return { ok: false, error: unreachable(e) ? 'offline' : 'failed' }
  }
}

const ORG_RESTRICTED = /OAuth App access restrictions/i
const ORG_NAMED = /the `([^`]+)` organization/

// PLATFORM§32
export async function pushAccess(token: string, owner: string, repo: string): Promise<PushAccess> {
  try {
    const res = await apiGet(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      token
    )
    if (res.status === 401) return { kind: 'expired' }
    if (res.status === 404) return { kind: 'none' }
    if (res.status === 403) {
      const message = String(((await res.json()) as { message?: unknown }).message ?? '')
      if (ORG_RESTRICTED.test(message))
        return { kind: 'org-blocked', org: ORG_NAMED.exec(message)?.[1] ?? owner }
      return { kind: 'offline' }
    }
    if (!res.ok) return { kind: 'offline' }
    const body = (await res.json()) as { permissions?: { push?: unknown } }
    return { kind: 'push', allowed: body.permissions?.push === true }
  } catch {
    return { kind: 'offline' }
  }
}
