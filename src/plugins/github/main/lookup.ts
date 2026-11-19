import { slug, type Gh, type GithubFixture, type GithubFixtureEntry } from '@core/gh'
import type {
  GithubInfo,
  GithubOpenItems,
  GithubTarget,
  PrChecks,
  WorkspaceGithub
} from '@shared/types'
import {
  compareUrlOf,
  loginUrlFor,
  prNumbersByBranch,
  pullsUrlOf,
  repoUrlOf,
  type GithubRepo
} from '@shared/githubUrl'
import { failingChecksText, prChecks } from './prChecks'
import { listOpenItems } from './openItems'

const TTL_MS = 5 * 60_000
const OPEN_COUNTS_QUERY =
  'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount}}}'

type OpenCounts = Pick<WorkspaceGithub, 'issues' | 'prs'>

export function parseOpenCounts(stdout: string): OpenCounts | null {
  try {
    const r = JSON.parse(stdout)?.data?.repository
    const issues = r?.issues?.totalCount
    const prs = r?.pullRequests?.totalCount
    return Number.isInteger(issues) && Number.isInteger(prs) ? { issues, prs } : null
  } catch {
    return null
  }
}

function openCountsArgs(repo: GithubRepo): string[] {
  return [
    'api',
    'graphql',
    '-f',
    `owner=${repo.owner}`,
    '-f',
    `name=${repo.repo}`,
    '-f',
    `query=${OPEN_COUNTS_QUERY}`
  ]
}

export interface RepoSource {
  readonly fixture: GithubFixture | null
  repoOf(root: string, force: boolean): Promise<GithubRepo | null>
  ghFor(root: string): Gh | null
  ghOfRepo(root: string): Promise<{ repo: GithubRepo; gh: Gh } | null>
  git(root: string, args: string[], network?: boolean): Promise<string | null>
}

export interface LookupOptions {
  signedIn?: () => Promise<boolean>
  countedAs?: (root: string) => string | undefined
  now?: () => number
}

interface Entry {
  at: number
  prs: Map<string, number>
  failed: boolean
}

interface Local {
  repo: GithubRepo
  branch: string | null
}

interface GithubAnswer {
  now: GithubInfo | null
  settled: Promise<GithubInfo> | null
}

export class GithubLookup {
  private cache = new Map<string, Entry>()
  private inflight = new Map<string, Promise<Entry>>()
  private newest = new Map<string, number>()
  private counted = new Map<string, { at: number; counts: OpenCounts | null }>()
  private signedIn: () => Promise<boolean>

