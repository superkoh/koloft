import {
  GIT_PLATFORMS,
  type GitAccount,
  type GitAuthor,
  type GitPlatform,
  type GitRepoPick
} from './types'

export const GITHUB_DOT_COM = 'https://github.com'
export const GIT_LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,99}$/

export const FIXED_PLATFORM_URL: Partial<Record<GitPlatform, string>> = {
  github: GITHUB_DOT_COM,
  bitbucket: 'https://bitbucket.org'
}

export const GIT_PLATFORM_CHIP: Record<GitPlatform, string> = {
  github: 'GitHub',
  ghes: 'GitHub Enterprise',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azure: 'Azure DevOps',
  gitea: 'Gitea / Forgejo / Codeberg',
  other: 'Other server'
}

const PLATFORM_NAME: Record<GitPlatform, string> = {
  ...GIT_PLATFORM_CHIP,
  gitea: 'Gitea',
  other: 'git server'
}

const PUBLIC_HOST: Partial<Record<GitPlatform, string>> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  azure: 'dev.azure.com',
  gitea: 'codeberg.org'
}

export function gitPlatformName(platform: GitPlatform): string {
  return PLATFORM_NAME[platform]
}

export function gitHostLabel(a: { platform: GitPlatform; host: string }): string {
  return PUBLIC_HOST[a.platform] === a.host || a.platform === 'other'
    ? a.host
    : `${a.host} · ${PLATFORM_NAME[a.platform]}`
}

export function gitBaseUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  let u: URL
  try {
    u = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password || !u.hostname) return null
  const path = u.pathname.replace(/\/+$/, '')
  return `${u.origin}${path}`
}

export function gitAccountUrl(platform: GitPlatform, raw: string): string | null {
  const fixed = FIXED_PLATFORM_URL[platform]
  if (fixed) return fixed
  const url = gitBaseUrl(raw || (platform === 'gitlab' ? 'https://gitlab.com' : ''))
  if (!url) return null
  if (platform === 'azure' && new URL(url).pathname.split('/').filter(Boolean).length !== 1)
    return null
  return url
}

export type GitSignIn = 'gh' | 'browser' | 'token'

export function gitSignIn(platform: GitPlatform, url: string): GitSignIn {
  if (platform === 'github') return 'gh'
  if (platform === 'ghes') return new URL(url).port ? 'token' : 'gh'
  if (platform === 'gitlab') return new URL(url).hostname === 'gitlab.com' ? 'browser' : 'token'
  return platform === 'bitbucket' || platform === 'gitea' ? 'browser' : 'token'
}

export function gitHostOf(url: string): string {
  return new URL(url).host.toLowerCase()
}

export function gitCredentialUrl(url: string): string {
  return new URL(url).origin
}

export function gitAccountId(host: string, login: string): string {
  return `${host}/${login}`.toLowerCase()
}

function sanitizeAuthor(raw: unknown): GitAuthor | undefined {
  const a = raw as Partial<GitAuthor> | undefined
  if (!a || typeof a.email !== 'string' || !a.email.includes('@')) return undefined
  return { name: typeof a.name === 'string' ? a.name : '', email: a.email }
}

type StoredAccount = Partial<GitAccount> & { id?: unknown; name?: unknown }

function upgradedFromGithubOnly(a: StoredAccount): Partial<GitAccount> {
  if (a.platform || a.host !== 'github.com' || typeof a.login !== 'string') return a
  const numericId = typeof a.id === 'number' && a.id > 0 ? a.id : undefined
  return {
    ...a,
    id: undefined,
    platform: 'github',
    url: GITHUB_DOT_COM,
    ...(numericId !== undefined && {
      author: {
        name: typeof a.name === 'string' && a.name ? a.name : a.login,
        email: `${numericId}+${a.login}@users.noreply.github.com`
      }
    })
  }
}

export function sanitizeGitAccounts(raw: unknown): GitAccount[] {
  if (!Array.isArray(raw)) return []
  const out: GitAccount[] = []
  for (const stored of raw as StoredAccount[]) {
    if (!stored || typeof stored !== 'object') continue
    const a = upgradedFromGithubOnly(stored)
    if (!a.platform || !GIT_PLATFORMS.includes(a.platform)) continue
    if (typeof a.login !== 'string' || !GIT_LOGIN_RE.test(a.login)) continue
    const url = typeof a.url === 'string' ? gitBaseUrl(a.url) : null
    if (!url) continue
    const host = gitHostOf(url)
    const id = gitAccountId(host, a.login)
    if (out.some((o) => o.id === id)) continue
    const author = sanitizeAuthor(a.author)
    out.push({
      id,
      platform: a.platform,
      url,
      host,
      login: a.login,
      ...(author && { author }),
      ...(typeof a.gcmNamespace === 'string' &&
        /^[A-Za-z0-9-]+$/.test(a.gcmNamespace) && { gcmNamespace: a.gcmNamespace }),
      default: a.default === true,
      status: a.status === 'expired' || a.status === 'unverified' ? a.status : 'ok',
      addedAt: typeof a.addedAt === 'number' ? a.addedAt : 0
    })
  }
  return withOneDefaultPerHost(out)
}

export function withOneDefaultPerHost(accounts: GitAccount[]): GitAccount[] {
  const seen = new Set<string>()
  const out = accounts.map((a) => {
    const keep = a.default && !seen.has(a.host)
    if (keep) seen.add(a.host)
    return keep === a.default ? a : { ...a, default: keep }
  })
  return out.map((a) => {
    if (seen.has(a.host)) return a
    seen.add(a.host)
    return { ...a, default: true }
  })
}

export function sanitizeGitPicks(raw: unknown, accounts: GitAccount[]): GitRepoPick[] {
  if (!Array.isArray(raw)) return []
  const out: GitRepoPick[] = []
  for (const p of raw as (Partial<GitRepoPick> & { host?: unknown; login?: unknown })[]) {
    if (!p || typeof p.repo !== 'string' || !p.repo.startsWith('/')) continue
    const account =
      typeof p.account === 'string'
        ? p.account
        : typeof p.host === 'string' && typeof p.login === 'string'
          ? gitAccountId(p.host, p.login)
          : undefined
    if (!account || !accounts.some((a) => a.id === account)) continue
    if (out.some((o) => o.repo === p.repo)) continue
    out.push({ repo: p.repo, account })
  }
  return out
}
