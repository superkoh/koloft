import { encodeCwd } from '@shared/cwdKey'
import type { RunResult } from './ssh'
import { heartbeatCmd, parseHeartbeat, type RemoteGitInfo } from './install'
import { sessionIdOfTmux } from './launch'

// CC§2 CC§4 PLATFORM§34
function projectFlags(paths: string[]): string[] {
  return [
    '--inplace',
    '-m',
    '--delete',
    ...paths.map((p) => `--include=${encodeCwd(p)}*/`),
    '--include=*.jsonl',
    '--exclude=*'
  ]
}
// PLATFORM§34
const HOOK_FLAGS = ['-I', '--inplace', '--delete']

const FAST_INTERVAL_MS = 2000
const IDLE_INTERVAL_MS = 20_000
const GIT_INTERVAL_MS = 20_000

export interface RemoteTarget {
  host: string
  mirrorProjectsRoot: string
  mirrorHookDir: string
  paths: string[]
  hasTabs: boolean
}

export interface RemoteSyncDeps {
  run(host: string, cmd: string): Promise<RunResult>
  rsync(host: string, remoteDir: string, localDir: string, extra: string[]): Promise<RunResult>
  targets(): RemoteTarget[]
  onChange(host: string): void
}

interface HostState {
  alive: Set<string>
  git: Map<string, RemoteGitInfo>
  gitAt: number
  connected: boolean
  timer?: ReturnType<typeof setTimeout>
  running: boolean
  again: boolean
}

function gitKey(git: Map<string, RemoteGitInfo>): string {
  return JSON.stringify([...git])
}

export class RemoteSync {
  private hosts = new Map<string, HostState>()
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

  connected(host: string): boolean {
    return this.hosts.get(host)?.connected ?? false
  }

  pokeNow(host: string): void {
    if (this.stopped) return
    const st = this.state(host)
    st.gitAt = 0
    if (st.running) {
      st.again = true
      return
    }
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(() => void this.round(host), 0)
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
          running: false,
          again: false
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
    try {
      const before = {
        connected: st.connected,
        alive: [...st.alive].sort().join(','),
        git: gitKey(st.git)
      }
      const askGit = Date.now() - st.gitAt >= GIT_INTERVAL_MS
      const hb = await this.deps
        .run(host, heartbeatCmd(askGit ? target.paths : []))
        .catch(() => null)
      if (hb && hb.code === 0) {
        st.connected = true
        const parsed = parseHeartbeat(hb.stdout)
        st.alive = new Set(
          parsed.alive.map((n) => sessionIdOfTmux(n)).filter((id): id is string => !!id)
        )
        if (askGit) {
          st.git = parsed.git
          st.gitAt = Date.now()
        }
      } else {
        st.connected = false
      }
      if (st.connected) {
        await Promise.all([
          this.deps.rsync(
            host,
            '.claude/projects',
            target.mirrorProjectsRoot,
            projectFlags(target.paths.map((p) => st.git.get(p)?.real ?? p))
          ),
          this.deps.rsync(host, '.koloft/hook-sessions', target.mirrorHookDir, HOOK_FLAGS)
        ])
      }
      if (
        before.connected !== st.connected ||
        before.alive !== [...st.alive].sort().join(',') ||
        before.git !== gitKey(st.git)
      ) {
        this.deps.onChange(host)
      }
    } finally {
      st.running = false
      if (this.stopped) return
      const again = st.again
      st.again = false
      const delay = again ? 0 : target.hasTabs ? FAST_INTERVAL_MS : IDLE_INTERVAL_MS
      if (st.timer) clearTimeout(st.timer)
      st.timer = setTimeout(() => void this.round(host), delay)
      st.timer.unref?.()
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
