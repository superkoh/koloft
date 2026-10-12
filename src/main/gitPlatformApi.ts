import type { GitAuthor, GitPlatform } from '@shared/types'
import { githubNoreply } from '@shared/gitAccountOps'
import {
  API_TIMEOUT_MS,
  GITHUB_API_URL,
  pushAccess,
  unreachable,
  whoami,
  type PushAccess
} from './githubApi'

const GITLAB_DEVELOPER_ACCESS = 30
const AZURE_SIGN_IN_PAGE = 203
const GITEA_NOREPLY_WITH_ID_SINCE: [number, number] = [1, 26]
export const BITBUCKET_API_URL = process.env.KOLOFT_BITBUCKET_API_URL || 'https://api.bitbucket.org'

export interface GitTarget {
  platform: GitPlatform
  url: string
}

export type Identity =
  | { ok: true; login: string; author?: GitAuthor; scopes: string[] | null }
  | { ok: false; error: 'expired' | 'offline' | 'failed' }

const EXPIRED: Identity = { ok: false, error: 'expired' }
const FAILED: Identity = { ok: false, error: 'failed' }

class Http {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {}
}

async function getJson(url: string, headers: Record<string, string>): Promise<Http> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Koloft', ...headers },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    redirect: 'manual'
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {}
  return new Http(res.status, body)
}

function field(body: unknown, ...keys: string[]): unknown {
  let at: unknown = body
  for (const k of keys)
    at = at && typeof at === 'object' ? (at as Record<string, unknown>)[k] : undefined
  return at
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })
const hostname = (url: string): string => new URL(url).hostname

async function azureGet(url: string, token: string): Promise<Http> {
  const r = await getJson(url, {
    Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
    'X-TFS-FedAuthRedirect': 'Suppress'
  })
  return r.status === AZURE_SIGN_IN_PAGE ? new Http(401, r.body) : r
}

export function githubApiBase(t: GitTarget): string {
  return t.platform === 'github' ? GITHUB_API_URL : `${t.url}/api/v3`
}

function versionAtLeast(version: string, [major, minor]: [number, number]): boolean {
  const m = /(\d+)\.(\d+)/.exec(version.split('gitea-').pop()!)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a > major || (a === major && b >= minor)
}

// PLATFORM§32 PLATFORM§51
async function whoAt(t: GitTarget, token: string): Promise<Identity> {
  switch (t.platform) {
    case 'github':
    case 'ghes': {
      const me = await whoami(token, githubApiBase(t))
      if (!me.ok) return me
      return {
        ok: true,
        login: me.login,
        scopes: me.scopes,
        ...(t.platform === 'github' && {
          author: { name: me.name, email: githubNoreply(me.id, me.login) }
        })
      }
    }
    case 'gitlab': {
      const r = await getJson(`${t.url}/api/v4/user`, bearer(token))
      if (r.status === 401) return EXPIRED
      const login = str(field(r.body, 'username'))
      const id = field(r.body, 'id')
      if (r.status !== 200 || !login || typeof id !== 'number') return FAILED
      const scopes = await getJson(`${t.url}/api/v4/personal_access_tokens/self`, bearer(token))
      const list = field(scopes.body, 'scopes')
      return {
        ok: true,
        login,
        scopes: scopes.status === 200 && Array.isArray(list) ? list.map(str) : null,
        author: {
          name: str(field(r.body, 'name')) || login,
          email:
            str(field(r.body, 'commit_email')) || `${id}-${login}@users.noreply.${hostname(t.url)}`
        }
      }
    }
    case 'gitea': {
      const r = await getJson(`${t.url}/api/v1/user`, bearer(token))
      if (r.status === 401) return EXPIRED
      const login = str(field(r.body, 'login'))
      const id = field(r.body, 'id')
      if (r.status !== 200 || !login || typeof id !== 'number') return FAILED
      const v = await getJson(`${t.url}/api/v1/version`, {})
      const withId = versionAtLeast(str(field(v.body, 'version')), GITEA_NOREPLY_WITH_ID_SINCE)
      return {
        ok: true,
        login,
        scopes: null,
        author: {
          name: str(field(r.body, 'full_name')) || login,
          email: `${withId ? `${id}+` : ''}${login}@noreply.${hostname(t.url)}`
        }
      }
    }
    case 'bitbucket': {
      const r = await getJson(`${BITBUCKET_API_URL}/2.0/user`, bearer(token))
      if (r.status === 401) return EXPIRED
      const login = str(field(r.body, 'username'))
      if (r.status !== 200 || !login) return FAILED
      const emails = await getJson(`${BITBUCKET_API_URL}/2.0/user/emails`, bearer(token))
      const list = field(emails.body, 'values')
      const primary = Array.isArray(list)
        ? list.find((e) => field(e, 'is_primary') === true)
        : undefined
      const email = str(field(primary, 'email'))
      return {
        ok: true,
        login,
        scopes: null,
        ...(email && { author: { name: str(field(r.body, 'display_name')) || login, email } })
      }
    }
    case 'azure': {
      const r = await azureGet(`${t.url}/_apis/connectionData`, token)
      if (r.status === 401) return EXPIRED
      const login =
        str(field(r.body, 'authenticatedUser', 'properties', 'Account', '$value')) ||
        str(field(r.body, 'authenticatedUser', 'providerDisplayName'))
      if (r.status !== 200 || !login) return FAILED
      return { ok: true, login, scopes: null }
    }
    case 'other':
      return FAILED
  }
}