  constructor(
    private repos: RepoSource,
    private opts: LookupOptions = {}
  ) {
    this.signedIn = opts.signedIn ?? (async () => true)
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  async info(root: string, opts: { force?: boolean } = {}): Promise<GithubAnswer> {
    if (this.repos.fixture) return { now: fixtureInfo(this.repos.fixture[root]), settled: null }
    const local = await this.local(root, opts.force === true)
    if (!local) return { now: null, settled: null }
    const { repo, branch } = local
    const base = { repoUrl: repoUrlOf(repo), pullsUrl: pullsUrlOf(repo), branch }
    if (!branch) return { now: { ...base, pr: null, pending: false, failed: false }, settled: null }
    const key = slug(repo)
    const cached = this.cache.get(key)
    if (!opts.force && cached && this.now() - cached.at < TTL_MS) {
      return { now: { ...base, ...prOf(cached, branch) }, settled: null }
    }
    const run = this.lookup(key, root, opts.force === true)
    return {
      now: { ...base, pr: prOf(cached, branch).pr, pending: true, failed: false },
      settled: run.then((e) => ({ ...base, ...prOf(e, branch) }))
    }
  }

  async openCounts(root: string): Promise<WorkspaceGithub | null> {
    if (this.repos.fixture) return fixtureCounts(this.repos.fixture[root])
    const repo = await this.repos.repoOf(root, false)
    const gh = this.repos.ghFor(root)
    if (!repo || !gh) return null
    const key = `${this.opts.countedAs?.(root) ?? ''} ${slug(repo)}`
    let known = this.counted.get(key)
    if (!known || this.now() - known.at >= TTL_MS) {
      known = { at: this.now(), counts: await countsOf(gh, repo) }
      this.counted.set(key, known)
    }
    return known.counts && { repo: slug(repo), ...known.counts }
  }

  private async local(root: string, force: boolean): Promise<Local | null> {
    const repo = await this.repos.repoOf(root, force)
    if (!repo) return null
    const head = (await this.repos.git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? ''
    return { repo, branch: head && head !== 'HEAD' ? head : null }
  }

  async target(root: string, what: GithubTarget): Promise<string | null> {
    const { now } = await this.info(root)
    if (!now) return null
    const url =
      what === 'repo'
        ? now.repoUrl
        : what === 'issues'
          ? `${now.repoUrl}/issues`
          : what === 'pulls'
            ? now.pullsUrl
            : what === 'compare' && now.branch
              ? compareUrlOf(now.repoUrl, now.branch)
              : what === 'pr' && now.pr
                ? `${now.repoUrl}/pull/${now.pr}`
                : now.repoUrl
    if (this.repos.fixture) return url
    return (await this.signedIn()) ? url : loginUrlFor(url)
  }

  async checks(root: string, pr: number): Promise<PrChecks> {
    const at = await this.repos.ghOfRepo(root)
    return at ? prChecks(at.gh, at.repo, pr) : { state: 'failed' }
  }

  async openItems(root: string): Promise<GithubOpenItems> {
    const at = await this.repos.ghOfRepo(root)
    return at ? listOpenItems(at.gh, at.repo) : { state: 'no-repo' }
  }

  async failingChecksText(root: string, pr: number): Promise<string | null> {
    const at = await this.repos.ghOfRepo(root)
    return at && failingChecksText(at.gh, at.repo, pr)
  }

  private lookup(key: string, root: string, force = false): Promise<Entry> {
    const cur = this.inflight.get(key)
    if (cur && !force) return cur
    const mine = (this.newest.get(key) ?? 0) + 1
    this.newest.set(key, mine)
    const run = (async (): Promise<Entry> => {
      // PLATFORM§1
      const out = await this.repos.git(
        root,
        ['ls-remote', 'origin', 'refs/heads/*', 'refs/pull/*/head'],
        true
      )
      const e: Entry =
        out === null
          ? { at: this.now(), prs: new Map(), failed: true }
          : { at: this.now(), prs: prNumbersByBranch(out), failed: false }
      if (this.newest.get(key) === mine) this.cache.set(key, e)
      return e
    })().finally(() => {
      if (this.inflight.get(key) === run) this.inflight.delete(key)
    })
    this.inflight.set(key, run)
    return run
  }
}

export function githubLookups(opts: LookupOptions): (repos: RepoSource) => GithubLookup {
  const made = new WeakMap<RepoSource, GithubLookup>()
  return (repos) => {
    let lookup = made.get(repos)
    if (!lookup) made.set(repos, (lookup = new GithubLookup(repos, opts)))
    return lookup
  }
}

// PLATFORM§32
async function countsOf(gh: Gh, repo: GithubRepo): Promise<OpenCounts | null> {
  const r = await gh(openCountsArgs(repo))
  return r.code === 0 ? parseOpenCounts(r.stdout) : null
}

function prOf(
  e: Entry | undefined,
  branch: string | null
): Pick<GithubInfo, 'pr' | 'pending' | 'failed'> {
  return { pr: (e && branch && e.prs.get(branch)) || null, pending: false, failed: !!e?.failed }
}

function fixtureCounts(f: GithubFixtureEntry | null | undefined): WorkspaceGithub | null {
  if (!f || f.issues === undefined || f.prs === undefined) return null
  return { repo: slug(f), issues: f.issues, prs: f.prs }
}

function fixtureInfo(f: GithubFixtureEntry | null | undefined): GithubInfo | null {
  if (!f) return null
  const repo = { owner: f.owner, repo: f.repo }
  return {
    repoUrl: repoUrlOf(repo),
    pullsUrl: pullsUrlOf(repo),
    branch: f.branch ?? null,
    pr: f.pr ?? null,
    pending: false,
    failed: false
  }
}
