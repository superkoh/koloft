import { execFile as execFileCb, spawn } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import type { WorkspaceFreshness, WorkspacePullResult } from '@shared/types'
import { defaultBranch } from './gitStatus'
import { isRemoteKey } from '@shared/remoteKey'

const execFile = promisify(execFileCb)

// The freshness engine (workspace-git-pull design) §05): how far each pinned
// workspace's root checkout is behind origin's default branch, and the one write it is
// allowed to perform — a fast-forward pull into a clean default branch.
//
// It runs BESIDE the rescan path, never inside it: a rescan is the sidebar's lifeline
// and this reaches the network. Results land in a Map the WorkspaceManager stamps onto
// its rows cache, so push and invoke serve the same data.

/** Tier-1 (local) commands; the fetch/pull budgets are separate — a network op that
 *  hangs must not hold the 5s local budget hostage. */
export const LOCAL_TIMEOUT_MS = 5_000
export const FETCH_TIMEOUT_MS = 15_000
const PULL_TIMEOUT_MS = 60_000
/** per-workspace automatic-fetch throttle, keyed on the last ATTEMPT (D1) */
const THROTTLE_MS = 60_000
const SWEEP_INTERVAL_MS = 5 * 60_000
const STARTUP_DELAY_MS = 3_000
/** startup stagger so N workspaces don't fire N gits in the same tick */
const STAGGER_MS = 750
const ERROR_LIMIT = 3
const BACKOFF_MS = 30 * 60_000
/** how many workspaces a sweep may fetch at once. Serial made a slow round take
 *  15s × N; the cap keeps one unreachable remote from stalling everything behind it
 *  without turning startup into a thundering herd. */
const SWEEP_CONCURRENCY = 3
/** floor between two LOCAL measurements of one workspace: the Tier-1 piggyback rides a
 *  rescan, and a rescan re-fires every 250ms while a session writes its jsonl — without
 *  this the sidebar's own liveliness would spawn a handful of gits per second */
const LOCAL_MIN_INTERVAL_MS = 10_000

/** Parse `rev-list --left-right --count HEAD...<defRef>`: LEFT is ours (ahead), RIGHT
 *  is theirs (behind). null when the output isn't the expected pair of counts. */
export function parseLeftRight(out: string): { ahead: number; behind: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(out)
  if (!m) return null
  return { ahead: parseInt(m[1], 10), behind: parseInt(m[2], 10) }
}

/** The line to show when a pull fails. Never the FIRST line — that is always the
 *  useless `From <url>` progress line; git puts the real cause last (`fatal: Not
 *  possible to fast-forward, aborting.`), sometimes trailed by `hint:` lines. */
export function pullErrorReason(stderr: string, stdout = ''): string {
  const lines = (stderr.trim() ? stderr : stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(fatal|error):/.test(lines[i])) return lines[i]
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('hint:')) return lines[i]
  }
  return 'pull failed'
}

/** Env for the two commands that talk to a remote: every interactive path closed, so a
 *  private repo fails fast instead of blocking on a prompt no one can see. The credential
 *  HELPER stays enabled on purpose (osxkeychain keeps working; decided) — the timeout is the
 *  backstop. GIT_TERMINAL_PROMPT alone is not enough: askpass punches through it. */
export function credentialGuardEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ssh = base.GIT_SSH_COMMAND
  return {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS_REQUIRE: 'never',
    // ssh honors the FIRST -o for a given key, so appending loses to a user's explicit
    // BatchMode and wins over the built-in default — which is exactly the policy.
    GIT_SSH_COMMAND: !ssh
      ? 'ssh -o BatchMode=yes'
      : /(^|\s)-o\s*BatchMode=/i.test(ssh)
        ? ssh
        : `${ssh} -o BatchMode=yes`
  }
}

/** A read-only git call: no index.lock (an agent's own `git add` in the same checkout
 *  would collide with rc=128), hard 5s budget. Rejects like execFile. */
