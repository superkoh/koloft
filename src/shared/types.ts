/**
 * A resolved project for a working directory — the sidebar groups tabs by `root`.
 *  - `root`: canonical (realpath'd) project root. For a git repo this is the repo
 *    root, and a linked worktree shares its repo root with the main worktree so the
 *    two aggregate into one group. For a non-git / submodule dir it is the directory
 *    itself. See `projectInfoFor` in src/main/projectInfo.ts.
 *  - `treeRoot`: the git checkout top-level this cwd lives in — a *linked* worktree's
 *    own checkout root (not the shared repo root), the repo root for the main worktree,
 *    or the directory itself for a non-git path. The file tree roots here so it pins to
 *    the checkout (and a worktree browses its own files) rather than aggregating like
 *    `root` does for grouping.
 *  - `worktreeName`: the linked git worktree's registered name (basename of
 *    `.git/worktrees/<name>`), shown as the 🌿 badge. Absent for the main worktree,
 *    submodules, and non-git dirs.
 */
export interface ProjectInfo {
  root: string
  treeRoot: string
  worktreeName?: string
}

/**
 * How an account authenticates a spawned `claude` (which env the shim injects):
 *  - 'oauth'  — a subscription token (CLAUDE_CODE_OAUTH_TOKEN). The only kind with
 *    measurable quota, so the only kind the balancer actually scores.
 *  - 'apikey' — a console API key (ANTHROPIC_API_KEY): metered, no quota to read.
 *  - 'custom' — an Anthropic-COMPATIBLE third-party endpoint (ANTHROPIC_BASE_URL +
 *    ANTHROPIC_AUTH_TOKEN, usually with a model override). Same "no readable quota"
 *    situation as an API key, plus it answers with a different model entirely.
 */
export type AccountKind = 'oauth' | 'apikey' | 'custom'

/** Persisted health of an account's credential.
 *  - 'ok'         — verified at some point; eligible for balancing
 *  - 'expired'    — two consecutive 401s confirmed the credential is dead (a lone 401
 *                   is treated as a network flap); any later successful probe heals it
 *  - 'unverified' — saved without a successful verification (offline add); excluded
 *                   from balancing until a probe succeeds */
export type AccountStatus = 'ok' | 'expired' | 'unverified'

/** Whether the account's plan can run fable-class models. Derived from the probe (a
 *  fable probe that errors with a model-unavailable shape ⇒ 'no'; a response carrying
 *  the 7d_oi bucket ⇒ 'yes'; a 200 WITHOUT that bucket ⇒ 'no', because "the model
 *  answered" only means the plan bills it, not that it is included — D17).
 *
 *  DISPLAY ONLY. The picker deliberately does NOT read this field: it ranks off
 *  `UsageSnapshot.hasOi`, which carries the snapshot's own freshness. A stale badge
 *  must never decide whether a launch is routed to a fable host (D17). */
export type FableCapability = 'yes' | 'no' | 'unknown'

/** Account names are Keychain primary keys AND travel through a bash `security`
 *  call, a res JSON and the terminal banner — the charset is an injection surface,
 *  not a UX nicety. Enforced in main's accounts:add and re-checked on settings load. */
export const ACCOUNT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

/** Keychain namespace: every BUILD gets its own credential store, keyed by the same
 *  app name Electron derives userData from ('koloft' | 'koloft-dev' | 'koloft-beta'). Sharing
 *  one store across builds half-isolates state — the registry that says which accounts
 *  exist is already per-build, so a dev run deleting an account would strand the
 *  installed app's settings.json pointing at a credential that no longer exists. It
 *  also lets work-in-progress code destroy the credentials the shipped app depends on.
 *
 *  Note what this is NOT: a security boundary. These items' ACL trusts /usr/bin/security,
 *  so any process running as the user can already read all of them regardless of name.
 *  This buys blast-radius containment between builds, not protection from other code.
 *
 *  Anything that isn't a recognised `koloft-<variant>` build maps to the production
 *  namespace, whose service names are byte-identical to the pre-namespacing ones — so
 *  a shipped install needs no migration, and a package.json rename can't silently
 *  orphan real credentials in a namespace nothing reads. */
export function keychainNamespace(appName: string): string {
  return /^koloft-[a-z0-9-]+$/.test(appName) ? appName : 'koloft'
}

/** Keychain service name for a build + credential kind. The bash shim reads the
 *  credential itself (main never hands a token across the pick channel), so it needs
 *  the same answer — setupShim() bakes this function's output into the script rather
 *  than restating the strings in bash. */
export function keychainService(appName: string, kind: AccountKind): string {
  return keychainNamespace(appName) + keychainServiceSuffix(kind)
}

/** The per-kind tail of a Keychain service name (`<namespace><suffix>`). */
export function keychainServiceSuffix(kind: AccountKind): string {
  if (kind === 'oauth') return '-claude-oauth'
  return kind === 'apikey' ? '-anthropic-api' : '-custom-endpoint'
}

/** One configured account. Metadata only — secrets live exclusively in the macOS
 *  Keychain (service `<namespace>-claude-oauth` / `-anthropic-api`, account = `name`);
 *  no field of this object ever holds token material. */
export interface AccountMeta {
  name: string
  kind: AccountKind
  /** user intent: participate in balancing. Kept independent from `status`. */
  enabled: boolean
  fable: FableCapability
  status: AccountStatus
  addedAt: number
  /** oauth only: epoch ms of the last CONCLUSIVE fable-model probe verdict. The §08
   *  downgrade clock — while `fable === 'no'` and this is fresher than a week, routine
   *  probes stay on the fallback model (①, closed defensively: the probe is
   *  a bare main-process fetch outside CC's consent, so a no-fable account must not
   *  keep firing fable requests). */
  fableCheckedAt?: number
  /** 'custom' only: the Anthropic-compatible base URL (ANTHROPIC_BASE_URL) */
  baseUrl?: string
  /** 'custom' only: model id forced on the session — a third-party endpoint serves
   *  its own models, so every model slot (default/opus/sonnet/haiku/fable/subagent) is
   *  pinned to this one or the CLI would ask for a claude-* model it cannot serve */
  model?: string
}

/** A base URL safe to hand a shell export: http(s) only, no quotes/spaces/controls. */
export function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 300) return false
  if (!/^https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]+$/.test(v)) return false
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Drop malformed / hostile entries from a settings-loaded account list (names reach
 *  a shell and the Keychain; never trust what was on disk). */
