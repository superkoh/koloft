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
// the budgets are gitFreshness's own, imported rather than re-typed: a local read gets its
// Tier-1 budget, and the one command that reaches a remote gets its fetch budget
import { credentialGuardEnv, FETCH_TIMEOUT_MS, LOCAL_TIMEOUT_MS } from './gitFreshness'

const execFile = promisify(execFileCb)
/** D3 — how long one repository's pull-request table stands. A failure is remembered for
 *  the same span, so an unreachable remote is asked once every five minutes, not once per
 *  click. */
const TTL_MS = 5 * 60_000
/** Node's default is 1 MB and `ls-remote` on a big repository prints far more than that
 *  (this repo: 204 pull requests). Over the limit the child throws and the answer silently
 *  becomes "no pull request" — the same trap `fileTree`'s `ls-files` spawns hit. */
const MAX_BUFFER = 16 * 1024 * 1024

/** One repository's answer. `prs` is the whole branch → number table, because the command
 *  that produces one branch's number produces every branch's for free. */
interface Entry {
  at: number
  prs: Map<string, number>
  failed: boolean
}

/** One directory's local facts. The repository comes from a remote url; the branch from
 *  HEAD. Null branch = detached. */
interface Local {
  repo: GithubRepo
  branch: string | null
}

/** What one ask produces: what the button can draw NOW, and — only when the number is
 *  still coming — the promise that carries it. `settled` continues the same call's local
 *  reads, so the caller never has to ask twice. */
export interface GithubAnswer {
  now: GithubInfo | null
  settled: Promise<GithubInfo> | null
}

/** E2E seam (`KOLOFT_GITHUB_FIXTURE`): a fixed answer per session directory, so a test can
 *  have a GitHub repository without a network or a real remote. A directory that is not
 *  listed answers null, i.e. draws no button. While it is set no git runs and the sign-in
 *  check is skipped — a test browser has no GitHub cookie, and every click would otherwise
 *  land on the login page. */
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
  /** the built-in browser has a GitHub session (D1). Defaults to "yes", which only ever
   *  means no login detour — never a wrong page. */
  signedIn?: () => Promise<boolean>
  fixture?: GithubFixture | null
  gitBin?: string
  now?: () => number
}

/**
 *) — the
 * button's data half: which GitHub repository a session directory belongs to,
 * and which pull request its branch is.
 *
 * No polling and no `gh`. One `git ls-remote` per repository per five minutes, matched by
 * commit; a Finder-launched app's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) has git and does
 * not have Homebrew's `gh`, and the only extra `gh` offers — a pull request's state and
 * title — is not on the button.
 *
 * The cache is keyed by `owner/repo`, not by directory, so five sessions on five worktrees
 * of one repository cost one command between them. The branch, being local and instant,
 * is re-read on every call instead — switching branches changes the number right away.
 */
export class GithubLookup {
  private cache = new Map<string, Entry>()
  /** root → which repository it belongs to (null = none / not github.com), and when that
   *  was established. See `local()` for why the negative answer is kept too. */
  private repos = new Map<string, { at: number; repo: GithubRepo | null }>()
  /** one lookup per repository at a time; a second asker joins it (§5) — except a forced
   *  one, which starts its own and so can run alongside it */
  private inflight = new Map<string, Promise<Entry>>()
  /** per repository, a counter of the most recently STARTED lookup() — see `lookup` */
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

  /**
   * What the button should show for this directory.
   *
   * Answers as soon as the LOCAL facts are in — milliseconds — and hands back `settled`
   * when the pull-request command still has to run. The number that is already on the
   * button survives that wait: a cache entry past its five minutes is still what the user
   * is looking at, so it keeps being reported while the fresh one is fetched.
   */
  async info(root: string, opts: { force?: boolean } = {}): Promise<GithubAnswer> {
    if (this.fixture) return { now: fixtureInfo(this.fixture, root), settled: null }
    const local = await this.local(root, opts.force === true)
    if (!local) return { now: null, settled: null }
    const { repo, branch } = local
    const base = { repoUrl: repoUrlOf(repo), pullsUrl: pullsUrlOf(repo), branch }
    // a detached HEAD has nothing to match a pull request against, so it never spends the
    // one command that reaches the network (§10)
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

  /**
   * Which repository this directory belongs to, and which branch it is on.
   *
   * The repository is memoized per directory — a remote url essentially never changes, and
   * without this every panel show, every click and every menu item paid a git to relearn
   * it. The NEGATIVE answer is memoized too, which is the bigger win: a directory that is
   * not a GitHub repository would otherwise spawn a git every time its panel appeared, for
   * as long as the app ran. The branch is always re-read: it is the thing that actually
   * changes, and re-reading it is what makes a `git switch` show the new number at once.
   */
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
    // a detached HEAD prints the word HEAD: a real repository with no branch to match
    return { repo: known.repo, branch: head && head !== 'HEAD' ? head : null }
  }

  /** Where a click goes. Never waits on the network: the address has to be the one the
   *  number under the pointer promised, and blocking a click for the length of a
   *  `ls-remote` to re-confirm a number that cannot change is the wrong trade. Wrapped
   *  into GitHub's login page when the built-in browser has never signed in there (D1) —
   *  including for a public repository, since being signed in is simply the better page. */
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

  /** `force` is "Check again", and it has to mean a command that started AFTER the click —
   *  joining one already in flight would hand back an answer fetched before the thing the
   *  user is asking about happened, which on a slow remote can be fifteen seconds stale.
   *  Nothing piles up: the menu closes on the click, so a second ask is a second gesture. */
  private lookup(key: string, root: string, force = false): Promise<Entry> {
    const cur = this.inflight.get(key)
    if (cur && !force) return cur
    // Which run is allowed to WRITE. A forced run overtakes an ordinary one, so two can be
    // in flight at once — and if the older is also the slower it would otherwise land last
    // and pin its stale table, stamped with a fresh timestamp, for the next five minutes.
    // Finishing order says nothing; starting order does. (The waiter still gets its OWN
    // answer either way — `settled` resolves from `e`, not from the cache.)
    const mine = (this.newest.get(key) ?? 0) + 1
    this.newest.set(key, mine)
    const run = (async (): Promise<Entry> => {
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

  /** stdout, or null for any failure at all — a missing git, a directory that is not a
   *  repository, a remote that refuses the ssh key. None of them has anything to tell the
   *  user that the button not carrying a number does not already say (B9). */
  private async git(root: string, args: string[], remote = false): Promise<string | null> {
    try {
      const { stdout } = await execFile(this.gitBin, ['-C', root, ...args], {
        timeout: remote ? FETCH_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        // GIT_OPTIONAL_LOCKS: an agent's own `git add` in the same checkout must not
        // collide with a read the user never asked for
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
