export interface GithubRepo {
  owner: string
  repo: string
}

function isGithubHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'github.com' || h === 'www.github.com'
}

function ownerRepoOf(pathname: string): GithubRepo | null {
  const parts = pathname
    .replace(/\.git$/i, '')
    .split('/')
    .filter((s) => s !== '')
  if (parts.length !== 2) return null
  return { owner: parts[0], repo: parts[1] }
}

export function parseGithubRemote(url: string): GithubRepo | null {
  const raw = url.trim()
  if (!raw) return null
  if (!raw.includes('://')) {
    const m = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(raw)
    if (!m || !isGithubHost(m[1])) return null
    return ownerRepoOf(m[2])
  }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (!isGithubHost(u.hostname)) return null
  return ownerRepoOf(decodeURIComponent(u.pathname))
}

export function pickRemoteUrl(configOut: string): string | null {
  const urls = new Map<string, string>()
  for (const line of configOut.split('\n')) {
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    const m = /^remote\.(.+)\.url$/.exec(line.slice(0, sp))
    const url = line.slice(sp + 1).trim()
    if (m && url && !urls.has(m[1])) urls.set(m[1], url)
  }
  const origin = urls.get('origin')
  if (origin) return origin
  return urls.size === 1 ? [...urls.values()][0] : null
}

export function prNumbersByBranch(lsRemoteOut: string): Map<string, number> {
  const heads: [string, string][] = []
  const pulls = new Map<string, number>()
  for (const line of lsRemoteOut.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const sha = line.slice(0, tab).trim()
    const ref = line.slice(tab + 1).trim()
    if (ref.startsWith('refs/heads/')) {
      heads.push([ref.slice('refs/heads/'.length), sha])
      continue
    }
    const m = /^refs\/pull\/(\d+)\/head$/.exec(ref)
    if (!m) continue
    const n = parseInt(m[1], 10)
    const cur = pulls.get(sha)
    if (cur === undefined || n > cur) pulls.set(sha, n)
  }
  const out = new Map<string, number>()
  for (const [branch, sha] of heads) {
    const n = pulls.get(sha)
    if (n !== undefined) out.set(branch, n)
  }
  return out
}

export function repoUrlOf(r: GithubRepo): string {
  return `https://github.com/${r.owner}/${r.repo}`
}

export function pullsUrlOf(r: GithubRepo): string {
  return `${repoUrlOf(r)}/pulls`
}

// PLATFORM§32
export function loginUrlFor(target: string): string {
  let back = ''
  try {
    const u = new URL(target)
    back = u.pathname + u.search
  } catch {
    return 'https://github.com/login'
  }
  return `https://github.com/login?return_to=${encodeURIComponent(back)}`
}