export function sanitizeAccountList(raw: unknown): AccountMeta[] {
  if (!Array.isArray(raw)) return []
  const out: AccountMeta[] = []
  const seen = new Set<string>()
  for (const a of raw as Partial<AccountMeta>[]) {
    if (!a || typeof a.name !== 'string' || !ACCOUNT_NAME_RE.test(a.name)) continue
    if (a.kind !== 'oauth' && a.kind !== 'apikey' && a.kind !== 'custom') continue
    // a custom endpoint without a URL cannot be injected — drop rather than ship a
    // row that would silently fail at launch
    if (a.kind === 'custom' && !isHttpUrl(a.baseUrl)) continue
    const key = `${a.kind}:${a.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name: a.name,
      kind: a.kind,
      enabled: a.enabled !== false,
      fable: a.fable === 'yes' || a.fable === 'no' ? a.fable : 'unknown',
      status: a.status === 'expired' || a.status === 'unverified' ? a.status : 'ok',
      addedAt: typeof a.addedAt === 'number' ? a.addedAt : 0,
      ...(typeof a.fableCheckedAt === 'number' && Number.isFinite(a.fableCheckedAt)
        ? { fableCheckedAt: a.fableCheckedAt }
        : {}),
      ...(a.kind === 'custom'
        ? {
            baseUrl: a.baseUrl,
            // the model id lands in a shell export — keep it to characters that
            // cannot end a quoted string or start a command
            model:
              typeof a.model === 'string' && /^[A-Za-z0-9._:@/\-[\]]{1,64}$/.test(a.model)
                ? a.model
                : undefined
          }
        : {})
    })
  }
  return out
}

/** Closed probe-failure vocabulary. Raw error strings never cross IPC — a fetch
 *  error's cause chain can stringify request options including the Authorization
 *  header, so main maps every failure onto this enum before it leaves the process. */
export type ProbeErrorKind = 'expired' | 'network' | 'model-unavailable' | 'unknown'

/** An account's latest successful probe: `anthropic-ratelimit-unified-*` response
 *  headers parsed into the three buckets (5h / 7d / 7d_oi a.k.a. fable weekly).
 *  utilization ∈ [0,1]; reset = epoch seconds; status = bucket status ('?" unknown).
 *  Absent buckets read as 0 / '?'. `overage` is display-only, never scored. */
export interface UsageSnapshot {
  u5: number
  u7: number
  uoi: number
  s5: string
  s7: string
  soi: string
  r5: number
  r7: number
  roi: number
  overage: string
  /** the response carried a `7d_oi` bucket ⇒ this plan has an INCLUDED fable
   *  allowance. The only trustworthy "fable is free here" signal (D17): a fable
   *  request that merely succeeds proves the plan *bills* it, not that it is included.
   *  Lives on the snapshot rather than on AccountMeta so it inherits the same
   *  freshness the picker already reasons about. */
  hasOi: boolean
  /** epoch ms this snapshot was fetched — drives the derived "stale" display state */
  at: number
}

/** What `accounts:list` returns: metadata + latest usage. NEVER any secret. */
export interface AccountView extends AccountMeta {
  usage?: UsageSnapshot
  /** most recent probe failure, when the latest attempt did not succeed */
  probeError?: ProbeErrorKind
}

/** Result of `accounts:add` — the single renderer→main token transit (write-only). */
/**
 * Live state of a guided login. The whole flow runs in a pty the user never sees, so
 * everything they might need mid-flow has to come back through here:
 *  - 'starting'  — pty spawned, command typed
 *  - 'browser'   — the CLI emitted an auth URL (carried in `url` so the panel can
 *                  offer it: a hidden terminal must never sit on the one link the
 *                  user has to click)
 *  - 'saved'     — token captured, stored, account added
 *  - 'failed'    — the CLI exited (or timed out) without printing a token. `tail`
 *                  carries the last output so the panel can show what happened, and
 *                  `tabId` lets the user promote that same pty into a real tab
 */
export interface LoginProgress {
  phase: 'starting' | 'browser' | 'saved' | 'failed'
  name: string
  url?: string
  tail?: string
  /** the hidden pty's id — the escape hatch: adding it as a tab makes it visible */
  tabId?: string
  cwd?: string
}

export interface AccountAddResult {
  ok: boolean
  /** 'invalid-name' | 'duplicate' | 'invalid-endpoint' | a ProbeErrorKind when
   *  verification failed (the account is still saved as 'unverified' for probe kinds) */
  error?: 'invalid-name' | 'duplicate' | 'invalid-endpoint' | ProbeErrorKind
  account?: AccountView
}

export interface Settings {
  sessionMethods: SessionMethods
  /** CSS font-family stack for the terminals */
  fontFamily: string
  fontSize: number
  /** width (px) of the Workbench panel in T2 (FR-08). Floor 440 — the two merged panes
   *  had different floors, and the higher one wins because a `web` tab can be any tab:
   *  below 440 a page hits most sites' mobile breakpoint. Initialized from the larger of
   *  the two dead keys below on first read. */
  workbenchWidth: number
  /** RETIRED by the Workbench merge, still declared because `settings.ts` merges
   *  then rewrites the whole document and has no key-deletion mechanism — inventing one
   *  for a one-off migration would cost more than the two dead keys on disk. Read once,
   *  to seed `workbenchWidth`; never written again. */
  filePaneWidth: number
  /** RETIRED with `filePaneWidth` — see above. */
  browserPaneWidth: number
  /** RETIRED with the sidebar file tree (FR-44…FR-50 moved browsing into the
   *  Workbench's pinned `files` tab). Kept for the same reason as the two above: the
   *  settings document is merged then rewritten whole, with no key-deletion mechanism. */
  fileTreeHeight: number
  /** width (px) of the left sidebar (user-resizable, clamped to a minimum) */
  sidebarWidth: number
  /** multi-account mode master switch: every claude launched in a Koloft tab is
   *  load-balanced across `accounts` via the shim pick channel (D2/D9) */
  multiAccount: boolean
  /** append --dangerously-skip-permissions when the balancer injects an account
   *  (D6; never overrides an explicit --permission-mode / same flag in argv) */
  skipPermissions: boolean
  /** D20: whether the included fable allowance is a routing dimension at all.
   *  On (default) is the original behavior — a pool holding any fable host ranks on fable
   *  and only hosts are eligible. Off, the pick ignores fable entirely and ranks on
   *  5h/7d alone, so a nearly-spent host stops collecting every launch. */
  fablePriority: boolean
  /** the account pool. Secrets live in the Keychain, never here (D1/D13). */
  accounts: AccountMeta[]
  /** notify (toast / OS notification) when a session's turn finishes */
  notifyTurnDone: boolean
  /** notify when a session is blocked on a permission prompt */
  notifyApproval: boolean
  /** notify when a session dies hard (no graceful SessionEnd) */
  notifyExited: boolean
  /** play a sound (shell.beep) for approval events only — the one category worth a
   *  beep; off by default (D3) */
  notifyApprovalSound: boolean
  /** mirror the pending "needs you" count on the macOS Dock badge */
  dockBadge: boolean
  /** show the per-session cost / context-usage sub-row; off = single-line rows */
  showUsage: boolean
  /** inject Koloft's bundled ccstatusline into every tab-launched claude, overriding the
   *  user's own statusLine setting for that session (docs/claude-code-contract.md §6);
   *  off = don't inject, the user's own settings apply untouched */
  statuslineBuiltin: boolean
  /** let Koloft fetch origin in the background to keep the workspace freshness badge
   *  live (D8). Off stops every automatic fetch (including the C8 dialog's); the
   *  manual entries — popover ⟳ and the workspace menu's Fetch origin — still work. */
  gitAutoFetch: boolean
  /** D2: hand every session's claude a CDP endpoint onto Koloft's own Browser, so
   *  the agent's browser tools drive the pages the user can see instead of launching a
   *  Chromium of their own. This switch is the ONE way to send those tools back to
   *  their own browser — the env beats their `--isolated` flag — so it is load-bearing,
   *  not a second lock. Off drops every live connection at once. */
  browserControl: boolean
  /** how tall (px) the Notes island stands when it is open */
  notesHeight: number
  /** whether the Notes island is folded down to just its head band */
  notesFolded: boolean
  /** keep the Mac awake while Koloft is open: main holds a `caffeinate -dims` child
   *  (display, idle, disk, system sleep) for as long as this is on, so a long Claude
   *  turn is never cut short by the lid-open machine dozing off. Off kills it at once. */
  keepAwake: boolean
  /** IANA zone ids shown as world clocks above the TUI, after the machine's own zone
   *  (which is never stored — it follows the system). At most WORLD_CLOCK_MAX. */
  worldClocks: string[]
  /** the welcome steps were completed or skipped once. Reset to defaults clears it. */
  onboardingSeen: boolean
  /** ids of contextual hints already shown (see HINT_IDS). */
  hintsSeen: string[]
  /** "Don't show tips" — no hint ever shows. */
  hintsOff: boolean
  /** app version whose release notes the user has seen; '' = never recorded. */
  lastSeenVersion: string
}

/** the contextual hints, each shown at most once. `hintsSeen` holds these ids. */
export const HINT_IDS = ['workbench', 'approval', 'agent-web', 'worktree', 'github'] as const
export type HintId = (typeof HINT_IDS)[number]

/** how many zones the user may add beside the local one */
export const WORLD_CLOCK_MAX = 3

export const DEFAULT_SETTINGS: Settings = {
  sessionMethods: { defaultBackend: 'claude', enabled: { claude: true, codex: true } },
  // a Nerd Font first so powerline/git/icon glyphs render, then plain fallbacks
  fontFamily:
    '"JetBrainsMono Nerd Font", "MesloLGS NF", "FiraCode Nerd Font", Menlo, Monaco, monospace',
  fontSize: 13,
  workbenchWidth: 560,
  filePaneWidth: 560,
  browserPaneWidth: 560,
  fileTreeHeight: 260,
  sidebarWidth: 280,
  multiAccount: false,
  skipPermissions: true,
  fablePriority: true,
  accounts: [],
  notifyTurnDone: true,
  notifyApproval: true,
  notifyExited: true,
  notifyApprovalSound: false,
  dockBadge: true,
  showUsage: true,
  statuslineBuiltin: true,
  gitAutoFetch: true,
  browserControl: true,
  notesHeight: 260,
  notesFolded: false,
  keepAwake: true,
  worldClocks: [],
  onboardingSeen: false,
  hintsSeen: [],
  hintsOff: false,
  lastSeenVersion: ''
}

export type BackendId = 'claude' | 'codex'
export interface SessionMethods {
  defaultBackend: BackendId
  enabled: Record<BackendId, boolean>
}
export type TabKind = 'shell' | BackendId

export interface CreateTabOptions {
  worktreeResourceId?: string
  kind: TabKind
  cwd?: string
  cols?: number
  rows?: number
  /** when set on a claude tab, launch `claude --resume <id>` to re-open that session */
  resumeSessionId?: string
  /** C8 create branch: launch `claude -w <name>`, letting Claude create the
   *  worktree in its own namespace (§5; `cwd` stays the repo root) */
  worktree?: string
  /** kind 'shell' only — this shell is a tab of the global utility terminal (D1/D8):
   *  it belongs to no session, so main injects the hard block that turns an
   *  interactive `claude` away (§06) and leaves out every session-bound variable. */
  util?: boolean
  /** kind 'shell' only — the conversation tab whose Workbench opened this shell */
  ownerTabId?: string
}

/** D11: a launch main refuses is a failure the renderer has to show, not a flag it
 *  silently drops — 'invalid-args' is an illegal `-w` name or resumed id (claudeArgs.ts). */
export type CreateTabResult =
  | {
      ok: true
      /** pty id, also used as the renderer tab id */
      id: string
      /** claude session uuid — only present when kind === 'claude' */
      sessionId?: string
      cwd: string
    }
  | { ok: false; code: 'invalid-args' }

/** one live pty a freshly-(re)loaded renderer rebuilds as a tab WITHOUT
 *  spawning anything — main is the source of truth for the tab inventory. */
export interface AdoptableTab {
  /** pty id, also the renderer tab id (same universe across the reload) */
  id: string
  kind: TabKind
  cwd: string
  /** bound claude session id (SessionStart hook landed) */
  sessionId?: string
  /** unbound resume in flight — the renderer restores `resuming` and re-arms its latch */
  resumeSessionId?: string
  /** session title from the tracker; absent → renderer default applies */
  title?: string
}

export interface TabInventoryReply {
  tabs: AdoptableTab[]
  /** the tab that was active when the previous renderer tore down — one-shot: main
   *  clears it on read, and it is only honored if that id is in `tabs` */
  activeTabBeforeReload: string | null
}

export type PreviewKind = 'markdown' | 'image' | 'pdf'

/** How the active session last touched a file — drives the tree's read/write decoration.
 *  'wrote' (Write/Edit/MultiEdit/NotebookEdit) takes precedence over 'read' (Read). */
export type FileAccess = 'read' | 'wrote'

export interface PreviewItem {
  /** preview kind for md/html/image/pdf; absent for code/text (highlighted instead) */
  kind?: PreviewKind
  /** absolute file path */
  src: string
  /** display label (basename) */
  label: string
  /** how the active session touched this file (sidebar decoration); absent for plain previews */
  access?: FileAccess
  /** best-effort lines added by the session's edits (decoration badge) */
  added?: number
  /** best-effort lines removed by the session's edits (decoration badge) */
  removed?: number
}

/** Per-file git working-tree status, simplified for the file-tree decoration. */
export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflict'

/** absolute-path → working-tree status for a repo (see `fs.gitStatus`). */
export type GitStatusMap = Record<string, GitFileStatus>

/** absolute-path → net line delta vs the merge-base with the default branch
 *  (`git diff <base> --numstat`); see `fs.gitNumstat`. Only changed tracked files
 *  appear; untracked and binary files are omitted. */
export type GitNumstatMap = Record<string, { added: number; removed: number }>

/** Directory names the Workbench hides by default on every project, exactly as if git
 *  ignored them: dropped while "Show ignored files" is off, listed and marked when it is
 *  on. Only the two that are heavy everywhere and never worth a look by accident. `build`,
 *  `dist` and `out` used to be here too, which hid a tracked `build/` (this repo keeps its
 *  icon there) with no switch to bring it back — a name is not evidence of build output;
 *  git's ignore verdict is. Shared so the tree, the change watcher and the row tooltip
 *  cannot drift apart. */
export const HIDDEN_BY_DEFAULT_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git'])

/** One immediate child of a directory, returned by the `fs:listDir` IPC. */
export interface DirEntry {
  /** basename */
  name: string
  /** absolute path */
  path: string
  isDir: boolean
  /** git ignores this entry (or it is a hidden-by-default name like `node_modules`), and
   *  the tree is showing it anyway — the "Show ignored files" switch is on. Set on files
   *  and directories alike; an ignored directory opens like any other. */
  ignored?: boolean
}

/** What a file looked like when we last saw it (§05). Modification time AND size, because
 *  either alone is fooled: a same-size edit inside one clock tick moves neither, and on a
 *  network share / exFAT the time only has 1–2s of precision. Handed out by every `edit.*`
 *  call and handed straight back as the next write's `expect`. */
export interface EditFingerprint {
  mtimeMs: number
  size: number
}

/** The answer to `edit.open` — the file's text plus everything the editor needs to decide
 *  whether it may be changed at all. */
export interface EditOpenResult {
  text: string
  mtimeMs: number
  size: number
  /** what the line breaks on disk are; `write` restores them */
  eol: 'lf' | 'crlf'
  /** B-04: why this file may be READ but not edited, or null when it may. One field
   *  rather than four booleans — the four could contradict each other, and the yellow
   *  banner picks its sentence off this single value. */
  readOnly: null | 'notUtf8' | 'mixedEol' | 'noPerm' | 'dirNotWritable'
}

/** The answer to `edit.write`. "The file changed under us" is a RETURN, not a throw: it is
 *  a normal ending that has to carry data back (the conflict bar draws a diff against
 *  `text`, the content found on disk). Everything else still throws. */
export type EditWriteResult =
  | { ok: true; mtimeMs: number; size: number }
  | {
      ok: false
      code: 'stale'
      mtimeMs: number
      size: number
      /** what is on disk now, or null when it cannot be shown — over the 512 KB open cap,
       *  binary, or unreadable. Null means "it changed, but there is no diff to draw". */
      text: string | null
    }

/** The answer to `edit.create` — the fingerprint comes back with it so the editor can open
 *  the new file without a second read, which the file could change in between. */
export interface EditCreateResult {
  path: string
  mtimeMs: number
  size: number
}

/** A file matching a file-tree search query (see `fs.search`). Files only. */
export interface SearchHit {
  /** basename */
  name: string
  /** absolute path */
  path: string
  /** path relative to the search root — shown to disambiguate same-named files */
  rel: string
  /** git ignores this file; it is only ever a hit while the tree's "Show ignored files"
   *  switch is on */
  ignored?: boolean
}

/** One content-search match (see `fs.searchContent`): a single matching line. */
export interface ContentHit {
  /** absolute path */
  path: string
  /** path relative to the search root */
  rel: string
  /** 1-based line number of the match */
  line: number
  /** the matching line's text (trimmed/clipped for display) */
  text: string
}

/**
 * Why a session needs the user (see src/main/attention.ts):
 *  - 'turn-done' — the turn finished; it's the user's move
 *  - 'approval'  — a tool call is blocked on a permission prompt (highest urgency)
 *  - 'exited'    — claude died hard under a live shell (no graceful SessionEnd)
 */
export type AttentionKind = 'turn-done' | 'approval' | 'exited'

/** A pending "needs you" marker for one tab. At most one per tab; approval outranks
 *  turn-done, exited replaces everything (a dead session's prompts are moot). */
export interface AttentionEvent {
  tabId: string
  kind: AttentionKind
  at: number
  /** session title snapshotted when the event was raised — an exited session is
   *  untracked moments later, and its marker must still name the session */
  title?: string
  /** re-raised by the reconsider stale-context heal: pend it (badge/strip/dock) but
   *  give it NO interrupting outlet — the user plausibly watched the original */
  resurrected?: boolean
}

/** Per-tab flow-control counters (see src/main/flowControl.ts). */
export interface FlowStats {
  tabId: string
  /** cumulative units forwarded to the renderer (including pre-attach passthrough) */
  sentUnits: number
  /** cumulative units the renderer acked as consumed */
  ackedUnits: number
  /** send window currently shut (backlog held in main) */
  blocked: boolean
  /** pty currently paused by the backstop */
  paused: boolean
  inflight: number
  attached: boolean
}

/**
 * Live run-state of a Claude session, surfaced as the tab's status dot:
 *  - 'working'  — actively generating / running tools (UserPromptSubmit … Stop),
 *                 or the main loop stopped while background subagents / workflow
 *                 runs are still executing (their completion re-invokes it)
 *  - 'waiting'  — turn ended and background work drained, awaiting the user
 *  - 'approval' — a tool call is paused on a permission prompt (needs the user)
 *  - 'idle'     — has been waiting on the user a while with no activity
 * Driven by the injected hooks (see hooks.ts); absent until the first one fires,
 * which renders as a neutral claude dot.
 */
export type SessionStatus = 'working' | 'waiting' | 'approval' | 'idle'

/**
 * Something a session keeps open that is NOT work in progress, so it neither
 * holds the dot at 'working' nor is it invisible: a background shell that turned
 * out to be a server (it listens on a port, or has run longer than any test
 * would), a Monitor waiting for events, a teammate idle between messages. Shown
 * as a badge on the session row so the user can see what is hanging around and
 * release it (product decision — before that every one of these pinned
 * the dot 'working' for 10 minutes after each reply).
 */
export interface ParkedItem {
  kind: 'server' | 'monitor' | 'teammate'
  /** the shell command (server / monitor), or how many teammates are idle */
  label: string
  /** how long the process has been running (servers only) */
  ageMs?: number
}

/**
 * Per-session token/cost usage, accumulated from the session's jsonl `usage`
 * records (see src/main/sessionTracker.ts). Cost figures are ESTIMATES aligned
 * with ccusage (src/shared/pricing.ts); when ANY record's model is unpriced,
 * `costUsd`/`todayCostUsd` are omitted and the UI falls back to a token count —
 * never a fabricated dollar figure (design D6).
 */
export interface SessionUsage {
  /** cumulative input tokens across the session's assistant records */
  inTok: number
  /** cumulative output tokens */
  outTok: number
  /** cumulative cache-creation (write) tokens */
  cacheWriteTok: number
  /** cumulative cache-read tokens */
  cacheReadTok: number
  /** running session cost (USD); omitted when any record's model is unpriced */
  costUsd?: number
  /** cost accrued on the day identified by `todayDayKey`; omitted when unpriced/zero */
  todayCostUsd?: number
  /** local `YYYY-MM-DD` the `todayCostUsd` bucket belongs to. The renderer treats a
   *  key that isn't the current local day as $0 — so an idle session's "today" total
   *  self-expires at local midnight without any main-side timer. */
  todayDayKey?: string
  /** latest record's model id (drives the hover card's model chip + window) */
  model?: string
  /** Claude Code CLI version stamped on the session's records (info-card metadata) */
  ccVersion?: string
  /** context size = latest record's input + cache_read + cache_creation tokens */
  ctxTokens?: number
  /** ctxTokens ÷ the model's window (0..1+); omitted when the latest model is unpriced */
  ctxPct?: number
}

/** Stand-in title for a session that has registered but isn't named yet — nothing has
 *  been parsed out of its jsonl (no ai-title, no sidecar, no first prompt). It is NOT a
 *  name: anything that actually names the session outranks it (see the renderer's
 *  displayTitle), so it can't mask a real title during the unnamed window. */
export const PLACEHOLDER_SESSION_TITLE = 'Claude session'

/** Title of a sidebar row whose pty is up but whose session has not materialized
 *  yet (§4 pending → promotion; C2 renders it italic/faint via `.st-pending`). */
export const PENDING_SESSION_TITLE = 'Starting…'

export interface SessionInfo {
  cliVersion?: string
  background?: {
    id: string
    kind: 'agent' | 'command'
    label: string
    state: 'working' | 'waiting' | 'unknown'
  }[]
  backendId?: BackendId
  nativeSessionId?: string
  observation?: 'live' | 'degraded'
  /** pty id of the owning terminal tab */
  tabId: string
  /** claude session uuid */
  sessionId: string
  /** ai-title if available, otherwise the first user prompt (truncated);
   *  PLACEHOLDER_SESSION_TITLE until one of those exists */
  title: string
  /** Where claude stands this instant, off every transcript line. An internal value:
   *  it is what a relative tool path is resolved against as it is read, and nothing
   *  that takes the user SOMEWHERE may follow it — a `cd` in the TUI moves it without
   *  the session having gone anywhere (R11). */
  cwd: string
  /** THE DIRECTORY THIS SESSION IS IN — the one every "take me there" follows: the files
   *  panel roots here, ⌃` opens a shell here, ⇧⌘R resumes here, and the row's Reveal in
   *  Finder opens it. Held VERBATIM (no checkout walk-up — a subdir workspace keeps its
   *  subdir root, D5).
   *
   *  Moves on a session boundary (a non-compact SessionStart: launch, /clear, in-TUI
   *  /resume) and when claude MOVES the session to another checkout mid-conversation; it
   *  is deliberately immune to plain cwd drift. Who may move it, and why each case is the
   *  way it is: `sessionTracker.setTreeRoot` and its callers. */
  treeRoot: string
  /** When the session is inside a *linked* git worktree, its stable worktree name —
   *  git's registered worktree id, i.e. basename of `.git/worktrees/<name>`. Resolved
   *  from `treeRoot`, never from `cwd`: it is the same from every subdir and survives
   *  the checkout folder being renamed, and a `cd` into another checkout is not this
   *  session changing worktree. Absent for the main worktree / non-git dirs, and
   *  always absent for a remote session (nothing here may walk that machine's disk).
   *  The UI shows this, NOT basename(cwd) (the folder/pwd name). */
  worktree?: string
  /** claude has MOVED this session to another checkout since it bound here. Until
   *  it does, `treeRoot` is only the directory the tab was LAUNCHED in — and a resumed
   *  worktree session is NOT there: claude re-enters its worktree after the SessionStart
   *  hook has reported the launch dir (contract §1), so nothing may take `worktree` for
   *  the last word before this is set. */
  relocated?: boolean
  jsonlPath?: string | null
  /** Claude Code's per-session scratchpad dir (see scratchpadDirFor). The file tree
   *  lists it directly, because most scratchpad artifacts are produced by Bash or a
   *  subagent and so never appear in `files`. Absent until a transcript is bound. */
  scratchpadDir?: string
  /** previewable files seen in the session's tool calls */
  files?: PreviewItem[]
  /** the file the session most recently read/wrote. Only meaningful while
   *  `status === 'working'`. */
  lastTouched?: string
  /** the file the session most recently *wrote* (Write/Edit/…), distinct from
   *  lastTouched which also moves on reads. Drives follow mode + the pulse so they
   *  track the live edit and aren't masked by an interleaved read. */
  lastWritten?: string
  /** how many write tool calls landed while this transcript was LIVE — history replayed
   *  on a (re)bind never counts, so a resume cannot look like Claude changing a file */
  liveWrites?: number
  /** auth-wrapper account tag (e.g. a wrapper's $ANT_ACCOUNT), captured by the
   *  SessionStart hook; absent when no wrapper exported one */
  account?: string
  /** account picked by Koloft's own multi-account balancer for this tab's launch —
   *  a separate channel from the hook-reported `account` (the two never mix);
   *  drives the sidebar @chip and outranks `account` in the usage hover card */
  pickedAccount?: string
  /** the RUNNING claude CLI's version (SessionStart hook env, CLAUDE_CODE_EXECPATH) —
   *  outranks SessionUsage.ccVersion, which is whatever version wrote the transcript */
  ccVersion?: string
  /** owning pty process still running */
  alive: boolean
  /** the session runs on another machine (workspace key `ssh://host/path`, see
   *  @shared/remoteKey): `cwd`/`treeRoot` are paths THERE, the transcript is read from
   *  the local mirror, liveness comes from the pty (an ssh loop) — never from `ps` */
  remote?: { host: string }
  /** live run-state for the status dot; absent until the first hook reports */
  status?: SessionStatus
  /** what the session keeps open without working on it (see ParkedItem); absent
   *  when nothing is parked. Independent of `status`: a waiting session can hold a
   *  dev server, and the badge is what tells the user so. */
  parked?: ParkedItem[]
  /** per-session cost / token / context usage; absent until a usage record is seen */
  usage?: SessionUsage
  updatedAt: number
}

export interface ClaudeSessionInfo extends SessionInfo {
  jsonlPath: string | null
  files: PreviewItem[]
}

/** One release's changelog, as the update modal shows it. */
export interface ReleaseNotes {
  /** bare semver, no leading "v" */
  version: string
  /** changelog markdown — the release body above its `<!-- koloft:install -->` marker. Never
   *  empty: a release with no changelog is left out of the list entirely. */
  notes: string
}

/** what the welcome offers to pin — a folder Claude Code has history in. */
export interface DiscoveredFolder {
  /** the pinnable project root (projectInfoFor(cwd).root) */
  path: string
  /** how many transcripts this root has (all its slugs together) */
  sessions: number
  /** newest transcript mtime across the root's slugs, ms */
  mtime: number
}

/** the release notes shown once after an upgrade — (lastSeenVersion, current]. */
export interface WhatsNew {
  current: string
  releases: ReleaseNotes[]
  omittedReleases: number
}

/**
 * Result of an update check against the public releases repo.
 *  - 'available' — `latest` > the version installed on disk; `releases`/`htmlUrl` describe it.
 *  - 'current'   — the installed version is the newest (or ahead); nothing to install.
 *  - 'restart-required' — the newest version is already installed, but the running process
 *    booted from the older bundle (Koloft was replaced while running), so only a relaunch is
 *    missing. Offering a download here would just reinstall what's already on disk.
 * Versions are bare semver strings (no leading "v").
 */
export interface UpdateCheckResult {
  status: 'available' | 'current' | 'restart-required'
  /** the running app version (app.getVersion()) */
  current: string
  /** the newest published version; only meaningful when status === 'available' */
  latest?: string
  /** version of the app bundle on disk — the one an install replaces and the next launch
   *  runs. Equals `current` unless the app was replaced while running; absent in dev, where
   *  there is no Koloft bundle to read. */
  installed?: string
  /** changelogs for every published release newer than the installed copy, newest first —
   *  someone who skipped versions sees the whole span, not just the newest release's notes.
   *  Capped at MAX_NOTES_RELEASES; releases whose body carries no changelog are omitted. */
  releases?: ReleaseNotes[]
  /** changelogs dropped past that cap — reported so the modal can say so rather than
   *  silently truncating. */
  omittedReleases?: number
  /** the GitHub Release page, for the "View release" link */
  htmlUrl?: string
}

/** Byte progress of the update download, streamed to the modal's progress bar. */
export interface UpdateProgress {
  /** 0–100; -1 when the server sent no content-length (indeterminate) */
  percent: number
  transferred: number
  total: number
}

/** A previewable file-open intercepted by the `open` PATH shim inside a tab.
 *  `source` forks the landing exactly as it does on BrowserOpenRequest (FR-14/FR-57):
 *  an agent's open creates no tab, enters no Recents and raises no signal while the
 *  panel is collapsed, while a user's open from a shell activates `files`, renders
 *  in the reading area, enters Recents, and expands a collapsed panel. */
export interface OpenRequest {
  /** pty id of the tab whose process invoked `open` */
  tabId: string
  /** absolute path of the file to preview */
  path: string
  source: 'agent' | 'user'
}

/** The Browser's twin of OpenRequest: main's router (D3) sent a target to the Browser
 *  surface. `source` decides how it lands — a user action loads it in the foreground
 *  and expands the aux column, an agent request only creates the tab with an unread
 *  marker and loads nothing (D10/B5). The address bar never travels this channel: the
 *  renderer routes its own input. */
export interface BrowserOpenRequest {
  /** pty id of the tab whose process invoked `open` */
  tabId: string
  /** the url to open, already normalized by routeFor */
  url: string
  source: 'agent' | 'user'
  /** the target as the `open` shim handed it over — set only on the shim's channel, so
   *  a request no session can render still reaches the OS instead of vanishing. An
   *  extension's open carries none: it is owed a refusal it can observe, not a hand-off. */
  osFallback?: string
}

/** D11: the one persistent partition every Browser guest lives in — shared by main (it
 *  configures the session) and the renderer (every <webview> carries it as an
 *  attribute). A guest that omits it silently falls back to the default session, which
 *  is where the privileged koloft-file:// handler lives (SEC-6/IMPL-6). */
export const BROWSER_PARTITION = 'persist:koloft-browser'

/** §04: where the store overlay's guest starts. Shared so the
 *  renderer's overlay and any main-side routing agree on the one address. */
export const CHROME_WEB_STORE_URL = 'https://chromewebstore.google.com/'

/** what the Workbench's GitHub button draws itself from. Null (rather than an
 *  instance of this) means "no button at all": not a repository, no usable remote, or a
 *  remote that is not on github.com. */
export interface GithubInfo {
  /** https://github.com/<owner>/<repo> */
  repoUrl: string
  /** https://github.com/<owner>/<repo>/pulls */
  pullsUrl: string
  /** HEAD's short branch name; null on a detached HEAD */
  branch: string | null
  /** this branch's pull request. Null covers all of "none", "not looked up yet" and
   *  "the lookup failed" — the button looks the same for each (B9). */
  pr: number | null
  /** the pull-request lookup is still running; a `github:info` push follows with the
   *  answer */
  pending: boolean
  /** the last lookup could not reach the remote. Only "Check again" reads it, to tell
   *  "no pull request" apart from "no network" (B10). */
  failed: boolean
}

/** Which page the button opens. `pr` falls back to the repository home when the branch
 *  turns out to have no pull request, so a click is never dead. */
export type GithubTarget = 'repo' | 'pulls' | 'pr'

/** One installed Chrome extension, as the Settings list and the action row read it
 *  (browser-extensions D2/D3). Disabled ones stay listed — Electron has no disabled
 *  state, so Koloft is the only thing that still knows they are installed. */
export interface ExtensionInfo {
  id: string
  name: string
  version: string
  enabled: boolean
}

/** Where an action popup hangs (D5, §03 fig. 2): the clicked icon horizontally, the
 *  address bar's lower edge vertically, in the host window's own coordinates. */
export interface ExtensionPopupAnchor {
  x: number
  y: number
  width: number
  height: number
}

/** Something an extension needs the user's word on, on its way to Koloft's own modal
 *  (D7 — never a native dialog). Whatever asked is stopped inside its call until the
 *  answer travels back. */
export interface ExtensionPermissionRequest {
  /** a running extension's `chrome.permissions.request`, or the §04 fig. 4 confirmation
   *  standing between the Web Store page and an install that has not happened yet */
  kind: 'permission' | 'install'
  id: string
  /** the extension's own name, as the manifest spells it */
  name: string
  /** install only: the version the store is offering */
  version?: string
  permissions: string[]
  origins: string[]
}

/** A file the Browser took delivery of instead of handing the response to the OS
 *  (§05D-2). `path` is where it actually landed — the suggested name is sanitized and
 *  uniquified before the write (SEC-9), so it is not what the site asked for. */
export interface BrowserDownload {
  name: string
  path: string
}

/** §03 B7: a page is asking for something the user has to answer for. The page's own
 *  call is stopped inside main until the answer travels back. `origin` is main's word,
 *  read off the request Chromium made — never the page's claim about itself. */
export interface BrowserPermissionAsk {
  id: string
  origin: string
  permission: string
}

/** §03 B7 fig. 2: a permission Koloft's browser does not support, refused OUT LOUD. The
 *  silence this replaces is what sent people to Safari. */
export interface BrowserPermissionRefusal {
  origin: string
  permission: string
}

/** §04 B9: one step in a download's life, on its way to the list. Every stage is
 *  reported, not just the successful end — a silent failure reads as a dead click. */
export type BrowserDownloadEvent =
  | { id: string; kind: 'started'; name: string; total: number }
  | { id: string; kind: 'progress'; received: number }
  | { id: string; kind: 'retrying' }
  | { id: string; kind: 'done'; state: 'completed' | 'cancelled' | 'interrupted'; path?: string }

/** §07 #4: a guest started or stopped making noise, so the strip can show it. */
export interface BrowserAudioState {
  guestId: number
  audible: boolean
  muted: boolean
}

/** An HTTP basic-auth challenge main handed to the app's own modal (§05D-5/SEC-10).
 *  Only a main-frame challenge ever becomes one of these, the origin and realm are
 *  Koloft's words rather than the page's, and nothing about the answer is remembered. */
export interface BrowserAuthChallenge {
  id: string
  kind: 'auth'
  origin: string
  realm: string
}

/** A guest's window.alert/confirm/prompt, handed to the same modal (§05D-11). The kind
 *  and the text are what main made of the request, and `origin` is the frame that asked
 *  as main read it — a page cannot sign its message as another site. */
export interface BrowserJsDialog {
  id: string
  kind: 'alert' | 'confirm' | 'prompt'
  origin: string
  message: string
  defaultValue: string
  /** the guest that asked. R1: a page in the global overlay is not on any session's
   *  strip, so its dialog has to be drawn on the overlay itself — the pane the modal
   *  lives in today may not even be mounted. */
  guestId: number
  /** …which is what this says: the asking guest is an overlay's, not a strip tab's */
  overlay: boolean
}

/** §4.1b — one Browser tab as MAIN needs to see it. The renderer owns the strip;
 *  main has never had a tab identity of its own, and the CDP relay needs one (targetId
 *  ↔ tab ↔ webContents), so the renderer reports it. */
export interface BrowserStripTarget {
  /** the strip's own tab id, used verbatim as the CDP targetId */
  targetId: string
  url: string
  title: string
  /** null while the tab has never been loaded (D4: listed, not loaded) */
  guestId: number | null
}

/** what main asks the strip to do on a CDP client's behalf. */
export interface BrowserCdpOp {
  opId: string
  /** mount: give the tab a live guest · create: a CDP-source tab · close: close it ·
   *  stage: put it where it has pixels to capture (S1) */
  kind: 'mount' | 'create' | 'close' | 'stage'
  sessionId: string
  targetId?: string
  url?: string
}

export interface BrowserCdpOpResult {
  opId: string
  ok: boolean
  targetId?: string
  guestId?: number
  error?: string
}

/** D5/§4.3 — the tabs a client is driving right now: the strip pins them against
 *  both caps and shows the "an agent is driving this" mark on them. */
export interface BrowserCdpAttached {
  sessionId: string
  targetIds: string[]
}

/** R1 — an app-level page with no session to land in: an `open` no strip could take,
 *  the releases page. `presentation` is the §02 split: `now` when the user just asked
 *  for it themselves, `background` when they did not. */
export interface BrowserOverlayOpen {
  url: string
  presentation: 'now' | 'background'
}

/** What the user did with a challenge or a dialog. `ok: false` (or a missing username)
 *  cancels it: the page gets its 401 back, `false` from confirm, `null` from prompt. */
export interface BrowserDialogAnswer {
  ok: boolean
  /** prompt */
  value?: string
  username?: string
  password?: string
}

/** The Browser's menu commands (D9). Each one is arbitrated by the renderer against
 *  the active aux surface — ⌘R inside a guest reloads that guest, not Koloft (IMPL-4/5) —
 *  so they travel as one channel rather than as thirteen. */
export type BrowserCommand =
  | 'toggle-browser'
  | 'browser-new-tab'
  | 'browser-close-tab'
  | 'browser-focus-address'
  | 'browser-back'
  | 'browser-forward'
  | 'browser-reload'
  | 'browser-zoom-in'
  | 'browser-zoom-out'
  | 'browser-zoom-reset'
  | 'browser-devtools'
  | 'toggle-focus-mode'

/** Q2's other branch: what a View command means when the Browser is NOT the active
 *  surface — the whole-window behaviour its Electron role used to have. The renderer
 *  arbitrates (only it knows the active surface) and hands these back to main, which
 *  owns the host window. There is deliberately no reload member: ⌘R must never reload
 *  the Koloft renderer, which would destroy every live terminal (see menu.ts). */
/** FR-53 — the panel-scoped keys main fishes out of a focused guest that are NOT
 *  `BrowserCommand`s. They ride their own channel because `commandTarget` arbitrates a
 *  BrowserCommand against "is the active tab `web`", and cycling tabs is not a question
 *  about the guest at all — it is a question about the strip above it. */
export type WorkbenchShortcut = 'cycle-next' | 'cycle-prev'

export type WindowCommand =
  'window-devtools' | 'window-zoom-in' | 'window-zoom-out' | 'window-zoom-reset'

export interface TerminalData {
  id: string
  data: string
}

export interface TerminalExit {
  id: string
  exitCode: number
  signal?: number
}

/** A utility shell's foreground process changed (D11 tab label). Utility ptys only —
 *  main polls no others. */
export interface TerminalProcessTitle {
  id: string
  name: string
}

/** A utility shell `cd`ed somewhere (D13): its OSC 7 report, parsed in main. Drives the
 *  terminal tab's kind-bar directory (R19). Nothing is respawned from it: a shell
 *  is never written down (D4). */
export interface TerminalCwd {
  id: string
  cwd: string
}

/** The API surface exposed on `window.api` by the preload script. */
export interface KoloftApi {
  /** true when running the unpackaged dev build (npm run dev), false when packaged */
  isDev: boolean
  /** test-only seam (KOLOFT_DOM_RENDERER=1): skip the WebGL addon so terminal text stays
   *  real DOM nodes the e2e suite can assert on. Terminals always render WebGL
   *  otherwise — there is no user-facing renderer choice. */
  domRenderer: boolean
  /** test-only seam (KOLOFT_TEST_BACKGROUND=1): the e2e harness is driving this run, so
   *  the renderer may expose observation hooks that are not product surfaces —
   *  today `window.__koloftTerms`, the live xterm instance behind each pty id. */
  testMode: boolean
  /** the user's home directory (for the "~" group label and the empty-state new tab) */
  home: string
  /** file-edit B-26 — the quit handshake. `before-quit` in main cannot wait for an
   *  answer, so it blocks the quit, asks here, and quits again once one of the two
   *  replies arrives. Exactly one of them must be sent per request, promptly: main
   *  gives up waiting after a few seconds and quits anyway. */
  app: {
    /** main is trying to quit. Answer with `approveQuit` or `holdQuit`. */
    onQuitRequested(cb: () => void): () => void
    /** nothing is at risk (or the user said go ahead) — let the quit through */
    approveQuit(): void
    /** the question is now in front of the user, so stop main's patience timer */
    holdQuit(): void
    /** the user said no. Not optional and not the same as silence: quitting is sometimes
     *  the last step of an update install or a restart, and main has to unwind those
     *  rather than leave them armed for whenever the app next closes. */
    declineQuit(): void
  }
  terminal: {
    create(opts: CreateTabOptions): Promise<CreateTabResult>
    write(id: string, data: string): void
    /** report xterm-consumed output units for flow control (see main/flowControl.ts) */
    ack(id: string, units: number): void
    /** this tab's TerminalView now consumes+acks terminal:data — start flow accounting */
    attach(id: string): void
    /** live per-tab flow-control counters (diagnostics; e2e asserts the ack loop) */
    flowStats(): Promise<FlowStats[]>
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(cb: (d: TerminalData) => void): () => void
    onExit(cb: (e: TerminalExit) => void): () => void
    /** a utility shell's foreground process changed — the tab label follows it (D11) */
    onProcessTitle(cb: (t: TerminalProcessTitle) => void): () => void
    /** a utility shell moved (OSC 7) — the terminal tab's kind-bar directory (R19).
     *  Label only; nothing about a shell reaches disk both follow it */
    onCwd(cb: (c: TerminalCwd) => void): () => void
    /** main opened a tab on its own (a scheduled job's run) — the renderer
     *  adds it WITHOUT activating it and without touching focus */
    onSpawned(cb: (t: SpawnedTab) => void): () => void
  }
  /** Per-session Workbench state (layout v3 `sessions[id]`). Replaces the three `aux.*`
   *  channels the merge retired: `aux.setMode` + `aux.setBrowser` fold into one
   *  `setState`, since `open` and the tab set are now one document. Writes are debounced
   *  in main; reads are authoritative (a session with no entry answers with the global
   *  default). */
  workbench: {
    get(sessionId: string): Promise<SessionWorkbenchState>
    /** the whole panel state, submitted on every structural change (open/close/
     *  navigate/retitle/reorder, and the T1↔T2 toggle) — main validates and owns the
     *  write. Runtime-only state (activeId, unread, recency, T3) never travels here. */
    setState(sessionId: string, state: SessionWorkbenchState): void
    /** FR-04/05 + R5: whether a session is SELECTED (`available`) and whether that
     *  session can host a SHELL (`terminal` — bound and still alive, one state stricter).
     *  Both are facts only the renderer holds, and their consumers are the Focus Mode and
     *  New Terminal Tab menu items' enabled flags: a native accelerator cannot gate itself
     *  on renderer state. One call, so the two items cannot drift apart. */
    setAvailable(available: boolean, terminal: boolean): void
    /** file-edit B-12: false while an editor is on screen, which greys the Find menu
     *  item. Find highlights rendered text and does nothing to a textarea, so a live
     *  ⌘F there could only ever report zero matches — that reads as broken, not as
     *  absent. Same shape and same reason as `setAvailable`: a renderer-only fact whose
     *  only consumer is a native menu item. */
    setFindAvailable(available: boolean): void
    /** file-edit B-15/B-16: whether anything is unsaved, which gates the Save menu item.
     *  Greying it also stops ⌘S, which is B-15's "nothing changed, do nothing" answered
     *  before the keystroke rather than after it. */
    setSaveAvailable(available: boolean): void
    /** the conversation tabs holding unsaved edits — only the renderer knows. */
    setDirtyTabs(ids: string[]): void
  }
  /** main-owned tab inventory — what a fresh renderer re-adopts on boot
   *  instead of landing cold while live ptys run on unreachable. */
  tabs: {
    list(): Promise<TabInventoryReply>
    /** main killed this tab's pty on purpose (a scheduled run that never bound, an idle
     *  session closed by itself): the renderer drops the tab. */
    onKilledByMain(cb: (tabId: string) => void): () => void
  }
  sessions: {
    /** what each session method can do right now; main answers from its cached probe.
     *  `verified` is false for a Codex newer than the version Koloft was tested with. */
    backends(): Promise<
      {
        id: BackendId
        available: boolean
        reason?: string
        version?: string
        verified?: boolean
      }[]
    >
    onUpdate(cb: (sessions: SessionInfo[]) => void): () => void
    /** claude moved this session into another git checkout (EnterWorktree /
     *  ExitWorktree) and the Workbench followed it there. `dir` is where it landed.
     *  Fires once per burst of moves, after they settle. */
    onRelocated(cb: (e: { tabId: string; dir: string }) => void): () => void
    /** the user just typed into this session's terminal, so its auto-close
     *  clock starts over. Only real keystrokes, never xterm's own answers. */
    noteActivity(tabId: string): void
    list(): Promise<SessionInfo[]>
    /** the lifecycle contract §4: the decision-tree verdict + evidence for resuming one
     *  session. The renderer renders the plan (silent resume / rebuild offer /
     *  two-choice dialog) and executes it via resume() with the matching mode. */
    resumePlan(sessionId: string): Promise<ResumePlan>
    /** decision-tree executor (the lifecycle contract): spawns `claude --resume` per
     *  req.mode — see SessionResumeRequest. Plain cold-row resumes stay mode-less. */
    resume(req: SessionResumeRequest): Promise<SessionResumeResult>
    /** cold-row menu "Remove from list" (the lifecycle contract D4; channel name kept): drop
     *  the session's ownership entry so it leaves the sidebar. The jsonl is
     *  untouched — Restore from history brings it back. False for a live session. */
    archive(id: string): Promise<boolean>
    /** F7: end a session whose tab this renderer lost (a reload drops every tab while
     *  main keeps the ptys). Main re-resolves the live binding itself and kills that
     *  pty; ok:false means nothing was bound here, so nothing was killed. */
    forceClose(id: string): Promise<{ ok: boolean }>
    /** is this session's conversation on disk RIGHT NOW? ⇧⌘R kills before it
     *  respawns, and Claude Code writes the transcript only at the first user message —
     *  so a bound session may have nothing to resume. False also covers an unknown id
     *  and an invalid one; the probe never rejects for those. */
    transcriptExists(sessionId: string): Promise<boolean>
  }
  attention: {
    /** the pending "needs you" set. Nothing in the UI renders it — the sidebar's status
     *  dot covers the in-app case, and the set's own outlets are OS-level (notification,
     *  Dock badge). It stays queryable because that makes the attention pipeline
     *  observable to an e2e run, where D8 bars every OS-level outlet. */
    list(): Promise<AttentionEvent[]>
    /** passive active-tab report (fires on any activeTabId change, including
     *  programmatic promotion) — main clears the tab's marker only when the
     *  window is focused, i.e. the user is actually looking */
    activeTab(id: string | null): void
    /** an explicit user visit (sidebar click) — always consumes the marker */
    visit(id: string): void
    /** an OS-notification click asked to jump to a tab — main has already surfaced
     *  the window; the renderer activates the tab */
    onActivateTab(cb: (tabId: string) => void): () => void
  }
  preview: {
    readText(path: string): Promise<string>
    openFileDialog(): Promise<string | null>
    /** open a path via the OS default app — the renderer's last-resort fallback for an
     *  intercepted `open` it can't surface in-app (no tab to attach the preview to) */
    osOpen(path: string): void
    /** build a koloft-file:// url that the custom protocol can serve to <webview>/<img> */
    fileUrl(path: string): string
    /** `open <file>` calls intercepted by the PATH shim (previewable types only) —
     *  rendered in the panel instead of by the OS default app. FILES ONLY: web urls take
     *  `browser.onOpenRequest`. `source` forks the landing — agent: no tab, no Recents
     *  entry, no signal (FR-14); user: activate `files`, render, enter Recents, expand a
     *  collapsed panel to T2 (FR-57). */
    onOpenRequest(cb: (r: OpenRequest) => void): () => void
  }
  /** D4: how many Browser guests may be LIVE at once across all sessions; the overflow
   *  is frozen, never closed. Injectable (KOLOFT_BROWSER_GUEST_LIMIT) so a cap case needs
   *  three tabs instead of a dozen renderer processes. */
  browserGuestLimit: number
  /** test seam: a smaller per-session tab cap, or 0 for the product's own
   *  (SESSION_TAB_CAP). What the cap cases need is the behaviour at the limit. */
  browserTabCap: number
  /** The Browser surface's main-process plumbing (session-browser D3/D4/§05D-2). */
  browser: {
    /** main's router (D3) sent a target here — `source` decides whether it loads in
     *  the foreground or only registers an unread tab (D10/B5) */
    onOpenRequest(cb: (r: BrowserOpenRequest) => void): () => void
    /** a guest's download finished writing into the download dir */
    onDownload(cb: (d: BrowserDownload) => void): () => void
    /** B9: every stage of a download's life, for the list */
    onDownloadEvent(cb: (e: BrowserDownloadEvent) => void): () => void
    /** B9: stop one that is still writing */
    cancelDownload(id: string): void
    /** B9: ask for a failed one again */
    retryDownload(id: string): void
    /** B7: a page is asking for a permission — raise the prompt bar */
    onPermissionAsk(cb: (a: BrowserPermissionAsk) => void): () => void
    /** B7: a permission was refused outright; the user is owed the notice */
    onPermissionRefused(cb: (r: BrowserPermissionRefusal) => void): () => void
    /** B7: a pending prompt's page is gone — take the bar down (BB-C45) */
    onPermissionDrop(cb: (id: string) => void): () => void
    /** B7/B8: the user's word on one prompt */
    answerPermission(id: string, granted: boolean): void
    /** the surface took a bar down WITHOUT an answer (a session switch). The page is
     *  still stopped inside its own call, so main has to release it. */
    cancelPermission(id: string): void
    /** §07 #4: a guest's audio started or stopped */
    onAudioState(cb: (s: BrowserAudioState) => void): () => void
    /** §07 #4: mute or unmute one guest */
    setMuted(guestId: number, muted: boolean): void
    /** B12: "Copy current URL" — main owns the clipboard write, as it does for the guest
     *  context menu's copy-link (the renderer has no clipboard access of its own) */
    copyText(text: string): void
    /** §07 #3: a page entered or left fullscreen — the pane fills the center row */
    onFullscreen(cb: (on: boolean) => void): () => void
    /** a guest tried to leave for a scheme the OS hand-off whitelist refuses (SEC-4);
     *  it was dropped, and the user is owed the notice (BB-C19/BB-C20) */
    onBlockedScheme(cb: (url: string) => void): () => void
    /** a main-frame basic-auth challenge to render in the app's own modal (SEC-10) */
    onAuthChallenge(cb: (c: BrowserAuthChallenge) => void): () => void
    /** the user's answer to one; a cancel returns the 401 to the page */
    answerAuthChallenge(id: string, answer: BrowserDialogAnswer): void
    /** a guest's alert/confirm/prompt, for the same modal (§05D-11). The page is
     *  stopped inside the call until the answer goes back. */
    onJsDialog(cb: (d: BrowserJsDialog) => void): () => void
    /** the user's answer to one; it IS the value the page's call returns */
    answerJsDialog(id: string, answer: BrowserDialogAnswer): void
    /** R1 — main routed an app-level page to the global overlay (an `open` no session
     *  could take, the releases page) */
    onOverlayOpen(cb: (o: BrowserOverlayOpen) => void): () => void
    /** R1: said once the listener above is attached. Until then main holds pages back —
     *  a send to a renderer that is still mounting is a silent no-op (D8). */
    overlayReady(): void
    /** R1 — this webContents is (or has stopped being) an overlay's guest. Main needs
     *  the identity to keep an overlay page out of the session strips: its popups
     *  navigate in place, its dialogs are drawn on the overlay, and its permission
     *  asks are refused outright (§02 behaviour table). */
    setOverlayGuest(guestId: number, on: boolean): void
    /** §4.1b — the strip as it stands now, pushed on every change. Main has no tab
     *  identity of its own, and the CDP relay is built on this report. */
    reportStrip(sessionId: string, targets: BrowserStripTarget[]): void
    /** main asking the strip to mount / create / close / stage a tab for a client */
    onCdpOp(cb: (op: BrowserCdpOp) => void): () => void
    answerCdpOp(res: BrowserCdpOpResult): void
    /** D5 — which tabs are being driven (pin + the indicator) */
    onCdpAttached(cb: (a: BrowserCdpAttached) => void): () => void
    /** the user walked past a certificate interstitial: trust this url's host for the
     *  rest of THIS process (SEC-8 — never persisted). Resolves before the reload, so
     *  the retry is verified against the exception. */
    certProceed(url: string): Promise<void>
    /** SEC-11/D11 — Settings' "Clear browsing data": everything the browser partition kept
     *  (cookies, service workers, cache, IndexedDB, HTTP auth) plus this process's
     *  certificate exceptions. Resolves once the partition is empty. */
    clearData(): Promise<void>
    /** D15's ↗ escape hatch: hand this url to the system browser. The only way out of
     *  Koloft, and it takes http/https/mailto/tel alone (SEC-4) — never a `file:` target a
     *  page talked the user into clicking. */
    openExternal(url: string): void
    /** D13 — the user's own devtools, on the guest behind the active tab and on nothing
     *  else. Main opens it detached and unfocused (R7), and refuses any id that is not a
     *  live browser guest (SEC-15). */
    toggleDevTools(guestId: number): void
  }
  /** The Chrome-extension platform, as Koloft's own chrome talks to it (browser-extensions
   *  D3–D7). The action row itself reads `window.browserAction`, the bridge the upstream
   *  library injects; everything here is Koloft's own half. */
  extensions: {
    list(): Promise<ExtensionInfo[]>
    setEnabled(id: string, enabled: boolean): Promise<void>
    /** §04 fig. 3: take the extension out of the registry, files and all. Confirmed in the
     *  renderer first — main does not ask a second time. */
    uninstall(id: string): Promise<void>
    /** the installed set or one extension's on/off state changed */
    onChanged(cb: () => void): () => void
    /** D4: which guest backs the current session's active Browser tab — 0 when the
     *  strip has none. Also how a `chrome.tabs.create` tab reports itself back (D6),
     *  which is why the tab's url travels with it: it is what tells one pending
     *  `tabs.create` from another. */
    activeGuest(webContentsId: number, url: string): void
    /** D6: the strip could not take an open at all — no session owns the tab the
     *  request was addressed to. Whoever is waiting for that url is owed the news. */
    openDropped(url: string): void
    /** D5: where the popup of the action about to be activated hangs. Awaited before
     *  the activation itself, so the floater is under its icon from the first frame —
     *  upstream only places it once the extension's page reports a size. */
    anchorPopup(rect: ExtensionPopupAnchor): Promise<void>
    /** D5: close the action popup — a click outside it, or Esc */
    dismissPopup(): void
    /** D7: a running extension is asking for a permission */
    onPermissionRequest(cb: (r: ExtensionPermissionRequest) => void): () => void
    answerPermissionRequest(id: string, granted: boolean): void
  }
  fs: {
    /** list immediate children of a directory: heavy/build dirs hidden, .gitignore
     *  respected (git repos), dirs-first alphabetical. Dotfiles are kept. */
    listDir(path: string, opts?: { showIgnored?: boolean }): Promise<DirEntry[]>
    /** §6 — is this still a directory on disk? `listDir` cannot answer: it returns `[]`
     *  for missing, unreadable and empty alike, and Browse relies on that conflation for
     *  FR-46. Only the Files tab's "the worktree was removed under us" placeholder needs
     *  the distinction, so it asks separately. */
    dirExists(path: string): Promise<boolean>
    /** recursively search files under `path` whose relative path contains `query`
     *  (case-insensitive). Visibility matches `listDir` (heavy dirs + gitignored
     *  excluded); basename matches rank above path-only matches. `truncated` is set
     *  when more than the cap matched. Empty/whitespace query returns no hits. */
    search(
      path: string,
      query: string,
      opts?: { showIgnored?: boolean }
    ): Promise<{ hits: SearchHit[]; truncated: boolean }>
    /** The commit Changes measures against (FR-39): the resolved merge-base of HEAD and
     *  the default branch — `'HEAD'` when there is no default branch OR no common
     *  ancestor (unrelated histories), `null` for a fresh repo whose HEAD doesn't
     *  resolve. Exposes the module-private `diffBase()` as a read-only channel so ONE
     *  refresh resolves the base once and hands the sha to every consumer below
     *  (NFR-02); pass the literal `'HEAD'` instead for FR-39's vs-HEAD switch. */
    diffBase(root: string): Promise<string | null>
    /** Per-file change status for the repo containing `root`, keyed by absolute path.
     *  The change set is everything differing from `base` — which defaults to the
     *  merge-base with the default branch, NOT to HEAD, so work already committed on a
     *  feature branch stays listed — plus untracked files. Pass `base` (a sha, or the
     *  literal 'HEAD') to skip the internal resolution. Empty object when `root` isn't a
     *  git repo / git is missing. */
    gitStatus(root: string, base?: string): Promise<GitStatusMap>
    /** Net line delta per changed TRACKED file vs the same base as `gitStatus`
     *  (`git diff <base> --numstat`), keyed by absolute path. Powers the ±N badge.
     *  Untracked and binary files are absent by construction — FR-43's "status letter
     *  but no ±N" is this omission, not a rendering choice. Empty object when `root`
     *  isn't a git repo / has no HEAD / git is missing. */
    gitNumstat(root: string, base?: string): Promise<GitNumstatMap>
    /** start (idempotent, ref-counted) a recursive watch of `root`; changes arrive via
     *  `onDirChange`. Pair every call with `unwatchDir` when the root is no longer shown.
     *  Resolves false when the watch could not start (network mount, EMFILE): no change
     *  will ever arrive for that root, so the caller must refresh some other way. */
    watchDir(root: string): Promise<boolean>
    unwatchDir(root: string): void
    /** subscribe to debounced "something under this root changed" notifications */
    onDirChange(cb: (root: string) => void): () => void
    /** start (idempotent, ref-counted) a stat-poll watch of one file — powers the preview
     *  pane's auto-refresh; changes arrive via `onFileChange`. Follows the path (not the
     *  inode), so atomic rename-replace writes keep firing. Pair with `unwatchFile`. */
    watchFile(path: string): void
    unwatchFile(path: string): void
    /** subscribe to "this watched file changed on disk" notifications (~500ms poll).
     *  `fp` is what the poll just read, so an editor holding unsaved changes can tell a
     *  stranger's write from the echo of its own save. It is an EARLY WARNING only —
     *  the poll merges two changes inside one 500ms window into one event, and misses a
     *  change that is undone within it. The fingerprint check inside `edit.write` is the
     *  only reliable gate; nothing may be built on this event instead. */
    onFileChange(cb: (path: string, fp?: EditFingerprint) => void): () => void
    /** reveal a file/dir in the OS file manager (Finder) */
    reveal(path: string): void
    /** Aggregate unified diff for the repo containing `root`, measured against the same
     *  base as `gitStatus` (merge-base by default, NOT HEAD); `notRepo` says when `root`
     *  is in no repo at all (`text` is '' then, but so is a fresh repo's).
     *  Powers the Changes stream.
     *
     *  `truncated` is the whole reason for the object return: git's stdout is capped by
     *  `maxBuffer`, and an overflow used to hand back the partial diff SILENTLY — a
     *  half-diff presented as the complete change set. The flag makes the renderer show
     *  §Edge's "change set too large" banner instead (WB-C11).
     *
     *  `toplevel` is what the diff's paths are relative to: git prints them from the repo
     *  toplevel even when `root` is a subdir of it, so join onto `toplevel`, never `root`
     *. null when not a repo. */
    gitDiff(
      root: string,
      base?: string
    ): Promise<{ text: string; truncated: boolean; notRepo: boolean; toplevel: string | null }>
    /** Unified diff for a single file vs the same base as `gitDiff` (untracked files show
     *  whole-file additions); `text` is '' when unchanged / not in a repo. Compact — git's
     *  default 3 lines of context. Same `truncated` contract as `gitDiff`.
     *
     *  Pass `untracked: true` for a path the caller's OWN `gitStatus` map lists as
     *  `untracked`: main then skips the tracked-diff and tracked/ignored probes and goes
     *  straight to the whole-file diff (5 spawns → at most 2, which is what keeps a
     *  60-untracked-file tick inside the watcher debounce). Only the literal `true`
     *  counts; anything else is the full probe path. Never pass it for a path the map
     *  does not list — an ignored file asked for this way is shown, not suppressed. */
    gitFileDiff(
      path: string,
      base?: string,
      untracked?: boolean
    ): Promise<{ text: string; truncated: boolean }>
    /** Same as `gitFileDiff` but full-context: the whole file as one hunk (every unchanged
     *  line present as context). Powers FR-38's per-file ⤢ expand-context. It takes `base`
     *  for the same reason the others do — expanding a block while Changes sits on
     *  `vs HEAD` must widen THAT diff, not silently re-derive the merge-base — and
     *  `untracked` under the same contract as `gitFileDiff`'s. */
    gitFileDiffFull(
      path: string,
      base?: string,
      untracked?: boolean
    ): Promise<{ text: string; truncated: boolean }>
    /** ripgrep content search under `root` (git grep fallback); visibility follows the
     *  file tree's "Show ignored files" switch, like `search`. `truncated` when capped. */
    searchContent(
      root: string,
      query: string,
      opts?: { showIgnored?: boolean }
    ): Promise<{ hits: ContentHit[]; truncated: boolean }>
  }
  /** §05: the file editor's three channels — the only ones in Koloft that write a user's
   *  file. All three reject with a `KOLOFT_*` message string: `KOLOFT_NOT_FILE`
   *  `KOLOFT_TOO_LARGE` `KOLOFT_BINARY` `KOLOFT_READ_FAILED` `KOLOFT_NO_PERM` `KOLOFT_GONE`
   *  `KOLOFT_DIR_GONE` (the containing folder went, not just the file — it may not be
   *  silently re-created) `KOLOFT_WRITE_FAILED` `KOLOFT_EXISTS` `KOLOFT_BAD_NAME`. The message is
   *  all there is — Electron's IPC drops `err.code`. */
  edit: {
    /** read a file for editing: text + fingerprint, or a `readOnly` reason why it may be
     *  shown but not changed. Files over 512 KB are refused outright (KOLOFT_TOO_LARGE). */
    open(path: string): Promise<EditOpenResult>
    /** Save, atomically, only if the file still matches `expect` — otherwise nothing is
     *  written and the answer carries what is on disk now. `text` always uses LF; pass
     *  `eol: 'crlf'` to put the file's own line endings back. `force: true` is the one
     *  and only way to overwrite a changed file: a missing or malformed `expect` is
     *  treated as a conflict, never as permission. Saving is capped at 1 MB. */
    write(
      path: string,
      text: string,
      expect: EditFingerprint,
      opts?: { force?: boolean; eol?: 'lf' | 'crlf' }
    ): Promise<EditWriteResult>
    /** create an empty file, failing if the name is taken (the creation itself is the
     *  check — nothing is looked up first). `name` is a bare file name: a `/` or `..` in
     *  it is KOLOFT_BAD_NAME — this channel never writes outside the folder it was given. */
    create(dirPath: string, name: string): Promise<EditCreateResult>
  }
  /** the one plain-text note each workspace gets. It is a normal file kept in
   *  Koloft's own user-data folder (never inside the workspace), and the Workbench edit
   *  pane reads and writes it through `edit.open` / `edit.write` like any other file. */
  notes: {
    /** the note file for this workspace, made (empty) if it is not there yet. Null when
     *  `ws` is not the path of a pinned workspace — nothing is created in that case. */
    path(ws: string): Promise<string | null>
  }
  /** the Workbench's GitHub button. */
  github: {
    /** what the button shows for this session directory; null draws no button. Answers
     *  from the local repository at once and reports `pending` while the pull-request
     *  lookup runs — `onInfo` carries the number when it lands. `force` is "Check again",
     *  the one thing that ignores the five-minute cache. */
    info(root: string, force?: boolean): Promise<GithubInfo | null>
    /** where a click goes, decided now: already wrapped into GitHub's login page when the
     *  built-in browser has no GitHub session (D1) */
    target(root: string, what: GithubTarget): Promise<string | null>
    /** a pull-request lookup finished for `root` */
    onInfo(cb: (root: string, info: GithubInfo) => void): () => void
  }
  workspace: {
    /** native directory picker for Add Workspace (C1 ⊞ / ⇧⌘O); null on cancel */
    pickFolder(): Promise<string | null>
    /** pin a workspace (A1: subdirs normalize to the repo root, linked worktrees are
     *  refused, re-adding is idempotent; new pins append to the sidebar order) */
    add(path: string): Promise<WorkspaceAddResult>
    /** two-step unpin: reports the running-session count; removes immediately only
     *  when that count is 0 (the UI confirms otherwise, then calls removeConfirmed) */
    remove(path: string): Promise<WorkspaceRemoveResult>
    /** confirmed unpin: gracefully closes the workspace's running claude ptys first */
    removeConfirmed(path: string): Promise<void>
    /** the C8 dialog's worktree list: the workspace's linked worktrees, main checkout excluded
     *  and stale (deleted-but-still-listed) checkouts filtered out (§5) */
    worktrees(path: string): Promise<WorktreeInfo[]>
    /** the lifecycle contract D5 "Restore from history": the workspace's jsonl-backed sessions
     *  that are NOT list members (allRows − owned − running), mtime-desc. Computed
     *  main-side from the retained unfiltered aggregation. */
    historyRows(path: string): Promise<SessionRow[]>
    /** current aggregated sidebar state (same payload the `onRows` push carries) */
    rows(): Promise<WorkspaceRows[]>
    /** pushed after every rescan (workspace add/remove, session start/end, watcher) */
    onRows(cb: (rows: WorkspaceRows[]) => void): () => void
    /** manual fetch (popover ⟳ / menu Fetch origin / C8 opening): ignores the 60s
     *  throttle and the error backoff, joins an in-flight fetch instead of spawning a
     *  second git. The result is also pushed on `workspace:rows`. null = unknown. */
    fetchFreshness(path: string): Promise<WorkspaceFreshness | null>
    /** ff-only pull of the default branch. `expect` is the state the renderer judged
     *  on (branch + HEAD sha); main re-checks it right before exec and refuses with
     *  reason 'state changed' if the checkout moved (§05 pull, TOCTOU). */
    pull(path: string, expect: { branch: string; head: string }): Promise<WorkspacePullResult>
    /** folders Claude Code has history in that are not pinned yet, newest first —
     *  what the welcome's step 2 offers to pin. At most 8. */
    discover(): Promise<DiscoveredFolder[]>
  }
  /** facts about the `claude` binary itself, asked straight of the login shell. */
  claude: {
    /** is a `claude` command on the login shell's PATH */
    probe(): Promise<{ found: boolean }>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    onUpdate(cb: (s: Settings) => void): () => void
  }
  accounts: {
    /** metadata + latest usage snapshots — never any secret */
    list(): Promise<AccountView[]>
    /** the single renderer→main token transit (write-only; the secret is stored in
     *  the Keychain and never echoed back in any form). `endpoint` is required for
     *  kind 'custom' and ignored otherwise. */
    add(
      name: string,
      kind: AccountKind,
      secret: string,
      endpoint?: { baseUrl: string; model?: string }
    ): Promise<AccountAddResult>
    remove(name: string, kind: AccountKind): Promise<void>
    toggle(name: string, kind: AccountKind, enabled: boolean): Promise<void>
    /** probe all enabled accounts now (settings-panel refresh path, 10s budget) */
    probe(): Promise<AccountView[]>
    /** Run the official `claude setup-token` in a HIDDEN pty and, when it prints a
     *  token, store it under `name` and add the account — D9's primary entry. The
     *  user stays in the settings panel; everything they need arrives via
     *  `onLoginProgress`. Resolves once the flow is running, or why it refused. */
    startLogin(
      name: string,
      /** re-authenticate an account that already exists (the expired row's recovery
       *  path) — skips the duplicate guard and keeps the row's position + enabled */
      reauth?: boolean
    ): Promise<'ok' | 'invalid-name' | 'duplicate' | 'unknown'>
    /** abandon a running guided login and kill its hidden pty */
    cancelLogin(): void
    onLoginProgress(cb: (p: LoginProgress) => void): () => void
    /** pushed whenever account metadata or usage snapshots change */
    onUpdate(cb: (accounts: AccountView[]) => void): () => void
  }
  /** self-update against the public releases repo (manual, menu-triggered). The app
   *  is unsigned, so this is a DIY download→swap→relaunch, not Squirrel.Mac. */
  update: {
    /** the version installed on disk (app.getVersion(); read-only, no network) */
    version(): Promise<string>
    /** query the latest release and compare to the version installed on disk */
    check(): Promise<UpdateCheckResult>
    /** download the newest dmg and install it over the running app, then relaunch.
     *  Resolves only when the install did NOT proceed (on success the process exits):
     *  with a 'restart-required' result when the staged version is already on disk, else
     *  undefined. Rejects with a human-readable message the modal surfaces. */
    download(): Promise<UpdateCheckResult | undefined>
    /** relaunch into the bundle on disk (the 'restart-required' result: the update is
     *  already installed, only this process is stale) */
    restart(): void
    /** open the latest release's GitHub page in the system browser (the cached URL from
     *  the last check; no renderer-supplied URL is opened) */
    openRelease(): void
    /** subscribe to download() byte-progress while `download` runs */
    onProgress(cb: (p: UpdateProgress) => void): () => void
    /** the release notes this launch has not shown yet — the span between the
     *  version last read and the running one. null when there is nothing to say, which
     *  main decides (and remembers) on its own. */
    whatsNew(): Promise<WhatsNew | null>
    /** the background check's latest verdict, for the sidebar banner: null when there is
     *  nothing to install (or no check has run yet). Pull once on mount, then subscribe. */
    offer(): Promise<UpdateCheckResult | null>
    onOffer(cb: (offer: UpdateCheckResult | null) => void): () => void
  }
  /** the main window's own focus, as the OS sees it (D5). The renderer cannot
   *  ask this itself: while a guest `<webview>` holds the caret the host document reports
   *  `hasFocus() === false` even though the window is frontmost, and `window` blur/focus
   *  fire for that hand-over too — so only main's `BrowserWindow` events can tell "the
   *  caret went into a page" from "the user left the window". */
  windowFocus: {
    onChange(cb: (focused: boolean) => void): () => void
  }
  /** keyboard shortcuts forwarded from the app menu's accelerators (see menu.ts) */
  shortcuts: {
    /** ⌃` / View → New Terminal Tab (D3/R5) — open ONE terminal tab in the
     *  selected conversation tab's Workbench panel, expanding it if collapsed, and put
     *  the caret in the new shell. Greyed by `setWorkbenchAvailable` when there is no
     *  bound, live session to open a shell in. */
    onNewTerminalTab(cb: () => void): () => void
    /** ⌥⌘N / View → Notes — put the caret in the current workspace's note,
     *  opening the Notes island first if it is folded. Always live; with no workspace
     *  pinned there is nothing to focus and the renderer does nothing. */
    onFocusNotes(cb: () => void): () => void
    /** ⌘N / File → New Session… — open the C10 workspace picker for the
     *  current workspace (the only way to start a session, A1/§5) */
    onNewSession(cb: () => void): () => void
    /** ⇧⌘N / File → New Worktree Session… — open the C8 worktree dialog
     *  (new-session-entrances D8) */
    onNewWorktreeSession(cb: () => void): () => void
    /** ⌘W — close the active tab */
    onCloseTab(cb: () => void): () => void
    /** ⌘F — open find-in-page over the file viewer (from the menu, or a focused
     *  preview webview's before-input-event; see menu.ts / main before-input hook) */
    onFind(cb: () => void): () => void
    /** "Check for Updates…" app-menu item → open the update modal */
    onCheckUpdate(cb: () => void): () => void
    /** ⌘, / Settings… app-menu item → open the Settings modal */
    onOpenSettings(cb: () => void): () => void
    /** ⇧⌘R — restart the active tab's claude session in place (kill the pty, respawn
     *  it with --resume). Silently ignored on a tab with no session to resume. */
    onRestartSession(cb: () => void): () => void
    /** ⇧⌘O / File → Add Workspace… — run the add-workspace picker flow */
    onAddWorkspace(cb: () => void): () => void
    /** ⌘S — file-edit B-16. Save the file the Workbench is editing, but only while the
     *  panel holds the FOCUS (the same narrowing ⌘F gets: with the focus in the TUI,
     *  ⌘S belongs to whatever Claude is doing). Always live, and a no-op when nothing
     *  is dirty — B-15 makes "nothing to save" the renderer's answer, not a greyed
     *  menu item. */
    onSave(cb: () => void): () => void
    /** ⌘⇧F — toggle the Files island's search row (C3) */
    onFindFiles(cb: () => void): () => void
    /** the Browser's menu commands (D9). ⌘R / ⌘0± / ⌥⌘I stopped being Electron roles
     *  precisely so they can land here and be dispatched by the active surface —
     *  a role:reload pressed inside a guest would reload Koloft and take every terminal
     *  with it (IMPL-4/5). ⌘T arrives here too, forwarded out of the guest's own
     *  renderer, where a host keydown listener can never see it. */
    onBrowserCommand(cb: (cmd: BrowserCommand) => void): () => void
    /** FR-53: ⌘⌥←/→ carried out of a focused guest. Every other route to these keys is
     *  App's own capture-phase listener, which a focused page never reaches. */
    onWorkbenchShortcut(cb: (cmd: WorkbenchShortcut) => void): () => void
    /** the other half of that dispatch (Q2): the renderer found another surface on the
     *  aux column, so the command keeps its whole-window meaning and comes back to main,
     *  which owns the host window's devtools and zoom. */
    windowCommand(cmd: WindowCommand): void
  }
  webgl: {
    /** Fired after OS resume / screen unlock / display changes — moments when GPU
     *  texture memory can be silently invalidated with no webglcontextlost event.
     *  The renderer clears the glyph atlas and repaints every live WebGL tab. */
    onRepair(cb: () => void): () => void
  }
  /** Scheduled jobs: a saved rule per workspace that, on a timer and only
   *  while Koloft is open, starts an ordinary Claude session with the job's task text as
   *  its first message. Main owns the clock, the store and every launch. */
  cron: {
    list(): Promise<CronState>
    save(input: CronSaveInput): Promise<CronSaveResult>
    delete(jobId: string): Promise<void>
    setEnabled(jobId: string, on: boolean): Promise<void>
    runNow(jobId: string): Promise<CronRunNowResult>
    /** skill and command names found on disk for the form's autocomplete */
    skills(workspacePath: string): Promise<SkillSuggestion[]>
    /** claude has already been trusted with this folder; false means a run here would
     *  stall on its "do you trust this project?" question, so the form warns */
    trusted(workspacePath: string): Promise<boolean>
    onState(cb: (s: CronState) => void): () => void
    onToast(cb: (text: string) => void): () => void
  }
}

// ── Scheduled jobs ─────────────────────────────────────────────

export type Schedule =
  | { kind: 'daily'; at: string } // "HH:MM", 24 h, zero-padded
  | { kind: 'weekly'; days: number[]; at: string } // days: 0 = Sunday … 6 = Saturday, ascending, unique, 1–6 entries (7 is stored as daily)
  | { kind: 'every'; n: number; unit: 'minutes' | 'hours' } // integer; minutes 1–720, hours 1–24

export type CronPermission = 'same' | 'acceptEdits' | 'skipAll'
/** what `claude --effort` accepts (2.1.263) */
export const CRON_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type CronEffort = (typeof CRON_EFFORTS)[number]
/** one rule for the form, the save, the loader and the launch — like `isValidModelName` */
export function isCronEffort(v: unknown): v is CronEffort {
  return (CRON_EFFORTS as readonly unknown[]).includes(v)
}

export interface CronJob {
  id: string // crypto.randomUUID()
  workspacePath: string // absolute, equals a pinned workspace path exactly (missing-on-disk pins included)
  name: string // 1–80 chars after trim, no control chars, contains at least one [A-Za-z0-9]
  task: string // 1–4096 chars after trim, no NUL, first char not '-'
  schedule: Schedule
  model?: string // absent = default; else /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,80}$/
  effort?: CronEffort // absent = default
  permission: CronPermission
  enabled: boolean
  createdAt: number // epoch ms
  history: HistoryLine[] // newest first (dueAt desc, stable), length ≤ 20
}

export type HistoryState = 'closed' | 'failed' | 'ended' | 'skipped' | 'missed'

export interface HistoryLine {
  dueAt: number // the due minute (epoch ms, seconds = 0) or, for Run now, Date.now()
  manual?: true // Run now
  state: HistoryState
  // the two states that FOLD: skips while a run stays open, misses while Koloft slept
  count?: number // skipped and missed: how many dues this line stands for (≥ 1)
  until?: number // skipped and missed: dueAt of the latest folded due
  worktree?: string // the run's worktree name (git workspaces)
  note?: string // failed only — one of the four failure reasons
}

export interface CronFile {
  version: 1
  jobs: CronJob[]
}

export type LiveState = 'launching' | 'running' | 'done'

export interface LiveRun {
  jobId: string
  tabId: string
  sessionId?: string
  worktree?: string
  state: LiveState
  startedAt: number
  dueAt: number
  manual?: true
}

/** pushed on `cron:state` after every change; also the reply of `cron:list` */
export interface CronState {
  jobs: CronJob[]
  live: LiveRun[]
  /** per job id: run folders on disk that start with `${slugOf(name)}-`; key absent for a non-git workspace */
  folders: Record<string, number>
  /** per job id: a loader complaint to show on the card */
  notes: Record<string, string>
}

export interface SkillSuggestion {
  name: string // with the leading '/', e.g. "/koloft.release-dmg"
  description?: string
  source: 'project' | 'home'
}

/** `terminal:spawned` — main opened a tab on its own; the renderer adds it WITHOUT activating it.
 *  `title` is only the tab's placeholder until the tracker titles the session; it is never written anywhere. */
export interface SpawnedTab {
  id: string // pty id = tab id
  kind: 'claude'
  cwd: string
  title: string // the job name
  jobId: string
}

export type CronSaveInput = Omit<CronJob, 'history' | 'createdAt' | 'id'> & { id?: string }
export type CronSaveResult = { ok: true; job: CronJob } | { ok: false; errors: string[] }
export type CronRunNowResult =
  | { ok: true }
  | {
      ok: false
      /** 'skipped' means the last run is still open; 'failed' means the launch itself
       *  was refused. They read the same to a person (a toast says which) but must never
       *  be reported as each other. */
      reason: 'skipped' | 'failed' | 'folder-missing' | 'no-account' | 'not-ready' | 'unknown-job'
    }

/** LEGACY (layout v2 only). Aux-pane mode persisted per session; null = aux pane
 *  collapsed. The Workbench merge retired the mutually-exclusive Preview/Browser
 *  column, so nothing in the live app reads this any more — `layoutMigrate` alone still
 *  does, to convert a v2 document into v3's `open` boolean. The 'terminal' value was
 *  already retired ahead of it (D1/D12). */
export type AuxMode = 'preview' | 'browser' | null

/** R19 — the label a `terminal` tab carries until its shell reports a
 *  foreground process. Never persisted: a terminal tab is run-state (D4). */
export const DEFAULT_TERMINAL_TITLE = 'zsh'

/** LEGACY (layout v2 only). One Browser tab as it survived a restart: where it was and
 *  what it was called. Read by `layoutMigrate` on the way to v3's `PersistedTab`. */
export interface BrowserTabState {
  url: string
  title: string
}

/** LEGACY (layout v2 only). A session's Browser tabs, converted one by one to
 *  `kind:'web'` PersistedTabs by the v2→v3 migration (order preserved). */
export interface SessionBrowserState {
  tabs: BrowserTabState[]
}

/** LEGACY (layout v2 only). A session's aux state, the migration's input shape. */
export interface SessionAuxState {
  auxMode: AuxMode
  browser?: SessionBrowserState
}

/** FR-03 + R2: the panel takes four tab kinds. `files` is system-pinned to the
 *  first slot (FR-02) and `terminal` is a live shell — neither survives a restart, so
 *  neither appears in the persisted array, which is why `PersistedTab.kind` below
 *  subtracts both rather than restating the pair that is left. */
export type WorkbenchTabKind = 'files' | 'web' | 'file' | 'terminal'

/** FR-30/FR-31: which of an artifact's three views is showing. Note this is three states,
 *  not the two the former FilePane had (content / diff) — Rendered and Source split. */
export type ArtifactView = 'render' | 'diff' | 'source'

/** One `web` or `file` tab as it survives a restart (FR-01/§Data Model). Deliberately
 *  narrow: `activeId`, the unread mark, recency, scroll position, the anchor line and the
 *  html twin-tab backlink (FR-56) are all RUNTIME state — persisting them would reverse
 *  the standing "selection is not persisted" call and turn every tab switch into a
 *  layout.json write. A restored `web` tab comes back unloaded (NFR-04's spirit). */
export interface PersistedTab {
  kind: Exclude<WorkbenchTabKind, 'files' | 'terminal'>
  title: string
  /** kind 'web' only */
  url?: string
  /** kind 'file' only */
  path?: string
  /** kind 'file' only — the view the tab was left on */
  view?: ArtifactView
}

/** A session's Workbench state (layout v3 `sessions[id]`). `open` carries T1/T2 and
 *  CANNOT be encoded as `activeId === null`: FR-02 keeps `files` always present and
 *  FR-19 returns focus to `files` after the last close, so `activeId` is never null.
 *  T3 is neither persisted nor per-session (FR-07). */
export interface SessionWorkbenchState {
  open: boolean
  tabs: PersistedTab[]
}

/**
 * layout.json v2 — the only organizational data Koloft
 * persists. Sessions themselves are never written here (they live in Claude's
 * own storage and are re-aggregated at read time), and there is deliberately no
 * activeSessionId: a restart lands on the welcome panel (A10).
 */
export interface LayoutV2 {
  version: 2
  /** sidebar order = array order (migration writes alphabetically, later adds append) */
  workspaces: { path: string }[]
  aux: {
    /** initial auxMode for sessions with no `sessions` entry yet */
    defaultMode: AuxMode
  }
  /** per-session aux state, keyed by Claude session id; GC'd with the jsonl */
  sessions: Record<string, SessionAuxState>
}

/**
 * layout.json v4 — the live document. Its SHAPE is v3's (the Workbench merge, one
 * tabbed panel per session, `workbench` + `sessions[id].{open,tabs}`); the version bump
 * marks a one-shot change of MEANING for the `open` flags, see `layoutMigrate`.
 *
 * Every build before v4 seeded a session's `open` from `workbench.defaultOpen` at bind,
 * and that default shipped as `true` with no UI to change it — so a stored `open: true`
 * (or a v2 `auxMode` that was not null) said nothing about the user, and the panel
 * expanded on every new session and every resume. v4 ships the default COLLAPSED
 * (`DEFAULT_PANEL_OPEN`) and reads a stored `open: true` as the user's own expand; the
 * upgrade therefore lands every existing session collapsed, tabs intact, exactly once.
 *
 * The version bump is load-bearing rather than cosmetic, as it was for v3: the guards
 * are version-gated, and an unrecognized document degrades to the safe EMPTY layout —
 * which would wipe the workspace list (NFR-06) if a shape change ever went ungated.
 */
export interface LayoutV4 {
  version: 4
  /** sidebar order = array order (migration writes alphabetically, later adds append) */
  workspaces: { path: string }[]
  workbench: {
    /** initial `open` for sessions with no `sessions` entry yet. Shipped as
     *  `DEFAULT_PANEL_OPEN` (collapsed); nothing in the UI sets it — it is a layout.json
     *  knob, and the e2e suite's seam for "a fresh session arrives expanded". */
    defaultOpen: boolean
  }
  /** per-session panel state, keyed by Claude session id; GC'd with the jsonl */
  sessions: Record<string, SessionWorkbenchState>
}

/** LEGACY (layout v3 only) — v4's shape under the old meaning of `open` (seeded, not
 *  chosen). `layoutMigrate` alone still reads it, to land a v3 document collapsed. */
export type LayoutV3 = Omit<LayoutV4, 'version'> & { version: 3 }

/** The worktree binding recorded at the head of a session's transcript (the
 *  `worktree-state` line's nested `worktreeSession` object — the lifecycle contract D11).
 *  Present for any session claude bound to a worktree, REGARDLESS of which slug
 *  the jsonl sits in (the two axes are independent, §1✎). The record's own
 *  `sessionId` field is deliberately not carried: it can be inherited from a
 *  predecessor session and must never be used as a key. */
export interface WorktreeStateMeta {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch: string
  originalHeadCommit: string
}

/** One sidebar session row, aggregated from Claude's own storage (§6). */
export interface SessionRow {
  backendId?: BackendId
  nativeSessionId?: string
  createdAt?: number
  /** Claude session id — or, while `pending`, the launching pty's tab id (no session
   *  id exists yet; it is what Cancel kills and what the click focuses). */
  id: string
  title: string
  /** 'main' for the workspace-root bucket, else the bucket dir's basename — except a
   *  row whose transcript carries a worktree binding, which is labelled with the
   *  binding's `worktreeName` (the lifecycle contract D11: fixes -w rows misread as `main`). */
  worktree: string
  cwd: string
  running: boolean
  invalidCwd: boolean
  mtime: number
  /** Launch in flight: the pty is up, the session has not bound / written its jsonl
   *  yet (§4). Sorted above every real row; its only menu item is Cancel, which
   *  kills the pty (`terminal:kill` on `id`) and the row disappears. */
  pending?: boolean
  /** The transcript's worktree binding, when one exists (D11). Drives the resume
   *  decision tree; absent for plain sessions. */
  worktreeState?: WorktreeStateMeta
  /** R11/R14 — the folder this row's "Reveal in Finder" / "Copy path" points at,
   *  and the only folder whose absence greys that item out. A running session answers
   *  with where it stands NOW (claude can move it mid-conversation); a cold one with the
   *  folder its transcript's bucket belongs to. Absent = there is nothing to open. */
  revealDir?: string
}

/** How far the workspace's root checkout is from its remote default branch
 *  (workspace-git-pull design) §05). Absent on a workspace = unknown =
 *  the sidebar draws nothing — unknown is never rendered as up to date (D10). */
export interface WorkspaceFreshness {
  /** 'none' = no remote default branch / detached HEAD (nothing to measure);
   *  'error' = the last fetch failed, the counts below are the previous ones */
  state: 'ok' | 'none' | 'error'
  behind: number
  ahead: number
  /** HEAD's short branch name */
  branch: string
  /** HEAD's full sha when the counts were taken (pull's `expect`, and the toast shas) */
  head: string
  /** the verified remote-tracking ref, e.g. `origin/main` — never mixed with the
   *  prefix-stripped branch name fetch/pull refspecs need (§05 REF) */
  defRef: string
  /** HEAD sits on the default branch itself — the only shape Koloft pulls into */
  onDefault: boolean
  dirty: boolean
  /** the workspace root is a LINKED worktree, not the main checkout (D5): Koloft
   *  explains its distance but never pulls it */
  linked: boolean
  /** a `.gitmodules` at the root — a fast-forward leaves the submodules behind, so
   *  the popover says so (§03) */
  hasSubmodules: boolean
  /** epoch ms of the last SUCCESSFUL fetch; cold start falls back to .git/FETCH_HEAD */
  fetchedAt: number | null
  /** epoch ms of the last fetch ATTEMPT — the 60s throttle key (D1) */
  lastAttemptAt: number | null
}

export interface WorkspacePullSummary {
  count: number
  /** short shas, old → new */
  from: string
  to: string
}

/** `reason` is git's own last fatal/error line (or 'state changed' when the main-side
 *  re-check found the checkout moved under the renderer's judgement). */
export type WorkspacePullResult =
  { ok: true; summary: WorkspacePullSummary } | { ok: false; reason: string }

/** One workspace's aggregated sidebar state, pushed on `workspace:rows`. */
export interface WorkspaceRows {
  /** `missing`: the pinned dir itself vanished at scan time (A1: row grays out,
   *  aggregation degraded to the single root bucket).
   *  `isGit`: the pin is a git checkout (pure-fs probe) — false means no worktree
   *  abilities, so the sidebar badges it; C10 lists it as a plain row and C8 hides its entrances (A1/A4).
   *  `freshness`: git distance from origin's default branch; absent = unknown (D7).
   *  `hasHistory`: anything left to restore (D9) — the Restore menu item greys itself
   *  off this rather than asking main when the fly-out opens. */
  workspace: {
    path: string
    missing: boolean
    isGit: boolean
    hasHistory: boolean
    freshness?: WorkspaceFreshness
    /** a remote workspace (`path` is `ssh://host/path`): `connected` is whether the
     *  last heartbeat to the machine succeeded — false means the rows may be stale,
     *  never that the sessions are dead */
    remote?: { host: string; path: string; connected: boolean }
  }
  rows: SessionRow[]
}

/** One linked worktree of a pinned workspace, as offered by the C8 dialog. `name` is
 *  the checkout's directory basename — the same key the sidebar rows carry as
 *  `worktree`, so "in use" is a plain lookup. `branch` is absent when detached. */
export interface WorktreeInfo {
  recoveryResourceId?: string
  name: string
  dir: string
  branch?: string
}

/** 'rejected-worktree': path is a linked worktree of some repo — pin the repo root
 *  instead (A1). 'exists': already pinned (idempotent, `path` = the pinned root).
 *  'added' carries the normalized root actually persisted. */
export type WorkspaceAddResult =
  | { code: 'added'; path: string }
  | { code: 'exists'; path: string }
  | { code: 'rejected-worktree' }
  | { code: 'not-found' }

/** Phase 1 of the two-step remove: `removed` is true only when nothing was running
 *  (removed immediately); otherwise the UI confirms and calls removeConfirmed. */
export interface WorkspaceRemoveResult {
  running: number
  /** scheduled jobs that would be deleted with the workspace */
  jobs: number
  removed: boolean
}

export interface SessionResumeRequest {
  sessionId: string
  /** the dir the resume spawns in — for a worktree-bound session this is the plan's
   *  `resumeCwd` (root-slug transcript → `originalCwd`; worktree-slug → the worktree),
   *  never a fallback dir */
  cwd: string
  cols?: number
  rows?: number
  /** the lifecycle contract §4 decision-tree executor mode. Omitted = 'direct' (plain
   *  `claude --resume <id>` at `cwd`, the pre-v3 behavior).
   *  'rebuild': main runs `git worktree add` per the plan first, then resumes at `cwd`.
   *  'renamed': main resumes with `--resume <id> -w <worktree>` (V1-verified combo) —
   *  claude creates/enters that worktree itself.
   *  'main': D12 escape hatch — resume at `cwd` with no isolation (only offered after
   *  a rebuild failure; never a default). */
  mode?: 'direct' | 'rebuild' | 'renamed' | 'main'
  /** mode 'renamed': the new worktree name to pass to `-w` */
  worktree?: string
  /** mode 'rebuild': recreate spec from the plan (branch may be gone → base commit) */
  rebuild?: { worktreePath: string; branch: string; baseRef: string }
}

export type SessionResumeResult =
  | { ok: true; id: string; cwd: string; kind?: TabKind }
  | { ok: false; code: 'cwd-missing' | 'invalid-args' | 'rebuild-failed' }
  /** the session method refused, and said something the user can act on */
  | { ok: false; code: 'backend'; message: string }

/** Git/occupancy facts probed at resume time (the lifecycle contract D9) — read fresh, never
 *  persisted. `occupiedBy` is the title of the RUNNING Koloft session that is in
 *  the worktree (Koloft cannot see external claude processes — honest boundary). */
export interface ResumeEvidence {
  worktreePath: string
  worktreeName: string
  expectedBranch: string
  /** current checked-out branch at worktreePath; null = detached or unreadable */
  currentBranch: string | null
  branchMatches: boolean
  dirty: boolean
  occupiedBy: string | null
}

/** Main's verdict for resuming one session (the lifecycle contract §4, `sessions:resumePlan`).
 *  - 'direct': no binding & cwd exists, or binding + evidence all green → spawn
 *    `--resume` at `cwd`, no dialog (D8 evidence gating).
 *  - 'rebuild': the bound worktree (or a plain session's cwd) is gone → offer
 *    rebuild-then-resume; `branch` is the branch to recreate at `baseRef` when the
 *    original branch no longer exists.
 *  - 'dialog': worktree exists but evidence is anomalous → the two-choice dialog
 *    (resume in existing / resume in renamed), default focus per evidence.
 *  - 'unavailable': nothing to resume into (plain session, cwd gone, not a worktree
 *    of any known repo) — read-only transcript territory. */
export type ResumePlan =
  | { action: 'direct'; cwd: string }
  | {
      action: 'rebuild'
      worktreeName: string
      worktreePath: string
      branch: string
      baseRef: string
      resumeCwd: string
    }
  | { action: 'dialog'; evidence: ResumeEvidence; resumeCwd: string; renamedName: string }
  | { action: 'unavailable'; reason: 'no-cwd' | 'not-found' }
