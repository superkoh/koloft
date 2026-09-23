import * as pty from 'node-pty'
import { EventEmitter } from 'events'
import os from 'os'
import type { TabKind } from '@shared/types'
import { OscCwdParser } from './oscCwd'
import { codexEnvironment } from './codexTransport'
import { userShell } from './userShell'

export interface PtyHandle {
  id: string
  proc: pty.IPty
  kind: TabKind
  /** where the shell was spawned — and, for a utility shell, where it has since `cd`ed
   *  to: the OSC 7 tracker keeps it current (D13) */
  cwd: string
  alive: boolean
  /** global-terminal utility shell (§06). Retained past spawn (M2): the
   *  adoption inventory must exclude these, and the reload teardown kills them —
   *  nothing respawns a shell (D4), so a survivor is a leak, not a tab. */
  util: boolean
  /** the session this pty was spawned to `--resume` (M2). Main's only
   *  pty→session link before the SessionStart hook binds — without it, a renderer
   *  reload mid-resume re-offers the row and a click double-launches the transcript. */
  resumeSessionId?: string
  /** the conversation tab whose Workbench this utility shell belongs to */
  ownerTabId?: string
}

interface CreateArgs {
  executable?: string
  argv?: string[]
  processEnv?: NodeJS.ProcessEnv
  kind: TabKind
  cwd: string
  cols?: number
  rows?: number
  /** PATH/shim setup, typed once the shell has loaded its rc files */
  setupCommand?: string
  /** the claude launch, typed a bit later so PATH is already fixed. A function form
   *  is for a line that has to name the tab: a remote session's two package folders
   *  are named after the tab id, which only exists once create() has minted it */
  launchCommand?: string | ((id: string) => string)
  /** overrides the user's login shell. A remote launch line is sh/zsh syntax and a
   *  fish or csh login shell would not run it. */
  shell?: string
  /** this shell is a tab of the global utility terminal (D8): mark it KOLOFT_UTIL=1 so the
   *  shim turns an interactive `claude` away, and leave out every session-bound
   *  variable — it belongs to no session (§06). */
  util?: boolean
  /** the session id a claude tab was created to resume — kept on the handle for the
   *  adoption inventory (the launch command itself is built by the caller) */
  resumeSessionId?: string
  /** the conversation tab whose Workbench this utility shell belongs to */
  ownerTabId?: string
  /** §4.8: a scheduled run's first message and its job name. They travel as env
   *  because nothing free-typed may reach the launch LINE (§0), and they are merged
   *  last, just before the spawn. The type is this narrow on purpose: two named keys
   *  can never overwrite PATH or another KOLOFT_* variable. */
  extraEnv?: { KOLOFT_FIRST_PROMPT?: string; KOLOFT_SESSION_NAME?: string }
}

/** how often a utility shell's foreground process is sampled for its tab label —
 *  node-pty exposes `.process` as a getter only, so there is nothing to subscribe to */
const UTIL_TITLE_POLL_MS = 1500

/**
 * The command name behind whatever node-pty's `.process` just reported, or null when
 * this tick cannot name one.
 *
 * `.process` is TYPED `string`, but it is a native read of the tty's foreground
 * process and it fails in two different ways: it throws on a dying tty, and — on
 * macOS — it simply answers `undefined` while the foreground is being handed from one
 * command to the next (node-pty's darwin branch returns the native value raw, with
 * none of the `|| this._file` fallback the other platforms get). A pipeline or a tight
 * loop cycles the foreground fast enough to land in that gap within seconds. So the
 * reported value is untrusted input, and the check has to happen BEFORE `.split`, not
 * after: `'a/b'.split('/').pop()` is never undefined, which is why a trailing `?? ''`
 * there defends nothing.
 *
 * A tick that cannot name the process is a gap, not a state — the caller keeps the
 * label it has rather than blanking the tab.
 */
export function foregroundName(reported: unknown): string | null {
  if (typeof reported !== 'string') return null
  const name = reported.slice(reported.lastIndexOf('/') + 1)
  return name === '' ? null : name
}

/**
 * Owns one node-pty process per terminal tab. Emits:
 *   - 'data' { id, data }
 *   - 'exit' { id, exitCode, signal }
 *   - 'process-title' { id, name }  (utility shells only)
 *   - 'cwd' { id, cwd }             (utility shells only)
 *
 * Each shell gets KOLOFT_TAB_ID / KOLOFT_SESSION_DIR and the shim dir prepended to
 * PATH, so any `claude` run inside it is auto-registered with the app.
 */