async function readGit(bin: string, root: string, args: string[]): Promise<string> {
  const { stdout } = await execFile(bin, ['-C', root, ...args], {
    timeout: LOCAL_TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  })
  return stdout
}

/** git itself is missing (a packaged app launched from Finder has no developer PATH) —
 *  the one failure that never resolves on its own, so the engine latches on it. */
function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

interface NetResult {
  ok: boolean
  stdout: string
  stderr: string
  timedOut: boolean
  /** the git binary itself could not be spawned */
  enoent: boolean
}

/** fetch / pull. Spawned DETACHED so the timeout can kill the whole process group:
 *  execFile's own timeout signals the direct child only, and git's ssh/https helper is
 *  a grandchild that survives it (a leaked ssh holding the terminal forever).
 *  `live` collects the group leaders so a quit can kill them too (§06). */
function networkGit(
  bin: string,
  root: string,
  args: string[],
  timeoutMs: number,
  live: Set<number>
): Promise<NetResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, ['-C', root, ...args], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: credentialGuardEnv(process.env)
      })
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: '', timedOut: false, enoent: isEnoent(e) })
      return
    }
    const pid = child.pid
    if (pid) live.add(pid)
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout?.on('data', (d) => (stdout += String(d)))
    child.stderr?.on('data', (d) => (stderr += String(d)))
    const finish = (r: NetResult): void => {
      if (settled) return
      settled = true
      if (pid) live.delete(pid)
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      killGroup(pid)
      finish({ ok: false, stdout, stderr, timedOut: true, enoent: false })
    }, timeoutMs)
    child.on('error', (e) =>
      finish({ ok: false, stdout, stderr, timedOut: false, enoent: isEnoent(e) })
    )
    child.on('close', (code) =>
      finish({ ok: code === 0, stdout, stderr, timedOut: false, enoent: false })
    )
  })
}

function killGroup(pid: number | undefined): void {
  try {
    if (pid) process.kill(-pid, 'SIGKILL')
  } catch {
    /* the group is already gone */
  }
}

interface LocalBase {
  branch: string
  head: string
  /** the VERIFIED remote-tracking ref (`origin/main`), or null when the repo has no
   *  remote default branch — defaultBranch's bare-local return shape (§05 REF) */
  defRef: string | null
}

