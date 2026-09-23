import { execFile as execFileCb, spawn } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import type { WorkspaceFreshness, WorkspacePullResult } from '@shared/types'
import { defaultBranch } from './gitStatus'
import { isRemoteKey } from '@shared/remoteKey'

const execFile = promisify(execFileCb)

export const LOCAL_TIMEOUT_MS = 5_000
export const FETCH_TIMEOUT_MS = 15_000
const PULL_TIMEOUT_MS = 60_000
const THROTTLE_MS = 60_000
const SWEEP_INTERVAL_MS = 5 * 60_000
const STARTUP_DELAY_MS = 3_000
const STAGGER_MS = 750
const ERROR_LIMIT = 3
const BACKOFF_MS = 30 * 60_000
const SWEEP_CONCURRENCY = 3
const LOCAL_MIN_INTERVAL_MS = 10_000

export function parseLeftRight(out: string): { ahead: number; behind: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(out)
  if (!m) return null
  return { ahead: parseInt(m[1], 10), behind: parseInt(m[2], 10) }
}

// PLATFORM§30
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

// PLATFORM§30
export function credentialGuardEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ssh = base.GIT_SSH_COMMAND
  return {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS_REQUIRE: 'never',
    // PLATFORM§33
    GIT_SSH_COMMAND: !ssh
      ? 'ssh -o BatchMode=yes'
      : /(^|\s)-o\s*BatchMode=/i.test(ssh)
        ? ssh
        : `${ssh} -o BatchMode=yes`
  }
}

// PLATFORM§30
async function readGit(bin: string, root: string, args: string[]): Promise<string> {
  const { stdout } = await execFile(bin, ['-C', root, ...args], {
    timeout: LOCAL_TIMEOUT_MS,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  })
  return stdout
}

// PLATFORM§1
function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

interface NetResult {
  ok: boolean
  stdout: string
  stderr: string
  timedOut: boolean
  enoent: boolean
}

// PLATFORM§27
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
  } catch {}
}

interface LocalBase {
  branch: string
  head: string
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

function isLinkedWorktree(root: string): boolean {
  try {
    return fs.statSync(path.join(root, '.git')).isFile()
  } catch {
    return false
  }
}

function fetchHeadAt(root: string): number | null {
  try {
    return fs.statSync(path.join(root, '.git', 'FETCH_HEAD')).mtimeMs
  } catch {
    return null
  }
}

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
  workspaces(): { path: string; missing: boolean }[]
  autoFetch(): boolean
  onChange(wsPath: string): void
  now?(): number
}

export interface FreshnessOptions {
  gitBin?: string
  fetchTimeoutMs?: number
}

export class GitFreshnessEngine {
  private cache = new Map<string, WorkspaceFreshness>()
  private inflight = new Map<string, Promise<WorkspaceFreshness | null>>()
  private measuredAt = new Map<string, number>()
  private attemptedAt = new Map<string, number>()
  private errors = new Map<string, number>()
  private backoffUntil = new Map<string, number>()
  private defRefMemo = new Map<string, string>()
  private fetchFailed = new Set<string>()
  private version = new Map<string, number>()
  private live = new Set<number>()
  private gitUnavailable = false
  private stopped = false
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

  fetchNow(wsPath: string): Promise<WorkspaceFreshness | null> {
    if (this.gitUnavailable || this.stopped) return Promise.resolve(null)
    this.backoffUntil.delete(wsPath)
    this.errors.delete(wsPath)
    return this.runFetch(wsPath)
  }

  private pinned(): { path: string; missing: boolean }[] {
    return this.deps.workspaces().filter((w) => !isRemoteKey(w.path))
  }

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
      if ((this.version.get(p) ?? 0) !== version) continue
      this.apply(p, next)
    }
  }

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
      if (r.ok) this.fetchFailed.delete(wsPath)
      const next = await this.measure(wsPath, false, null)
      if (next) this.apply(wsPath, r.ok ? { ...next, state: 'ok', fetchedAt: this.now() } : next)
      if (!r.ok) {
        return {
          ok: false,
          reason: r.timedOut ? 'pull timed out' : pullErrorReason(r.stderr, r.stdout)
        }
      }
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
        this.fetchFailed.add(root)
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

  private async resolveDefRef(root: string): Promise<string | null> {
    const memo = this.defRefMemo.get(root)
    if (memo !== undefined) {
      try {
        await readGit(this.gitBin, root, ['rev-parse', '--verify', '--quiet', memo])
        return memo
      } catch {
        this.defRefMemo.delete(root)
      }
    }
    const def = await defaultBranch(root, { timeoutMs: LOCAL_TIMEOUT_MS })
    if (def?.startsWith('origin/')) this.defRefMemo.set(root, def)
    return def
  }

  private apply(wsPath: string, next: WorkspaceFreshness | null): WorkspaceFreshness | null {
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
