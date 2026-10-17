import { encodeCwd } from '@shared/cwdKey'
import { problemOf, type RunResult } from './ssh'
import {
  heartbeatCmd,
  parseHeartbeat,
  type MachineTmp,
  type MirrorStamps,
  type RemoteGitInfo
} from './install'
import { sessionIdOfTmux } from './launch'

// CC§2 CC§4 PLATFORM§34
function projectFlags(slugs: string[]): string[] {
  return [
    '--inplace',
    '-m',
    '--delete',
    ...slugs.flatMap((slug) => {
      const project = `/${slug}*`
      return [
        `--include=${project}/`,
        `--include=${project}/*.jsonl`,
        `--include=${project}/*.title`,
        `--include=${project}/*/`,
        `--include=${project}/*/**`
      ]
    }),
    '--exclude=*'
  ]
}
// PLATFORM§34
const HOOK_FLAGS = ['-I', '--inplace', '--delete']

const FAST_INTERVAL_MS = 2000
const IDLE_INTERVAL_MS = 20_000
const GIT_INTERVAL_MS = 20_000
const LONGEST_RETRY_WHILE_OUT_OF_TOUCH_MS = 60_000
const STAY_FAST_AFTER_WORK_OR_INPUT_MS = 30_000

export interface RemoteTarget {
  host: string
  mirrorProjectsRoot: string
  mirrorHookDir: string
  paths: string[]
  busy: boolean
}

export interface RemoteSyncDeps {
  run(host: string, cmd: string): Promise<RunResult>
  rsync(host: string, remoteDir: string, localDir: string, extra: string[]): Promise<RunResult>
  targets(): RemoteTarget[]
  onChange(host: string): void
  onLeft?(host: string, sessionIds: string[]): void
  onHooksPulled?(host: string): void
  onConnected?(host: string): void
}

interface HostState {
  alive: Set<string>
  git: Map<string, RemoteGitInfo>
  tmp?: MachineTmp
  gitAt: number
  connected: boolean
  failures: number
  problem?: string
  timer?: ReturnType<typeof setTimeout>
  dueAt: number
  fastUntil: number
  pulled: MirrorStamps
  running: boolean
  again: boolean
  waitingForNextPull: (() => void)[]
}

interface Watch {
  count: number
  stamp?: string
  onChange: (stamp: string) => void
}

function gitKey(git: Map<string, RemoteGitInfo>): string {
  return JSON.stringify([...git])
}

export class RemoteSync {
  private hosts = new Map<string, HostState>()
  private watches = new Map<string, Map<string, Watch>>()
  private stopped = true

  constructor(private deps: RemoteSyncDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    for (const st of this.hosts.values()) if (st.timer) clearTimeout(st.timer)
    this.hosts.clear()
  }

  alive(host: string): Set<string> {
    return this.hosts.get(host)?.alive ?? new Set()
  }

  gitInfo(host: string, path: string): RemoteGitInfo | undefined {
    return this.hosts.get(host)?.git.get(path)
  }

  machineTmp(host: string): MachineTmp | undefined {
    return this.hosts.get(host)?.tmp
  }

  connected(host: string): boolean {
    return this.hosts.get(host)?.connected ?? false
  }

  problem(host: string): string | undefined {
    return this.hosts.get(host)?.problem
  }

  watch(host: string, path: string, onChange: (stamp: string) => void): void {
    let paths = this.watches.get(host)
    if (!paths) this.watches.set(host, (paths = new Map()))
    const w = paths.get(path)
    if (w) w.count++
    else paths.set(path, { count: 1, onChange })
  }

  unwatch(host: string, path: string): void {
    const paths = this.watches.get(host)
    const w = paths?.get(path)
    if (paths && w && --w.count <= 0) paths.delete(path)
  }

  unwatchAll(): void {
    this.watches.clear()
  }

  private noticeStamps(host: string, asked: string[], stamps: string[]): void {
    const paths = this.watches.get(host)
    asked.forEach((path, i) => {
      const w = paths?.get(path)
      const stamp = stamps[i]
      if (!w || stamp === undefined) return
      const before = w.stamp
      w.stamp = stamp
      if (before !== undefined && before !== stamp) w.onChange(stamp)
    })
  }

  nextPullDone(host: string): Promise<void> {
    return new Promise((done) => this.state(host).waitingForNextPull.push(done))
  }

  pokeNow(host: string): void {
    if (this.stopped) return
    const st = this.state(host)
    st.gitAt = 0
    st.failures = 0
    st.pulled = {}
    st.fastUntil = Date.now() + STAY_FAST_AFTER_WORK_OR_INPUT_MS
    if (st.running) {
      st.again = true
      return
    }
    this.next(host, st, 0)
  }

  typedInto(host: string): void {
    const st = this.hosts.get(host)
    if (this.stopped || !st) return
    st.fastUntil = Date.now() + STAY_FAST_AFTER_WORK_OR_INPUT_MS
    if (st.running || st.failures || st.dueAt - Date.now() <= FAST_INTERVAL_MS) return
    this.next(host, st, 0)
  }

  private next(host: string, st: HostState, delay: number): void {
    if (st.timer) clearTimeout(st.timer)
    st.dueAt = Date.now() + delay
    st.timer = setTimeout(() => void this.round(host), delay)
    st.timer.unref?.()
  }