async function localBase(
  bin: string,
  root: string,
  resolveDef: () => Promise<string | null>
): Promise<LocalBase> {
  const branch = (await readGit(bin, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const head = (await readGit(bin, root, ['rev-parse', 'HEAD'])).trim()
  const def = await resolveDef()
  return { branch, head, defRef: def && def.startsWith('origin/') ? def : null }
}

/** A LINKED worktree keeps a `.git` FILE pointing into the main checkout's
 *  `.git/worktrees/<name>`; a main checkout has a directory. One stat, no process —
 *  and Koloft never pulls a linked worktree (D5). */
function isLinkedWorktree(root: string): boolean {
  try {
    return fs.statSync(path.join(root, '.git')).isFile()
  } catch {
    return false
  }
}

/** Cold start has no fetchedAt of its own: git's own last-fetch marker stands in, so the
 *  first popover/C7 line can still state a real age instead of claiming freshness. */
function fetchHeadAt(root: string): number | null {
  try {
    return fs.statSync(path.join(root, '.git', 'FETCH_HEAD')).mtimeMs
  } catch {
    return null
  }
}

/** Everything the UI reads — lastAttemptAt is throttle bookkeeping and invisible, so it
 *  alone never justifies a push. */
function sameFreshness(a: WorkspaceFreshness, b: WorkspaceFreshness): boolean {
  return (
    a.state === b.state &&
    a.behind === b.behind &&
    a.ahead === b.ahead &&
    a.branch === b.branch &&
    a.head === b.head &&
    a.defRef === b.defRef &&
    a.onDefault === b.onDefault &&
    a.dirty === b.dirty &&
    a.linked === b.linked &&
    a.hasSubmodules === b.hasSubmodules &&
    a.fetchedAt === b.fetchedAt
  )
}

export interface FreshnessDeps {
  /** the pinned workspaces to sweep; a missing dir is skipped entirely, and a remote
   *  key is filtered out here — it names no repo on this Mac */
  workspaces(): { path: string; missing: boolean }[]
  /** D8 master switch, read live — off disables every AUTOMATIC trigger */
  autoFetch(): boolean
  /** one workspace's freshness changed: restamp the rows cache and push it (§05) */
  onChange(wsPath: string): void
  now?(): number
}

/** Test seams only: the real app always spawns `git` off PATH with the budgets above. */
export interface FreshnessOptions {
  gitBin?: string
  fetchTimeoutMs?: number
}

export class GitFreshnessEngine {
  private cache = new Map<string, WorkspaceFreshness>()
  /** per-workspace network op in flight (fetch or pull) — a second request JOINS it
   *  rather than spawning another git */
  private inflight = new Map<string, Promise<WorkspaceFreshness | null>>()
  /** when each workspace was last measured at all — the Tier-1 piggyback's floor.
   *  Recorded even when the measurement produced nothing, or an unmeasurable path
   *  (missing dir, non-repo, no remote) would spawn a git on every 250ms rescan. */
  private measuredAt = new Map<string, number>()
  /** when each workspace was last FETCH-attempted. The sweep throttle cannot read this
   *  off the cache: a path that measures nothing (missing dir, non-repo, no remote)
   *  never lands there, and would be re-probed by every trigger forever. */
  private attemptedAt = new Map<string, number>()
  private errors = new Map<string, number>()
  private backoffUntil = new Map<string, number>()
  /** the verified defRef per workspace. Re-deriving it means the whole probe chain
   *  (symbolic-ref, then up to four rev-parses) on every single measurement; once it is
   *  known, one rev-parse re-verifies it and only a failure re-derives. */
  private defRefMemo = new Map<string, string>()
  /** workspaces whose last fetch ATTEMPT failed with no success since. Fetch health is
   *  the engine's, not one measurement's: a local re-measure knows nothing about the
   *  network and must never stamp 'ok' over a live failure. */
  private fetchFailed = new Set<string>()
  /** bumped on every applied measurement — a local measure that started before a fetch
   *  landed is stale by the time it returns, and must not overwrite it */
  private version = new Map<string, number>()
  /** group leaders of the network gits in flight, for the before-quit kill (§06) */
  private live = new Set<number>()
  /** git is not on PATH at all: nothing will fix that while the app runs, so stop
   *  spawning doomed processes for the rest of the process lifetime */
  private gitUnavailable = false
  /** before-quit latch: killing the live group is not enough on its own, because a sweep
   *  already inside its loop would just spawn the next detached git behind it */
  private stopped = false
  /** the liveness-sweep idiom: one GLOBAL guard, so a slow round never overlaps itself */
  private sweeping = false
  private startTimer?: NodeJS.Timeout
  private interval?: NodeJS.Timeout
  private gitBin: string
  private fetchTimeoutMs: number

  constructor(
    private deps: FreshnessDeps,
    opts: FreshnessOptions = {}
  ) {
    this.gitBin = opts.gitBin ?? 'git'
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  start(): void {
    this.startTimer = setTimeout(() => void this.sweep({ stagger: true }), STARTUP_DELAY_MS)
    this.startTimer.unref()
    this.interval = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
    this.interval.unref()
  }

  /** before-quit: a 60s pull (and the merge hook it may be running) would otherwise
   *  outlive the app that started it (§06) */
  stop(): void {
    this.stopped = true
    if (this.startTimer) clearTimeout(this.startTimer)
    if (this.interval) clearInterval(this.interval)
    this.startTimer = undefined
    this.interval = undefined
    for (const pid of this.live) killGroup(pid)
    this.live.clear()
  }

  get(wsPath: string): WorkspaceFreshness | undefined {
    return this.cache.get(wsPath)
  }

  /** Manual entry (popover ⟳ / menu Fetch origin / C7 opening): ignores the throttle and
   *  clears the error backoff — the user asked for it. */
  fetchNow(wsPath: string): Promise<WorkspaceFreshness | null> {
    if (this.gitUnavailable || this.stopped) return Promise.resolve(null)
    this.backoffUntil.delete(wsPath)
    this.errors.delete(wsPath)
    return this.runFetch(wsPath)
  }

  /** The workspaces this engine may measure: a remote key has no repo on this Mac,
   *  and every git here would run against a path that does not exist. */
  private pinned(): { path: string; missing: boolean }[] {
    return this.deps.workspaces().filter((w) => !isRemoteKey(w.path))
  }

  /** Tier-1 piggyback at the end of a rescan: local-only, no network, never awaited on
   *  the push path. Skips a workspace whose fetch is already in flight — that one is
   *  about to produce fresher numbers anyway. */
  async refreshLocal(paths: string[]): Promise<void> {
    if (this.gitUnavailable) return
    const missing = new Set(
      this.pinned()
        .filter((w) => w.missing)
        .map((w) => w.path)
    )
    for (const p of paths) {
      if (isRemoteKey(p)) continue
      if (missing.has(p)) continue
      if (this.inflight.has(p)) continue
      const at = this.measuredAt.get(p)
      if (at !== undefined && this.now() - at < LOCAL_MIN_INTERVAL_MS) continue
      const version = this.version.get(p) ?? 0
      const next = await this.measure(p, false, null)
      // a fetch started AND finished while this measurement ran: its numbers are the
      // fresher ones, and re-stamping ours would regress fetchedAt/lastAttemptAt
      if ((this.version.get(p) ?? 0) !== version) continue
      this.apply(p, next)
    }
  }

  /** Automatic round (startup / focus / resume / heartbeat). */
  async sweep(opts: { stagger?: boolean } = {}): Promise<void> {
    if (this.gitUnavailable || this.stopped) return
    if (this.sweeping) return
    if (!this.deps.autoFetch()) return
    this.sweeping = true
    try {
      const due: string[] = []
      for (const ws of this.pinned()) {
        if (ws.missing) continue
        const now = this.now()
        const last = this.attemptedAt.get(ws.path)
        if (last !== undefined && now - last < THROTTLE_MS) continue
        const until = this.backoffUntil.get(ws.path)
        if (until !== undefined && now < until) continue
        due.push(ws.path)
      }
      let next = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = next++
          if (i >= due.length) return
          if (this.stopped) return
          // the stagger is per SLOT, so a startup round still fans in rather than
          // firing its whole first wave in one tick
          if (opts.stagger && i > 0) await delay(STAGGER_MS)
          if (this.stopped) return
          await this.runFetch(due[i])
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(SWEEP_CONCURRENCY, due.length) }, () => worker())
      )
    } finally {
      this.sweeping = false
    }
  }

  /**
   * Fast-forward the workspace's default branch. `expect` is what the renderer judged on;
   * main re-checks the LIVE repo right before exec, because between the two an external
   * `git checkout` can put a feature branch under the same pull and silently ff it to
   * origin/main (recoverable only from the reflog).
   */
  async pull(
    wsPath: string,
    expect: { branch: string; head: string }
  ): Promise<WorkspacePullResult> {
    if (this.gitUnavailable) return { ok: false, reason: 'git is not available' }
    if (this.stopped) return { ok: false, reason: 'Koloft is quitting' }
    const prior = this.inflight.get(wsPath)
    if (prior) await prior.catch(() => null)
    let release: (v: WorkspaceFreshness | null) => void = () => {}
    const gate = new Promise<WorkspaceFreshness | null>((res) => (release = res))
    this.inflight.set(wsPath, gate)
    try {
      const cur = await this.measure(wsPath, false, null)
      if (!cur || cur.state !== 'ok') return { ok: false, reason: 'state changed' }
      const defBranch = stripOrigin(cur.defRef)
      if (
        cur.linked ||
        cur.branch !== defBranch ||
        cur.branch !== expect.branch ||
        cur.head !== expect.head ||
        cur.dirty ||
        cur.ahead !== 0
      ) {
        return { ok: false, reason: 'state changed' }
      }
      const from = cur.head
      const r = await networkGit(
        this.gitBin,
        wsPath,
        [
          '-c',
          'advice.diverging=false',
          'pull',
          '--ff-only',
          '--no-recurse-submodules',
          'origin',
          defBranch
        ],
        PULL_TIMEOUT_MS,
        this.live
      )
      if (r.enoent) this.gitUnavailable = true
      // a pull that reached origin is proof the network is back
      if (r.ok) this.fetchFailed.delete(wsPath)
      // .git is invisible to the fs watcher, so nothing else will ever refresh this
      const next = await this.measure(wsPath, false, null)
      if (next) this.apply(wsPath, r.ok ? { ...next, state: 'ok', fetchedAt: this.now() } : next)
      if (!r.ok) {
        return {
          ok: false,
          reason: r.timedOut ? 'pull timed out' : pullErrorReason(r.stderr, r.stdout)
        }
      }
      // the pull moved HEAD even when the re-measure failed — read it directly
      // rather than falling back to `from` (which would toast "0 commits")
      const to =
        next?.head ??
        (await readGit(this.gitBin, wsPath, ['rev-parse', 'HEAD']).then(
          (s) => s.trim(),
          () => from
        ))
      return {
        ok: true,
        summary: {
          count: await commitsBetween(this.gitBin, wsPath, from, to),
          from: short(from),
          to: short(to)
        }
      }
    } finally {
      if (this.inflight.get(wsPath) === gate) this.inflight.delete(wsPath)
      release(this.cache.get(wsPath) ?? null)
    }
  }

  private runFetch(wsPath: string): Promise<WorkspaceFreshness | null> {
    if (this.stopped) return Promise.resolve(null)
    const inflight = this.inflight.get(wsPath)
    if (inflight) return inflight
    const attemptAt = this.now()
    this.attemptedAt.set(wsPath, attemptAt)
    const p = (async () => {
      const next = await this.measure(wsPath, true, attemptAt)
      // a null measurement is a failed attempt like any other: without a strike an
      // unmeasurable pin would never reach the backoff, only the 60s throttle
      if (!next || next.state === 'error') {
        const streak = (this.errors.get(wsPath) ?? 0) + 1
        this.errors.set(wsPath, streak)
        if (streak >= ERROR_LIMIT) this.backoffUntil.set(wsPath, this.now() + BACKOFF_MS)
      } else {
        this.errors.delete(wsPath)
        this.backoffUntil.delete(wsPath)
      }
      return this.apply(wsPath, next)
    })().finally(() => {
      if (this.inflight.get(wsPath) === p) this.inflight.delete(wsPath)
    })
    this.inflight.set(wsPath, p)
    return p
  }

  /** One measurement. `null` = nothing measurable (git missing, not a repo) — the caller
   *  leaves the cache untouched, and an absent freshness draws nothing at all (D10). */
  private async measure(
    root: string,
    doFetch: boolean,
    attemptAt: number | null
  ): Promise<WorkspaceFreshness | null> {
    const prev = this.cache.get(root)
    const lastAttemptAt = attemptAt ?? prev?.lastAttemptAt ?? null
    let base: LocalBase
    try {
      base = await localBase(this.gitBin, root, () => this.resolveDefRef(root))
    } catch (e) {
      if (isEnoent(e)) this.gitUnavailable = true
      return null
    }
    const linked = isLinkedWorktree(root)
    const hasSubmodules = fs.existsSync(path.join(root, '.gitmodules'))
    // detached HEAD, or no remote default branch: measurable repo, nothing to measure
    if (base.branch === 'HEAD' || !base.defRef) {
      return {
        state: 'none',
        behind: 0,
        ahead: 0,
        branch: base.branch,
        head: base.head,
        defRef: base.defRef ?? '',
        onDefault: false,
        dirty: false,
        linked,
        hasSubmodules,
        fetchedAt: prev?.fetchedAt ?? null,
        lastAttemptAt
      }
    }
    const defRef = base.defRef
    const defBranch = stripOrigin(defRef)
    let fetchedAt = prev?.fetchedAt ?? fetchHeadAt(root)
    if (doFetch) {
      const r = await networkGit(
        this.gitBin,
        root,
        ['fetch', '--quiet', '--no-auto-maintenance', 'origin', defBranch],
        this.fetchTimeoutMs,
        this.live
      )
      if (r.enoent) {
        this.gitUnavailable = true
        return null
      }
      if (r.ok) {
        fetchedAt = this.now()
        this.fetchFailed.delete(root)
      } else {
        this.fetchFailed.add(root) // keep the previous counts, flag them as unverified
      }
    }
    try {
      const counts = parseLeftRight(
        await readGit(this.gitBin, root, [
          'rev-list',
          '--left-right',
          '--count',
          `HEAD...${defRef}`
        ])
      )
      if (!counts) return null
      const dirty =
        (
          await readGit(this.gitBin, root, [
            'status',
            '--porcelain',
            '-uno',
            '--ignore-submodules=all'
          ])
        ).trim() !== ''
      return {
        // fetch health is the ENGINE's, not this call's: a local re-measure must not
        // stamp 'ok' over a failure the backoff is still suppressing retries for
        state: this.fetchFailed.has(root) ? 'error' : 'ok',
        behind: counts.behind,
        ahead: counts.ahead,
        branch: base.branch,
        head: base.head,
        defRef,
        onDefault: base.branch === defBranch,
        dirty,
        linked,
        hasSubmodules,
        fetchedAt,
        lastAttemptAt
      }
    } catch (e) {
      if (isEnoent(e)) this.gitUnavailable = true
      return null
    }
  }

  /** The workspace's remote-tracking default ref. Only a REMOTE one is remembered: a bare
   *  local fallback means the repo has no remote default yet, and memoizing that would hide
   *  the origin the user adds later. */
  private async resolveDefRef(root: string): Promise<string | null> {
    const memo = this.defRefMemo.get(root)
    if (memo !== undefined) {
      try {
        await readGit(this.gitBin, root, ['rev-parse', '--verify', '--quiet', memo])
        return memo
      } catch {
        this.defRefMemo.delete(root) // renamed/deleted upstream — derive it again
      }
    }
    const def = await defaultBranch(root, { timeoutMs: LOCAL_TIMEOUT_MS })
    if (def?.startsWith('origin/')) this.defRefMemo.set(root, def)
    return def
  }

  private apply(wsPath: string, next: WorkspaceFreshness | null): WorkspaceFreshness | null {
    // even a null result marks the workspace measured: an unmeasurable path must honor
    // the same floor, or every rescan spawns a git for it
    this.measuredAt.set(wsPath, this.now())
    if (!next) return null
    const prev = this.cache.get(wsPath)
    this.cache.set(wsPath, next)
    this.version.set(wsPath, (this.version.get(wsPath) ?? 0) + 1)
    if (!prev || !sameFreshness(prev, next)) this.deps.onChange(wsPath)
    return next
  }
}

function stripOrigin(defRef: string): string {
  return defRef.slice('origin/'.length)
}

function short(sha: string): string {
  return sha.slice(0, 7)
}

/** The toast's number. The cached `behind` can be too small — the pull fetched again — so
 *  it is counted from the two real endpoints. */
async function commitsBetween(
  bin: string,
  root: string,
  from: string,
  to: string
): Promise<number> {
  try {
    const n = parseInt(
      (await readGit(bin, root, ['rev-list', '--count', `${from}..${to}`])).trim(),
      10
    )
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms)
    t.unref()
  })
}
