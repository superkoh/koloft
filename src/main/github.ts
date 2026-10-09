import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import type {
  GithubInfo,
  GithubItem,
  GithubOpenItems,
  GithubTarget,
  PrChecks,
  WorkspaceGithub
} from '@shared/types'
import type { GithubRepo } from '@shared/githubUrl'
import {
  compareUrlOf,
  loginUrlFor,
  parseGithubRemote,
  pickRemoteUrl,
  prNumbersByBranch,
  pullsUrlOf,
  repoUrlOf
} from '@shared/githubUrl'
import { credentialGuardEnv, FETCH_TIMEOUT_MS, LOCAL_TIMEOUT_MS } from './gitFreshness'
import {
  failingChecksText,
  GH_SIGNED_OUT,
  ghJsonArray,
  prChecks,
  slug,
  type Gh,
  type GhResult
} from './prChecks'

const execFile = promisify(execFileCb)
const TTL_MS = 5 * 60_000
const MAX_BUFFER = 16 * 1024 * 1024
const OPEN_COUNTS_QUERY =
  'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount}}}'

export type OpenCounts = Pick<WorkspaceGithub, 'issues' | 'prs'>

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

// PLATFORM§32
export async function ghOpenCounts(repo: GithubRepo): Promise<OpenCounts | null> {
  const { ok, out } = await ghRead([
    'api',
    'graphql',
    '-f',
    `owner=${repo.owner}`,
    '-f',
    `name=${repo.repo}`,
    '-f',
    `query=${OPEN_COUNTS_QUERY}`
  ])
  return ok ? parseOpenCounts(out) : null
}

const OPEN_ITEMS_LIMIT = 50