  private state(host: string): HostState {
    let st = this.hosts.get(host)
    if (!st)
      this.hosts.set(
        host,
        (st = {
          alive: new Set(),
          git: new Map(),
          gitAt: 0,
          connected: false,
          failures: 0,
          dueAt: 0,
          fastUntil: 0,
          pulled: {},
          running: false,
          again: false,
          waitingForNextPull: []
        })
      )
    return st
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    const timer = setTimeout(() => {
      if (this.stopped) return
      const hosts = new Set(this.deps.targets().map((t) => t.host))
      for (const [host, st] of this.hosts) {
        if (hosts.has(host)) continue
        if (st.timer) clearTimeout(st.timer)
        this.hosts.delete(host)
      }
      for (const host of hosts) {
        const st = this.state(host)
        if (!st.running && !st.timer) void this.round(host)
      }
      this.schedule(hosts.size ? FAST_INTERVAL_MS : IDLE_INTERVAL_MS)
    }, delay)
    timer.unref?.()
  }

  private async round(host: string): Promise<void> {
    const st = this.state(host)
    st.timer = undefined
    if (this.stopped || st.running) return
    const target = this.deps.targets().find((t) => t.host === host)
    if (!target) return
    st.running = true
    const waiting = st.waitingForNextPull.splice(0)
    try {
      const before = {
        connected: st.connected,
        problem: st.problem,
        alive: [...st.alive].sort().join(','),
        git: gitKey(st.git)
      }
      const askGit = Date.now() - st.gitAt >= GIT_INTERVAL_MS
      const watched = [...(this.watches.get(host)?.keys() ?? [])]
      const slugsNow = (): string[] => target.paths.map((p) => encodeCwd(st.git.get(p)?.real ?? p))
      const hb = await this.deps
        .run(host, heartbeatCmd(askGit ? target.paths : [], watched, slugsNow()))
        .catch((e: unknown) => ({ code: null, stdout: '', stderr: String(e) }))
      let mirrors: MirrorStamps = {}
      if (hb.code === 0) {
        st.connected = true
        st.failures = 0
        const parsed = parseHeartbeat(hb.stdout)
        mirrors = parsed.mirrors
        this.noticeStamps(host, watched, parsed.stamps)
        st.tmp = parsed.tmp
        const prevAlive = st.alive
        st.alive = new Set(
          parsed.alive.map((n) => sessionIdOfTmux(n)).filter((id): id is string => !!id)
        )
        const left = [...prevAlive].filter((id) => !st.alive.has(id))
        if (left.length) this.deps.onLeft?.(host, left)
        if (askGit) {
          st.git = parsed.git
          st.gitAt = Date.now()
        }
      } else {
        st.connected = false
        st.failures++
        st.problem = problemOf(hb)
      }
      if (st.connected) {
        const pull = async (
          which: keyof MirrorStamps,
          stamp: string | undefined,
          remoteDir: string,
          localDir: string,
          flags: string[]
        ): Promise<RunResult | undefined> => {
          if (stamp !== undefined && st.pulled[which] === stamp) return undefined
          const r = await this.deps.rsync(host, remoteDir, localDir, flags)
          st.pulled[which] = r.code === 0 ? stamp : undefined
          return r
        }
        const slugs = slugsNow()
        const transcripts = await pull(
          'transcripts',
          mirrors.transcripts && `${slugs.join(' ')} ${mirrors.transcripts}`,
          '.claude/projects',
          target.mirrorProjectsRoot,
          projectFlags(slugs)
        )
        const hooks = await pull(
          'hooks',
          mirrors.hooks,
          '.koloft/hook-sessions',
          target.mirrorHookDir,
          HOOK_FLAGS
        )
        const failed = [transcripts, hooks].find((r) => r && r.code !== 0)
        st.problem = failed && problemOf(failed)
        if (!hooks || hooks.code === 0) this.deps.onHooksPulled?.(host)
      }
      if (
        before.connected !== st.connected ||
        before.problem !== st.problem ||
        before.alive !== [...st.alive].sort().join(',') ||
        before.git !== gitKey(st.git)
      ) {
        this.deps.onChange(host)
      }
      if (!before.connected && st.connected) this.deps.onConnected?.(host)
    } finally {
      st.running = false
      for (const done of waiting) done()
      if (this.stopped) return
      const again = st.again
      st.again = false
      if (target.busy) st.fastUntil = Date.now() + STAY_FAST_AFTER_WORK_OR_INPUT_MS
      const steady = Date.now() < st.fastUntil ? FAST_INTERVAL_MS : IDLE_INTERVAL_MS
      const backoff = st.failures
        ? Math.min(FAST_INTERVAL_MS * 2 ** (st.failures - 1), LONGEST_RETRY_WHILE_OUT_OF_TOUCH_MS)
        : 0
      this.next(host, st, again ? 0 : Math.max(steady, backoff))
    }
  }
}

// PLATFORM§35
export function launchMode(opts: {
  alive: ReadonlySet<string>
  killed: ReadonlySet<string>
  sessionId: string
}): 'start' | 'attach' {
  return opts.alive.has(opts.sessionId) && !opts.killed.has(opts.sessionId) ? 'attach' : 'start'
}
