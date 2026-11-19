import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { ghJsonArray, slug, type Gh, type GhResult, type GithubFixture } from '@core/gh'
import { parseGithubRemote, pickRemoteUrl, type GithubRepo } from '@shared/githubUrl'
import { credentialGuardEnv, FETCH_TIMEOUT_MS, LOCAL_TIMEOUT_MS } from './gitFreshness'

const execFile = promisify(execFileCb)
const TTL_MS = 5 * 60_000
const MAX_BUFFER = 16 * 1024 * 1024
const MERGED_PULLS_IN_ONE_PAGE = 100

export function parseGithubFixture(raw: string | undefined): GithubFixture | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as GithubFixture) : null
  } catch {
    return null
  }
}

export interface GithubReposOptions {
  fixture?: GithubFixture | null
  gitBin?: string
  git?: (root: string, args: string[], network: boolean) => Promise<string | null>
  gh?: (args: string[], root: string) => Promise<GhResult>
  now?: () => number
}

// PLATFORM§1
export class GithubRepos {
  private repos = new Map<string, { at: number; repo: GithubRepo | null }>()
  readonly fixture: GithubFixture | null
  private gitBin: string

  constructor(private opts: GithubReposOptions = {}) {
    this.fixture = opts.fixture ?? null
    this.gitBin = opts.gitBin ?? 'git'
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  async ownerSlashName(root: string, fresh = false): Promise<string | null> {
    const repo = this.fixture ? this.fixture[root] : await this.repoOf(root, fresh)
    return repo ? slug(repo) : null
  }

  async repoOf(root: string, force: boolean): Promise<GithubRepo | null> {
    let known = this.repos.get(root)
    if (force || !known || this.now() - known.at >= TTL_MS) {
      const out = await this.git(root, ['config', '--get-regexp', '^remote\\..*\\.url'])
      const url = out === null ? null : pickRemoteUrl(out)
      known = { at: this.now(), repo: url ? parseGithubRemote(url) : null }
      this.repos.set(root, known)
    }
    return known.repo
  }

  async repoFor(root: string): Promise<GithubRepo | null> {
    if (!this.fixture) return this.repoOf(root, false)
    const f = this.fixture[root]
    return f ? { owner: f.owner, repo: f.repo } : null
  }

  ghFor(root: string): Gh | null {
    const gh = this.opts.gh
    return gh ? (args) => gh(args, root) : null
  }

  async ghOfRepo(root: string): Promise<{ repo: GithubRepo; gh: Gh } | null> {
    const repo = await this.repoFor(root)
    const gh = this.ghFor(root)
    return repo && gh ? { repo, gh } : null
  }

  async mergedHeads(root: string, branch: string): Promise<string[] | null> {
    const heads = await this.mergedHeadsByBranch(root, ['--head', branch])
    return heads && (heads.get(branch) ?? [])
  }

  // PLATFORM§32
  async mergedHeadsByBranch(
    root: string,
    by = ['--limit', String(MERGED_PULLS_IN_ONE_PAGE)]
  ): Promise<Map<string, string[]> | null> {
    const repo = await this.repoFor(root)
    if (!repo) return new Map()
    const gh = this.ghFor(root)
    if (!gh) return null
    const r = await gh([
      'pr',
      'list',
      '--repo',
      slug(repo),
      '--state',
      'merged',
      ...by,
      '--json',
      'headRefName,headRefOid'
    ])
    const prs = r.code === 0 ? ghJsonArray(r.stdout) : null
    if (!prs) return null
    const heads = new Map<string, string[]>()
    for (const p of prs)
      if (typeof p?.headRefName === 'string' && typeof p?.headRefOid === 'string')
        heads.set(p.headRefName, [...(heads.get(p.headRefName) ?? []), p.headRefOid])
    return heads
  }

  async git(root: string, args: string[], remote = false): Promise<string | null> {
    if (this.opts.git) return this.opts.git(root, args, remote)
    try {
      const { stdout } = await execFile(this.gitBin, ['-C', root, ...args], {
        timeout: remote ? FETCH_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: remote
          ? credentialGuardEnv({ ...process.env, GIT_OPTIONAL_LOCKS: '0' })
          : { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
      })
      return stdout
    } catch {
      return null
    }
  }
}