function itemsOf(stdout: string, kind: GithubItem['kind']): GithubItem[] | null {
  const v = ghJsonArray(stdout)
  if (!v) return null
  return v
    .filter(
      (x) =>
        x &&
        Number.isInteger(x.number) &&
        typeof x.title === 'string' &&
        typeof x.url === 'string' &&
        typeof x.updatedAt === 'string' &&
        (kind === 'issue' || typeof x.headRefName === 'string')
    )
    .map((x) => ({
      kind,
      number: x.number,
      title: x.title,
      url: x.url,
      updatedAt: x.updatedAt,
      ...(kind === 'pr'
        ? { branch: x.isCrossRepository === true ? `pr-${x.number}` : x.headRefName }
        : {})
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// PLATFORM§32
function parseOpenItems(repo: string, issues: GhResult, prs: GhResult): GithubOpenItems {
  if (issues.missing || prs.missing) return { state: 'no-gh' }
  if (issues.code === GH_SIGNED_OUT || prs.code === GH_SIGNED_OUT) return { state: 'signed-out' }
  const i = itemsOf(issues.stdout, 'issue')
  const p = itemsOf(prs.stdout, 'pr')
  return i && p ? { state: 'items', repo, issues: i, prs: p } : { state: 'failed' }
}

export async function listOpenItems(gh: Gh, repo: GithubRepo): Promise<GithubOpenItems> {
  const list = (what: 'issue' | 'pr', fields: string): Promise<GhResult> =>
    gh([
      what,
      'list',
      '--repo',
      slug(repo),
      '--state',
      'open',
      '--limit',
      String(OPEN_ITEMS_LIMIT),
      '--json',
      fields
    ])
  const [issues, prs] = await Promise.all([
    list('issue', 'number,title,url,updatedAt'),
    list('pr', 'number,title,url,updatedAt,headRefName,isCrossRepository')
  ])
  return parseOpenItems(slug(repo), issues, prs)
}

export async function ghRead(args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await execFile('gh', args, {
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER
    })
    return { ok: true, out: stdout }
  } catch (error) {
    const e = error as Error & { stderr?: string }
    return { ok: false, out: e.stderr?.trim() || e.message }
  }
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

export interface GithubAnswer {
  now: GithubInfo | null
  settled: Promise<GithubInfo> | null
}

export interface GithubFixture {
  [root: string]: {
    owner: string
    repo: string
    branch?: string | null
    pr?: number | null
    issues?: number
    prs?: number
  } | null
}

export function parseGithubFixture(raw: string | undefined): GithubFixture | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as GithubFixture) : null
  } catch {
    return null
  }
}

export interface GithubOptions {
  signedIn?: () => Promise<boolean>
  fixture?: GithubFixture | null
  gitBin?: string
  git?: (root: string, args: string[], network: boolean) => Promise<string | null>
  openCounts?: (repo: GithubRepo) => Promise<OpenCounts | null>
  gh?: Gh
  now?: () => number
}

// PLATFORM§1
export class GithubLookup {
  private cache = new Map<string, Entry>()
  private repos = new Map<string, { at: number; repo: GithubRepo | null }>()
  private inflight = new Map<string, Promise<Entry>>()
  private newest = new Map<string, number>()
  private counted = new Map<string, { at: number; counts: OpenCounts | null }>()
  private signedIn: () => Promise<boolean>
  private fixture: GithubFixture | null
  private gitBin: string

  constructor(private opts: GithubOptions = {}) {
    this.signedIn = opts.signedIn ?? (async () => true)
    this.fixture = opts.fixture ?? null
    this.gitBin = opts.gitBin ?? 'git'
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  async info(root: string, opts: { force?: boolean } = {}): Promise<GithubAnswer> {
    if (this.fixture) return { now: fixtureInfo(this.fixture, root), settled: null }
    const local = await this.local(root, opts.force === true)
    if (!local) return { now: null, settled: null }
    const { repo, branch } = local
    const base = { repoUrl: repoUrlOf(repo), pullsUrl: pullsUrlOf(repo), branch }
    if (!branch) return { now: { ...base, pr: null, pending: false, failed: false }, settled: null }
    const key = `${repo.owner}/${repo.repo}`
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
    if (this.fixture) return fixtureCounts(this.fixture, root)
    const repo = await this.repoOf(root, false)
    if (!repo || !this.opts.openCounts) return null
    const key = `${repo.owner}/${repo.repo}`
    let known = this.counted.get(key)
    if (!known || this.now() - known.at >= TTL_MS) {
      known = { at: this.now(), counts: await this.opts.openCounts(repo) }
      this.counted.set(key, known)
    }
    return known.counts && { repo: key, ...known.counts }
  }

  async ownerSlashName(root: string): Promise<string | null> {
    const repo = this.fixture ? this.fixture[root] : await this.repoOf(root, false)
    return repo ? `${repo.owner}/${repo.repo}` : null
  }

  private async repoOf(root: string, force: boolean): Promise<GithubRepo | null> {
    let known = this.repos.get(root)
    if (force || !known || this.now() - known.at >= TTL_MS) {
      const out = await this.git(root, ['config', '--get-regexp', '^remote\\..*\\.url'])
      const url = out === null ? null : pickRemoteUrl(out)
      known = { at: this.now(), repo: url ? parseGithubRemote(url) : null }
      this.repos.set(root, known)
    }
    return known.repo
  }

  private async local(root: string, force: boolean): Promise<Local | null> {
    const repo = await this.repoOf(root, force)
    if (!repo) return null
    const head = (await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? ''
    return { repo, branch: head && head !== 'HEAD' ? head : null }
  }

  async target(root: string, what: GithubTarget): Promise<string | null> {
    const { now } = await this.info(root)
    if (!now) return null
    const url =
      what === 'repo'
        ? now.repoUrl
        : what === 'pulls'
          ? now.pullsUrl
          : what === 'compare' && now.branch
            ? compareUrlOf(now.repoUrl, now.branch)
            : what === 'pr' && now.pr
              ? `${now.repoUrl}/pull/${now.pr}`
              : now.repoUrl
    if (this.fixture) return url
    return (await this.signedIn()) ? url : loginUrlFor(url)
  }

  async checks(root: string, pr: number): Promise<PrChecks> {
    const repo = await this.repoFor(root)
    if (!repo || !this.opts.gh) return { state: 'failed' }
    return prChecks(this.opts.gh, repo, pr)
  }

  async openItems(root: string): Promise<GithubOpenItems> {
    const repo = await this.repoFor(root)
    if (!repo || !this.opts.gh) return { state: 'no-repo' }
    return listOpenItems(this.opts.gh, repo)
  }

  async failingChecksText(root: string, pr: number): Promise<string | null> {
    const repo = await this.repoFor(root)
    if (!repo || !this.opts.gh) return null
    return failingChecksText(this.opts.gh, repo, pr)
  }

  private async repoFor(root: string): Promise<GithubRepo | null> {
    if (!this.fixture) return this.repoOf(root, false)
    const f = this.fixture[root]
    return f ? { owner: f.owner, repo: f.repo } : null
  }

  private lookup(key: string, root: string, force = false): Promise<Entry> {
    const cur = this.inflight.get(key)
    if (cur && !force) return cur
    const mine = (this.newest.get(key) ?? 0) + 1
    this.newest.set(key, mine)
    const run = (async (): Promise<Entry> => {
      // PLATFORM§1
      const out = await this.git(
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

  private async git(root: string, args: string[], remote = false): Promise<string | null> {
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

function prOf(
  e: Entry | undefined,
  branch: string | null
): Pick<GithubInfo, 'pr' | 'pending' | 'failed'> {
  return { pr: (e && branch && e.prs.get(branch)) || null, pending: false, failed: !!e?.failed }
}

function fixtureCounts(fx: GithubFixture, root: string): WorkspaceGithub | null {
  const f = fx[root]
  if (!f || f.issues === undefined || f.prs === undefined) return null
  return { repo: `${f.owner}/${f.repo}`, issues: f.issues, prs: f.prs }
}

function fixtureInfo(fx: GithubFixture, root: string): GithubInfo | null {
  const f = fx[root]
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