export class PtyManager extends EventEmitter {
  /** dir containing the `claude` shim; set by main after setupShim() */
  shimDir?: string
  /** dir where the shim drops session registration files */
  regDir?: string
  /** dir where the `open` shim drops preview-open requests */
  openDir?: string
  /** dir the claude shim exchanges multi-account pick req/res files through;
   *  set only when the pick watcher is live (mirrors openDir's gate) */
  pickDir?: string
  /** D2: dir holding one file per tab with that tab's browser-control endpoint.
   *  The shim reads it at LAUNCH, so the master switch and a changed port reach every
   *  already-open tab — a pty's own env is frozen at spawn and could not. */
  cdpDir?: string
  /** current multi-account mode, read at spawn time. Drives ONLY the spawn-time env
   *  hygiene + the shim's warning line — pick policy itself lives in main's answer,
   *  so a runtime toggle still reaches already-open tabs. */
  multiAccountOn?: () => boolean
  /** builds a per-tab `claude --settings` file (injecting the SessionStart hook)
   *  and returns its path; set by main. Undefined skips hook injection. */
  makeHookSettings?: (tabId: string) => string | undefined

  private ptys = new Map<string, PtyHandle>()
  private counter = 0
  // per-process tag so tab ids are globally unique across concurrent Koloft instances
  // (two builds, or one build opened twice) that may share a registration dir. The
  // registration watchers ignore any tabId this PtyManager doesn't know, so a peer
  // instance's files are skipped instead of cross-binding to a same-numbered tab.
  private instanceTag = process.pid.toString(36)

