import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import type { GithubInfo, GithubTarget } from '@shared/types'
import type { GithubRepo } from '@shared/githubUrl'
import {
  loginUrlFor,
  parseGithubRemote,
  pickRemoteUrl,
  prNumbersByBranch,
  pullsUrlOf,
  repoUrlOf
} from '@shared/githubUrl'
import { credentialGuardEnv, FETCH_TIMEOUT_MS, LOCAL_TIMEOUT_MS } from './gitFreshness'

const execFile = promisify(execFileCb)
const TTL_MS = 5 * 60_000
const MAX_BUFFER = 16 * 1024 * 1024

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
  [root: string]: { owner: string; repo: string; branch?: string | null; pr?: number | null } | null
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
  now?: () => number
}

// PLATFORM§1
export class GithubLookup {
  private cache = new Map<string, Entry>()
  private repos = new Map<string, { at: number; repo: GithubRepo | null }>()
  private inflight = new Map<string, Promise<Entry>>()
  private newest = new Map<string, number>()
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

  private async local(root: string, force: boolean): Promise<Local | null> {
    let known = this.repos.get(root)
    if (force || !known || this.now() - known.at >= TTL_MS) {
      const out = await this.git(root, ['config', '--get-regexp', '^remote\\..*\\.url'])
      const url = out === null ? null : pickRemoteUrl(out)
      known = { at: this.now(), repo: url ? parseGithubRemote(url) : null }
      this.repos.set(root, known)
    }
    if (!known.repo) return null
    const head = (await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? ''
    return { repo: known.repo, branch: head && head !== 'HEAD' ? head : null }
  }

  async target(root: string, what: GithubTarget): Promise<string | null> {
    const { now } = await this.info(root)
    if (!now) return null
    const url =
      what === 'repo'
        ? now.repoUrl
        : what === 'pulls'
          ? now.pullsUrl
          : now.pr
            ? `${now.repoUrl}/pull/${now.pr}`
            : now.repoUrl
    if (this.fixture) return url
    return (await this.signedIn()) ? url : loginUrlFor(url)
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
