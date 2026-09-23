/**
 *) —
 * everything the GitHub button works out from text: which remote to use, what repository
 * its url names, and which pull request a branch belongs to.
 *
 * Pure on purpose. Running git and caching the answer is `src/main/github.ts`; this file
 * only reads what git printed, so every rule here is testable without a repo.
 */

export interface GithubRepo {
  owner: string
  repo: string
}

/** github.com and nothing else (D5) — an enterprise host is treated as "not GitHub". */
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

/**
 * The repository a remote url names, or null when it is not a github.com one.
 *
 * Four spellings, because git accepts four: `git@github.com:o/r.git` (scp-like, no
 * scheme), and `https://`, `ssh://`, `git://` urls. The scp-like form has to be matched
 * first — it has a colon but no `//`, so a url parser reads `github.com` as the scheme.
 */
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

/**
 * Which remote to ask, from `git config --get-regexp '^remote\..*\.url'`.
 *
 * `origin` when there is one; the only remote when there is exactly one; otherwise null
 * (§10 — with two remotes and no `origin` the button does not guess, it stays away).
 */
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

/**
 * Branch → pull-request number, from one
 * `git ls-remote origin 'refs/heads/*' 'refs/pull/*\/head'`.
 *
 * A branch and its pull request are matched by COMMIT, not by name: `refs/pull/N/head` is
 * the same commit as the branch it was opened from, so a local commit that has not been
 * pushed cannot produce a wrong number. D7 — a commit that several pull requests point at
 * answers with the highest number, i.e. the most recently opened one.
 */
export function prNumbersByBranch(lsRemoteOut: string): Map<string, number> {
  const heads: [string, string][] = []
  /** commit → highest pull-request number pointing at it */
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

/**
 * D1 — the page to open when the built-in browser has never signed in to GitHub. A
 * private repository answers 404 rather than a login form, which reads as a broken
 * button; this sends the user to the login page and lets GitHub bring them back.
 * `return_to` is a path, not a whole url.
 *
 * That GitHub honours it at all is a fact about GitHub, not about this code, and nothing
 * here can prove it — so it was checked by hand (signed out, private repo):
 * the login page appears, and the same tab lands on the target once the login completes.
 * Re-check before simplifying this away.
 */
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
