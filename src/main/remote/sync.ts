import { encodeCwd } from '@shared/cwdKey'
import type { RunResult } from './ssh'
import { heartbeatCmd, parseHeartbeat, type RemoteGitInfo } from './install'
import { sessionIdOfTmux } from './launch'

// The per-machine heartbeat: nothing of Koloft's runs on the machine, so this is the
// only thing that ever says which sessions are alive and whether the machine can be
// reached at all. One round per machine, sequential: ask tmux for its session names,
// then pull the transcripts and the hook files into the mirrors. Everything it does
// runs under BatchMode, so it can never stop to ask for a password.

/** One rsync pulls the machine's whole `.claude/projects` and keeps only the pinned
 *  folders' slugs — by PREFIX, so a worktree session's own slug
 *  (`<slug>--claude-worktrees-<name>`) and claude's truncated variants come too.
 *  The patterns are deliberately unanchored: macOS ships openrsync. `--delete`
 *  because claude MOVES a transcript between slugs (a worktree session's /exit
 *  relocates it to the root slug, contract §4): without it the mirror keeps the old
 *  copy and the sidebar shows the session twice. The paths handed
 *  here must be the machine's own, symlinks resolved (contract §2). */
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
/** `-I` because openrsync's protocol has 1-second time resolution: a same-size
 *  rewrite inside one second is otherwise skipped. `--inplace` writes THROUGH the
 *  existing file, so an unchanged round leaves the inode and every timestamp alone
 *  and fs.watch stays quiet — without it every round re-creates `<tab>.json` and the
 *  watcher replays that tab's SessionStart, re-seeding 'waiting' mid-turn.
 *  `--delete` lets the mirror follow a deletion on the machine. This folder is tiny. */
const HOOK_FLAGS = ['-I', '--inplace', '--delete']

const FAST_INTERVAL_MS = 2000
const IDLE_INTERVAL_MS = 20_000
/** worktrees come and go far more slowly than sessions: the git question rides
 *  only every tenth fast round */
const GIT_INTERVAL_MS = 20_000

export interface RemoteTarget {
  host: string
  mirrorProjectsRoot: string
  mirrorHookDir: string
  /** the pinned folders' absolute paths ON the machine */
  paths: string[]
  /** this machine has at least one live tab — poll fast */
  hasTabs: boolean
}

export interface RemoteSyncDeps {
  run(host: string, cmd: string): Promise<RunResult>
  rsync(host: string, remoteDir: string, localDir: string, extra: string[]): Promise<RunResult>
  targets(): RemoteTarget[]
  /** the machine's alive set, its git facts, or its connected flag moved */
  onChange(host: string): void
}

interface HostState {
  alive: Set<string>
  git: Map<string, RemoteGitInfo>
  /** when git was last asked, so a pin or a new tab may ask again at once */
  gitAt: number
  connected: boolean
  timer?: ReturnType<typeof setTimeout>
  running: boolean
  /** a pokeNow arrived mid-round — run one more as soon as this one lands */
  again: boolean
}

/** the map follows the target's path order, so one string says whether it moved */
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

  /** session ids tmux listed for this machine; empty while nothing is known yet */
  alive(host: string): Set<string> {
    return this.hosts.get(host)?.alive ?? new Set()
  }

  /** what the machine's git said about one pinned folder; undefined while nothing is
   *  known yet — which is not the same as "not a repo" */
  gitInfo(host: string, path: string): RemoteGitInfo | undefined {
    return this.hosts.get(host)?.git.get(path)
  }

  connected(host: string): boolean {
    return this.hosts.get(host)?.connected ?? false
  }

  /** a tab was just created on this machine — run a round now so the row and the
   *  connection dot do not wait out the current interval */
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

  /** Targets are re-read every tick, so a machine pinned or unpinned mid-run is
   *  picked up without any bookkeeping of its own. */
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
    // read once and used again when the next round is scheduled: an unpinned machine
    // is dropped by schedule()'s own sweep, timer and all
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
        // out of touch is not dead: the tmux sessions keep running, so the previous
        // alive set stands and only the connection dot goes grey
        st.connected = false
      }
      if (st.connected) {
        // disjoint destination folders, so they run together
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

/**
 * How a launch should enter tmux over there.
 *
 * `attach` is only ever an optimisation for a session that is definitely still
 * running: `start` ends in `tmux new-session -A -D`, which attaches to an existing
 * session and ignores its command, so `start` is correct either way — while `attach`
 * for a session that is gone exits 1 and takes the tab with it.
 *
 * Hence `killed`, held apart from the observed set rather than deleted from it. The
 * alive set is up to one round old, so right after ⇧⌘R it still names the session
 * Koloft just destroyed. Editing it on the strength of the kill COMMAND is wrong: a
 * kill that never reached the machine (ssh down) leaves claude running over there,
 * and dropping it would show a live session as cold with no later round able to put
 * it back.
 */
export function launchMode(opts: {
  alive: ReadonlySet<string>
  killed: ReadonlySet<string>
  sessionId: string
}): 'start' | 'attach' {
  return opts.alive.has(opts.sessionId) && !opts.killed.has(opts.sessionId) ? 'attach' : 'start'
}