export async function identify(t: GitTarget, token: string): Promise<Identity> {
  try {
    return await whoAt(t, token)
  } catch (e) {
    return { ok: false, error: unreachable(e) ? 'offline' : 'failed' }
  }
}

const SCOPES_NEEDED: Partial<Record<GitPlatform, string[]>> = {
  github: ['repo', 'read:org'],
  ghes: ['repo', 'read:org'],
  gitlab: ['write_repository', 'read_api']
}

export function missingScopeOn(platform: GitPlatform, scopes: string[] | null): string | undefined {
  if (scopes === null && platform === 'gitlab') return undefined
  return SCOPES_NEEDED[platform]?.find((s) => !(scopes ?? []).includes(s))
}

function access(status: number, allowed: () => boolean): PushAccess {
  if (status === 401) return { kind: 'expired' }
  if (status === 404 || status === 403) return { kind: 'none' }
  if (status !== 200) return { kind: 'offline' }
  return { kind: 'push', allowed: allowed() }
}

async function pushAt(t: GitTarget, token: string, repoPath: string): Promise<PushAccess> {
  const parts = repoPath.split('/')
  switch (t.platform) {
    case 'github':
    case 'ghes':
      return parts.length === 2
        ? pushAccess(token, parts[0], parts[1], githubApiBase(t))
        : { kind: 'none' }
    case 'gitlab': {
      const r = await getJson(
        `${t.url}/api/v4/projects/${encodeURIComponent(repoPath)}`,
        bearer(token)
      )
      return access(r.status, () =>
        ['project_access', 'group_access'].some((k) => {
          const level = field(r.body, 'permissions', k, 'access_level')
          return typeof level === 'number' && level >= GITLAB_DEVELOPER_ACCESS
        })
      )
    }
    case 'gitea': {
      if (parts.length !== 2) return { kind: 'none' }
      const r = await getJson(
        `${t.url}/api/v1/repos/${parts.map(encodeURIComponent).join('/')}`,
        bearer(token)
      )
      return access(r.status, () => field(r.body, 'permissions', 'push') === true)
    }
    case 'bitbucket': {
      if (parts.length !== 2) return { kind: 'none' }
      const q = encodeURIComponent(`repository.full_name="${repoPath}"`)
      const r = await getJson(
        `${BITBUCKET_API_URL}/2.0/user/permissions/repositories?q=${q}`,
        bearer(token)
      )
      return access(r.status, () => {
        const values = field(r.body, 'values')
        const permission = Array.isArray(values) ? str(field(values[0], 'permission')) : ''
        return permission === 'write' || permission === 'admin'
      })
    }
    case 'azure': {
      const at = parts.indexOf('_git')
      if (at !== 2 || parts.length !== 4) return { kind: 'none' }
      const [org, project, , repo] = parts.map(encodeURIComponent)
      const r = await azureGet(
        `${new URL(t.url).origin}/${org}/${project}/_apis/git/repositories/${repo}?api-version=7.1`,
        token
      )
      return access(r.status, () => true)
    }
    case 'other':
      return { kind: 'offline' }
  }
}

// PLATFORM§51
export async function pushAccessOn(
  t: GitTarget,
  token: string,
  repoPath: string
): Promise<PushAccess> {
  try {
    return await pushAt(t, token, repoPath)
  } catch {
    return { kind: 'offline' }
  }
}