  create(args: CreateArgs): PtyHandle {
    const id = `pty-${this.instanceTag}-${++this.counter}`
    const isWin = os.platform() === 'win32'
    const login = userShell()
    const shell = args.shell || login.shell

    let env: Record<string, string> = {
      ...((args.kind === 'codex' ? (args.processEnv ?? process.env) : process.env) as Record<
        string,
        string
      >),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      KOLOFT_TAB_ID: id,
      // Impersonate Apple Terminal so macOS's system /etc/zshrc sources
      // /etc/zshrc_Apple_Terminal, whose precmd hook emits an OSC 7 sequence with the
      // shell's current directory (file://<host>/<path>) on every prompt / cd. Main
      // parses it out of the data stream below (OscCwdParser, D13) so a utility tab
      // follows `cd` — the only way to track a plain shell's cwd (node-pty reports
      // nothing on cd).
      //
      // Deliberately do NOT set TERM_SESSION_ID: the Apple script's *other* block
      // (per-session history, ~/.zsh_sessions/, exit-time saves) is gated on it, so
      // leaving it unset activates only the OSC 7 cwd report — no history pollution or
      // file writes. bash is covered too via /etc/bashrc_Apple_Terminal.
      TERM_PROGRAM: 'Apple_Terminal'
    }
    // A Finder-launched Electron app inherits no locale, leaving the shell in the C
    // locale where CJK is mangled and wcwidth treats wide chars as width 1 — which
    // misaligns Claude Code's TUI. Force a UTF-8 locale only when none is set.
    if (
      !/UTF-?8/i.test(env.LC_ALL ?? '') &&
      !/UTF-?8/i.test(env.LANG ?? '') &&
      !/UTF-?8/i.test(env.LC_CTYPE ?? '')
    ) {
      env.LANG = 'en_US.UTF-8'
    }
    // Inherited env that would mislead a tab — strip so each tab starts clean:
    //  - CLAUDE_CODE_* / CLAUDECODE / CLAUDE_EFFORT / AI_AGENT: if koloft is launched from
    //    inside a Claude Code session these make a nested `claude` think it's a
    //    non-top-level child and skip writing its ~/.claude/projects/<enc>/<sid>.jsonl
    //    (exactly the file we tail).
    //  - TERM_SESSION_ID: macOS's /etc/zshrc_Apple_Terminal gates its per-session
    //    history / ~/.zsh_sessions / exit-save block on this var. We set TERM_PROGRAM=
    //    Apple_Terminal to obtain the OSC 7 cwd report, but a TERM_SESSION_ID leaked
    //    from the launch env (Terminal.app / iTerm / VS Code all set it) would ALSO
    //    enable that block — writing session files and colliding across Koloft tabs that
    //    share the one leaked id. Drop it.
    //  - KOLOFT_UTIL: the utility-shell marker the shim's hard block reads (A9/§06). It is
    //    set below, per tab, for global-terminal tabs only — inheriting one (Koloft
    //    launched from inside another Koloft's terminal tab) would mark EVERY tab, and
    //    the session's own claude would be turned away by a block meant for shells.
    //  - KOLOFT_AUX / KOLOFT_AUX_TITLE: what that marker was called before the aux terminal
    //    retired. Nothing reads them now, but an older Koloft in the ancestry still
    //    exports them, and a marker whose meaning moved under it must not travel.
    //  - KOLOFT_SESSION_DIR / KOLOFT_OPEN_DIR / KOLOFT_HOOK_SETTINGS: this Koloft's own dirs are
    //    set below, per tab, and a global-terminal tab deliberately gets NONE of them
    //    (§06). An inherited set (Koloft launched from inside another Koloft's terminal)
    //    would quietly restore all three — registering that tab's `claude -p` into the
    //    PARENT instance's dir, which is the ghost-sidebar-row case D8 closes.
    //  - ANT_ACCOUNT: an auth wrapper's per-invocation account TAG, read by the
    //    SessionStart hook into SessionInfo.account (the sidebar/statusline label).
    //    Launch Koloft from a shell that a wrapper already authenticated — e.g. `npm run
    //    dev` typed inside a wrapped Claude Code session — and every tab inherits that
    //    label, so each session claims an account it has nothing to do with. The
    //    inherited value can never be right: it describes the process that STARTED
    //    Koloft, not the session in the tab. Note the credential itself (CLAUDE_CODE_
    //    OAUTH_TOKEN) is already dropped by the prefix rule above; keeping the label
    //    that names it while dropping the token is the inconsistency this closes.
    //    A wrapper invoked INSIDE a tab still sets it per-run, downstream of this env.
    //  - KOLOFT_FIRST_PROMPT / KOLOFT_SESSION_NAME (§4.8): the shim types
    //    KOLOFT_FIRST_PROMPT into a fresh session as its first message. It is set below,
    //    per tab, ONLY for a scheduled run; an inherited one (Koloft started from inside a
    //    scheduled run's own session) would make every ordinary new tab send somebody
    //    else's task by itself.
    //  - KOLOFT_CDP_DIR / KOLOFT_BROWSER_CDP / PLAYWRIGHT_MCP_CDP_ENDPOINT (D9): the dir of
    //    per-tab endpoint files, and the `ws://…/cdp/…` endpoint the shim exports out of it
    //    into a session under two names (the generic one and the one playwright-mcp reads
    //    by itself). The dir is set below, per tab, and the endpoint by the shim — and a
    //    utility shell gets NONE of them, since an endpoint there would put an agent
    //    surface on the one tab defined as having no agent in it. Inherited, they all name
    //    the PARENT Koloft's browser: launch Koloft from inside another Koloft's session —
    //    `npm run dev`, or the e2e suite — and every tab, utility shells included, drives
    //    the parent instance's browser.
    for (const key of Object.keys(env)) {
      if (
        key.startsWith('CLAUDE_CODE_') ||
        key === 'CLAUDECODE' ||
        key === 'CLAUDE_EFFORT' ||
        key === 'AI_AGENT' ||
        key === 'TERM_SESSION_ID' ||
        key === 'KOLOFT_UTIL' ||
        key === 'KOLOFT_AUX' ||
        key === 'KOLOFT_AUX_TITLE' ||
        key === 'KOLOFT_SESSION_DIR' ||
        key === 'KOLOFT_OPEN_DIR' ||
        key === 'KOLOFT_HOOK_SETTINGS' ||
        key === 'KOLOFT_FIRST_PROMPT' ||
        key === 'KOLOFT_SESSION_NAME' ||
        key === 'KOLOFT_CDP_DIR' ||
        key === 'KOLOFT_BROWSER_CDP' ||
        key === 'PLAYWRIGHT_MCP_CDP_ENDPOINT' ||
        key === 'ANT_ACCOUNT'
      ) {
        delete env[key]
      }
    }
    // §06: a global-terminal tab is a UTILITY shell — hard-blocked for interactive
    // claude and cut off from everything that binds a shell to a session: no
    // registration dir (a `claude -p` there would register and grow a ghost sidebar
    // row) and no per-tab hook settings behind it.
    if (args.util) env.KOLOFT_UTIL = '1'
    if (this.regDir && !args.util) env.KOLOFT_SESSION_DIR = this.regDir
    // …but `open` interception is NOT session-bound (D8 amended): a shell
    // is the user's own hands — no agent can reach it, interactive claude is turned away
    // there — so an `open` typed in it is a user action and belongs in Koloft, exactly like
    // clicking that same target in a shell already does. Handing it back to macOS was
    // the one place a utility shell still pushed the user out of the window.
    if (this.openDir) env.KOLOFT_OPEN_DIR = this.openDir
    if (this.pickDir) env.KOLOFT_PICK_DIR = this.pickDir
    // …and D9's other half: a utility shell is never given a browser endpoint. Handing
    // one to the island would put an agent surface on the one tab that is defined as
    // having no agent in it.
    if (this.cdpDir && !args.util) env.KOLOFT_CDP_DIR = this.cdpDir
    if (args.kind !== 'codex' && this.multiAccountOn?.()) {
      // spawn-time snapshot: gates the shim's "skipping balancing" warning line
      env.KOLOFT_MULTI_ACCOUNT = '1'
      // an inherited ambient key would trip the shim's wrapper-respect rule in every
      // tab and silently disable balancing (rc-file exports can't be stripped — the
      // warning line covers those)
      delete env.ANTHROPIC_API_KEY
      delete env.ANTHROPIC_AUTH_TOKEN
    }
    // the plaintext-fixture seam is for tests only — a stale export in a profile must
    // never redirect the shim's credential reads in a production run
    if (process.env.KOLOFT_TEST_BACKGROUND !== '1') delete env.KOLOFT_KEYCHAIN_FILE
    // lets the open shim verify its owning Koloft is still alive (kill -0) — a tmux/
    // nohup shell keeps this env long after Koloft quit, and must pass through then
    env.KOLOFT_PID = String(process.pid)
    // per-tab settings file the shim hands to `claude --settings`, injecting a
    // SessionStart hook that reports this tab's current session id back to Koloft
    const hookSettings =
      args.util || args.kind === 'codex' ? undefined : this.makeHookSettings?.(id)
    if (hookSettings) env.KOLOFT_HOOK_SETTINGS = hookSettings
    if (this.shimDir && !isWin && args.kind !== 'codex')
      env.PATH = `${this.shimDir}:${process.env.PATH ?? ''}`
    // last, so a caller's two named keys land on a fully built env and nothing after
    // can drop them — and so this tab, and only this tab, carries them (§4.8)
    if (args.extraEnv) {
      // the two names are spelled out rather than looped over the object: the TYPE says
      // only these two may be set, and this makes that true at run time as well, where
      // the object comes off a caller the compiler never saw. A key like PATH slipped in
      // here would otherwise undo the shim line just above it.
      for (const k of ['KOLOFT_FIRST_PROMPT', 'KOLOFT_SESSION_NAME'] as const) {
        const v = args.extraEnv[k]
        if (v !== undefined) env[k] = v
      }
    }

    if (args.kind === 'codex') {
      env = Object.fromEntries(
        Object.entries(codexEnvironment(env)).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    }
    const proc = pty.spawn(
      args.executable ?? shell,
      args.executable ? (args.argv ?? []) : login.args,
      {
        name: 'xterm-256color',
        cols: args.cols ?? 80,
        rows: args.rows ?? 24,
        cwd: args.cwd,
        env
      }
    )

    const handle: PtyHandle = {
      id,
      proc,
      kind: args.kind,
      cwd: args.cwd,
      alive: true,
      util: args.util === true,
      resumeSessionId: args.resumeSessionId,
      ownerTabId: args.ownerTabId
    }
    this.ptys.set(id, handle)

    let titlePoll: ReturnType<typeof setInterval> | undefined

    // D13: a utility tab's directory follows its shell, reported through the OSC 7 the
    // Apple_Terminal impersonation above turns on. Only utility shells are scanned: a
    // claude TUI floods the stream with escapes and never reports one, and its tab's
    // directory is the session's, fixed for its whole life.
    const cwdParser = args.util ? new OscCwdParser() : undefined
    proc.onData((data) => {
      this.emit('data', { id, data })
      const cwd = cwdParser?.push(data)
      // the hook fires on EVERY prompt, so most reports repeat the directory we already
      // know — forwarding those would be a layout write per command
      if (cwd && cwd !== handle.cwd) {
        handle.cwd = cwd
        this.emit('cwd', { id, cwd })
      }
    })
    proc.onExit(({ exitCode, signal }) => {
      handle.alive = false
      if (titlePoll) clearInterval(titlePoll)
      this.emit('exit', { id, exitCode, signal })
    })

    // D11: a global-terminal tab is labelled like any terminal's — with whatever its
    // shell is running (`zsh`, then `node`, …). Session ptys are excluded: their tab
    // title comes from the claude transcript, and the TUI is the foreground process
    // the whole time.
    if (args.util) {
      let last: string | undefined
      titlePoll = setInterval(() => {
        let reported: unknown
        try {
          reported = proc.process
        } catch {
          return // reading a dying pty's tty — its exit event stops the poll
        }
        const name = foregroundName(reported)
        if (name === null || name === last) return
        last = name
        this.emit('process-title', { id, name })
      }, UTIL_TITLE_POLL_MS)
    }

    const send = (text: string, delay: number): void => {
      setTimeout(() => {
        try {
          proc.write(text + '\r')
        } catch {
          /* shell may have exited already */
        }
      }, delay)
    }
    // fix PATH after rc files load, then (a bit later, once PATH is set) launch claude
    if (args.setupCommand) send(args.setupCommand, 600)
    const launchCommand =
      typeof args.launchCommand === 'function' ? args.launchCommand(id) : args.launchCommand
    if (launchCommand) send(launchCommand, 1600)

    return handle
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.proc.write(data)
  }

  /** Backpressure (socket-level, not XON/XOFF): stop reading the pty so a flooding
   *  child blocks on its output buffer instead of overrunning the renderer. */
  pause(id: string): void {
    const h = this.ptys.get(id)
    if (h && h.alive) {
      try {
        h.proc.pause()
      } catch {
        /* dying pty — nothing to pause */
      }
    }
  }

  resume(id: string): void {
    const h = this.ptys.get(id)
    if (h && h.alive) {
      try {
        h.proc.resume()
      } catch {
        /* dying pty — nothing to resume */
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const h = this.ptys.get(id)
    if (h && h.alive && cols > 0 && rows > 0) {
      try {
        h.proc.resize(cols, rows)
      } catch {
        /* ignore resize on a dying pty */
      }
    }
  }

  kill(id: string): void {
    const h = this.ptys.get(id)
    if (h) {
      try {
        h.proc.kill()
      } catch {
        /* already dead */
      }
      this.ptys.delete(id)
    }
  }

  get(id: string): PtyHandle | undefined {
    return this.ptys.get(id)
  }

  /** OS pid of a tab's shell process — the root for descendant/liveness scans
   *  (e.g. "is claude still running in this tab?"). Undefined for unknown tabs. */
  pidOf(id: string): number | undefined {
    return this.ptys.get(id)?.proc.pid
  }

  /** Registry snapshot in creation order — the spine of the adoption inventory
   *  (M3). */
  list(): PtyHandle[] {
    return [...this.ptys.values()]
  }

  /** The SessionStart hook bound this tab: the spawn-time resume intent is settled,
   *  and a stale copy must not resurrect as a phantom "resuming" tab in a later
   *  adoption (a review finding). */
  clearResumeIntent(id: string): void {
    const h = this.ptys.get(id)
    if (h) h.resumeSessionId = undefined
  }

  /** decision 4: the reload/close teardown kills every utility shell —
   *  the new renderer respawns a fresh strip, so a survivor is an invisible leak. */
  killUtilOrphans(): void {
    for (const h of this.list()) if (h.util) this.kill(h.id)
  }

  /** Drop handles whose pty already exited (M6). Reaped at teardown, not
   *  in the exit event: a late hook registration for a just-dead tab must still find
   *  its handle, or a graceful Ctrl+D exit could race past its own eviction. */
  reapDead(): void {
    for (const h of this.list()) if (!h.alive) this.ptys.delete(h.id)
  }
}

/** The Koloft main-process pid baked into a tab id (`pty-<pid base36>-N`) — lets a
 *  registration consumer decide whether an unknown tabId belongs to another LIVE
 *  instance (leave it alone) or to a closed tab / dead instance (handle it).
 *  Null for malformed / non-pty ids. */
export function tabInstancePid(tabId: string): number | null {
  const m = /^pty-([a-z0-9]+)-/.exec(tabId)
  if (!m) return null
  const pid = parseInt(m[1], 36)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}
