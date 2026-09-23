import { SESSION_CAPABILITIES } from '@shared/sessionBackend'
import { backendLabel, hasWorkbench, isSessionKind } from './agentUi'
import { create } from 'zustand'
import {
  DEFAULT_SETTINGS,
  DEFAULT_TERMINAL_TITLE,
  type AdoptableTab,
  type ArtifactView,
  type BrowserJsDialog,
  type CronState,
  type SessionWorkbenchState,
  type LoginProgress,
  type SessionInfo,
  type TabKind,
  type Settings,
  type ReleaseNotes,
  type WhatsNew,
  type UpdateCheckResult,
  type WorkspaceRows
} from '@shared/types'
import { basename } from '@shared/preview'
import { canOpenExternally, routeFor } from '@shared/browserRoute'
import type { LoginFlowState } from './components/settings/loginFlow'
// type-only: resumeFlow imports this module back at runtime (the flow drives the
// store, the store only names its dialog state)
import type { ResumeDialogState } from './resumeFlow'
import { endEditsOf, rekeyOwner } from './editRegistry'
import { selectionRoot } from './sessionRows'
import {
  activateTab as activateWbTab,
  closeTab as closeWbTab,
  cwdFallbackNotice,
  emptyTabSet,
  FILES_TAB_ID,
  KIND_TAB_CAP,
  openTab,
  persistTabs,
  restoreTabSet,
  retitleTab,
  tabLabel,
  TERM_SPAWN_FAILED_NOTICE,
  TERMINAL_CAP_NOTICE,
  type WorkbenchTabSet
} from './components/workbenchTabs'
import { DEFAULT_PANEL_OPEN } from '@shared/workbenchState'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  /** the directory this terminal was opened in (its launch cwd). Stands in as the
   *  tab's root until its session reports the real one (`sessionRows.selectionRoot`)
   *  — a `claude -w` launch starts at the repo root and lands in the worktree. */
  cwd: string
  sessionId?: string
  alive: boolean
  /**
   * Cold-row resume in flight: the pty is live (claude --resume booting) but the
   * session hasn't bound yet — the term island overlays "Resuming Claude
   * session…" until it does (§4/T-LIFE-06). Cleared by setSessions on bind.
   */
  resuming?: boolean
  /** main opened this tab for a scheduled job. Read in one place only — a pty
   *  that dies before it binds is explained by main's own toast for that job, not by
   *  the generic "ended unexpectedly" line (closeSession.unexpectedExitWanted). */
  jobId?: string
}

/** A file opened into the Workbench's reading area (the pinned `files` tab, FR-10). Held
 *  per-tab (see `openFiles`) so it survives tab switches — one file per tab, replaced by
 *  the next open within that tab. */
export interface OpenFile {
  /** absolute file path */
  src: string
  /** display label (basename) */
  label: string
  /** 1-based line to scroll to on open (from a content-search hit); optional */
  line?: number
  /** Why the file opened, when NOT by a direct user click (such opens are excluded
   *  from the Recent MRU list): 'intercept' = an `open <file>` intercepted in a tab
   *  (often agent-triggered). Absent for user-initiated opens. */
  source?: 'intercept'
}

/** Lifecycle of the manual "Check for Updates…" flow (see UpdateModal). On a successful
 *  install the app quits + relaunches, so there is no terminal "done" phase. */
export type UpdatePhase =
  | 'checking'
  | 'available'
  | 'current'
  | 'restart-required'
  | 'downloading'
  | 'error'
  /** the notes for the versions this launch just jumped over — nothing to install */
  | 'whats-new'

export interface UpdateState {
  /** modal visible */
  open: boolean
  phase: UpdatePhase
  /** running version (set once a check resolves) */
  current?: string
  /** version of the bundle on disk — the upgrade arrow's left side, and what
   *  'restart-required' says is already installed. Absent in dev. */
  installed?: string
  /** newest published version (phase 'available') */
  latest?: string
  /** changelog per skipped release, newest first (phases 'available' / 'whats-new');
   *  empty when no release in the span published one */
  releases?: ReleaseNotes[]
  /** changelogs beyond the display cap, so the modal can say so */
  omittedReleases?: number
  /** GitHub Release page (phase 'available') */
  htmlUrl?: string
  /** 0–100 during 'downloading'; -1 when the server sent no length */
  percent?: number
  /** a restart has been asked for and the quit is running. Lives in the store (not the
   *  component) so a fresh check clears it — the modal never unmounts, so component state
   *  would stay latched for the session. */
  restarting?: boolean
  /** message for phase 'error' */
  error?: string
}

interface AppState {
  tabs: Tab[]
  activeTabId: string | null
  sessions: SessionInfo[]
  settings: Settings
  settingsOpen: boolean
  /** the welcome is on screen. Pinning a folder in its step 2 makes
   *  `workspaceRows` non-empty, which would otherwise unmount the welcome mid-flow;
   *  the sidebar also drops its "No workspaces yet" hint while this is on. */
  welcomeActive: boolean
  /** in-flight guided login (FR-06): written by the App-level onLoginProgress
   *  subscription so the state survives pane switches and modal close; the Accounts
   *  pane renders it as a pure view. Never holds a secret. */
  accountLogin: LoginFlowState | null
  /** file opened into each tab's viewer pane, keyed by tabId. Per-tab (not a single slot)
   *  so a preview survives switching to another tab and back — the pane for every entry
   *  stays mounted (see App.tsx), preserving its scroll. Absent/null = no preview for that
   *  tab. Ephemeral run-state — never persisted. */
  openFiles: Record<string, OpenFile | null>
  /** width (px) of the Workbench panel in T2 (FR-08); persisted to settings. The default
   *  for a tab with no width of its own — the last one dragged anywhere. */
  workbenchWidth: number
  /** each conversation tab's own panel width, keyed by tab id: dragging in one tab must
   *  not move the panel in another. Run-state — a restart starts from `workbenchWidth`. */
  workbenchWidths: Record<string, number>
  /** width (px) of the left sidebar; persisted to settings */
  sidebarWidth: number
  /** D6 — height (px) of the Notes island in the left dock; persisted to settings */
  notesHeight: number
  /** aggregated workspace → session rows (C2 sidebar), pushed by main after every
   *  rescan. Ephemeral — the truth lives in Claude's storage + layout v2. */
  workspaceRows: WorkspaceRows[]
  /** transient inline notice (add-workspace rejections, vanished resume cwd) */
  toast: string | null
  /** file the current toast points at (a finished download, §05D-2): clicking the toast
   *  reveals it, which is what makes "Reveal in Finder" true rather than decoration. */
  toastReveal: string | null
  /**
   * THE PANEL'S TWO-LAYER KEY (D8/R1). These three tables — and every other
   * bit of panel run-state — are keyed by the CONVERSATION TAB id, the pty id of the
   * claude process the tab holds. On DISK the entry is still keyed by the claude session
   * id: a write converts the tab id to the id the tab is bound to right now
   * (`boundSessionId`; an unbound tab writes nothing), and a tab's FIRST bind reads the
   * saved entry back by that same id, once.
   *
   * Why the split: the tab is what the user calls "this session". `/clear` and `/resume`
   * hand the tab a different claude session id, and keying the panel on that made the
   * user's pages reload and their files re-read for a window they never left. Keying on
   * the tab makes both a no-op, and lets ⇧⌘R (which swaps a new pty into the same slot)
   * carry the panel over in the same store step that moves `openFiles`. The disk key
   * stays the session id because that is what a restart can find a conversation by.
   *
   * FR-01/05/06 — whether each conversation tab's panel is expanded (T2) rather than
   * collapsed (T1). Read through `workbench:get`, which already resolves the global
   * default. An absent key means "not read yet" — or, for a tab that HAS been read, that
   * main answered nothing (unreachable once a window exists; tolerated only because the
   * channel's type allows it).
   */
  workbenchOpen: Record<string, boolean>
  /** Each conversation tab's tab set. Runtime state: only the `PersistedTab` half travels
   *  through main, while `activeId`, the unread dots and the recency order are rebuilt on
   *  the way back in (§Data Model).
   *
   *  An absent id is NOT "known empty". Until `workbenchFetched` says main has answered
   *  for the tab, nothing may be seeded here: main still holds the session's saved tabs,
   *  and an invented empty set written back over them is data loss — the bug this split
   *  fixed. Every write path defers to `ensureWorkbench` instead. */
  workbench: Record<string, WorkbenchTabSet>
  /** The conversation tabs main has answered `workbench:get` for — the ONE fact that
   *  turns an absent `workbench[tabId]` from "not read yet" into "known empty". Set even
   *  when main answered nothing, and set for a tab with no session id at all (there is
   *  nothing on disk under an id that does not exist yet), so a tab is not re-read on
   *  every write. */
  workbenchFetched: Record<string, true>
  /** FR-57 — a user-source open the panel has to LOAD. A load is always an INTENT (a
   *  Files click, a terminal link, the address bar); an agent open never sets it, which
   *  is the whole of NFR-04's "0 requests before the user opens it". */
  workbenchLoad: { ownerTabId: string; tabId: string; nonce: number } | null
  /** Layer B — `workbenchLoad`'s AGENT twin, and the only trace an agent open leaves
   *  in the store: the shim's `open <url>` from a session, which the contextual hint is
   *  about. A guest page's ⌘-click routes as `agent` too and sets nothing — the user
   *  clicked that link themselves. */
  agentOpen: { ownerTabId: string; tabId: string; nonce: number } | null
  /** FR-57's FILE half, and the exact counterpart of `workbenchLoad` above: a user open
   *  the Files tab has to reveal — switch its inner half to Browse (where FR-10 puts the
   *  reading area) and enter Recents (FR-49). An agent open never sets it.
   *
   *  It is a nonce rather than something the panel could derive from `openFiles`, for the
   *  same reason `workbenchLoad` is: the panel may not be MOUNTED yet when the open lands
   *  (a resume's pre-bind window is exactly that), so any "compare against what I saw
   *  last" scheme starts life already equal to the answer and reveals nothing. A nonce is
   *  still unconsumed when the panel finally mounts. */
  filesReveal: { tabId: string; nonce: number } | null
  /** FR-05/07 — T3, the full-width state the TUI yields to. Global and transient by
   *  design: leaving it lands on T2, a session switch dissolves it, and nothing
   *  persists it. (Renamed from `browserFocus`: the state is no longer welded to a
   *  kind, only the ⌘⏎ key is reused.) */
  workbenchFull: boolean
  /** R1: the app-level page the global browser overlay is holding — an `open` no
   *  session could take, the releases page. `null` means there is nothing to show and
   *  no titlebar entry for it. A background landing arrives with `open: false` and
   *  `unread: true`; a second one replaces the page and keeps the SINGLE unread mark
   *  (no counting — the overlay shows the last page, like a web tab's dot). */
  overlay: { url: string; unread: boolean; open: boolean } | null
  /** D5 — per session, the tabs a CDP client is driving right now. They are pinned
   *  against both caps and wear the "an agent is driving this" mark. Runtime only: a
   *  client's grip does not survive a reload, and neither should the mark. */
  cdpAttached: Record<string, string[]>
  /** a JS dialog raised by a page inside an overlay (§02): it is drawn on the overlay
   *  itself, whose guest id it names — the panel it would otherwise land in belongs to
   *  a session and may not be mounted at all, which would leave the asking page blocked
   *  for good. */
  overlayDialog: BrowserJsDialog | null
  /**
   * R5 — the standing request "put the caret in THIS shell", raised by ⌃`, the
   * titlebar icon, ＋ ▸ New terminal and ⌘T.
   *
   * It names the pty rather than being a bare counter, and that is load-bearing: the
   * counter alone was a request every terminal body could answer, so a body merely
   * becoming active again — switching back to a session whose panel is on a terminal tab
   * — re-read the stale value and pulled the caret out of the Claude TUI the click was
   * asking for. Only the shell the request names ever sees a non-zero signal now, and
   * `TerminalView` acts on each value once (see its focus effect).
   */
  termFocus: { ptyId: string; n: number }
  /** the Workbench on screen is showing a GitHub button. The store's only trace of
   *  that button, and it exists for one reason: the contextual hint that explains it is a
   *  store TRANSITION like the other four (`hints.ts`), and a hint about a button nobody
   *  can see would point at nothing. Deliberately a bare flag rather than a tab id — the
   *  hint is one-shot, so "which panel it appeared in" is a distinction nothing can act on. */
  githubBtn: boolean
  /** workspace whose session was selected last in this run — the welcome panel's target
   *  (O2). Memory only: nothing about the selection is persisted. (It was also the second
   *  rung of the former global terminal's cwd chain; R4 roots a shell in its own
   *  conversation tab instead, so nothing else asks.) */
  lastWsPath: string | null
  /**
   * D7 — the workspace HEAD the user clicked, when the selection is the workspace
   * itself rather than one of its sessions. Set only while `activeTabId` is null: the two
   * are one selection, and a tab going active always clears this (see the subscriber at
   * the foot of this file). Run-state, never persisted — nothing about the selection is
   * (see the LayoutV4 comment in shared/types).
   */
  selectedWs: string | null
  /** state of the manual "Check for Updates…" modal */
  update: UpdateState
  /** the background check's verdict (sidebar banner); outlives any modal run, so it is
   *  not part of `update`, which a fresh check resets */
  updateOffer: UpdateCheckResult | null
  setUpdateOffer: (offer: UpdateCheckResult | null) => void
  /** the lifecycle contract §4: the resume decision-tree dialog currently up. App-level — the
   *  sidebar, the welcome panel and the restore list all raise the same one. */
  resumeDialog: ResumeDialogState | null
  /**
   * The cold row the user just clicked, from the click until main answers with a pty
   * (or the resume ends some other way). The term island shows "Resuming Claude
   * session…" for it AT ONCE, and the row reads selected — the plan probes and the
   * spawn take main a noticeable while on some sessions, and a click that changes
   * nothing on screen for that long reads as a hang. Cleared by `addTab` (the pty
   * landed, the tab's own `resuming` mask takes over), by `activateTab` (the user went
   * somewhere else) and by `releaseResume` (the resume failed or was cancelled).
   */
  resumeLaunch: { id: string; title: string } | null
  /** the lifecycle contract D3: the ⌘W confirmation for a working / approval session. */
  /** Scheduled jobs, exactly as main last pushed it. Ephemeral: the jobs live
   *  in main's own `cron.json`, the live runs live only in main's memory, and the
   *  renderer never writes either — it asks main and re-renders on the push. */
  cron: CronState
  closeConfirm: {
    tabId: string
    title: string
    status: 'working' | 'approval'
    /**
     * file-edit B-25: this session is ALSO holding unsaved files, so the two questions
     * merge into this one dialog rather than being asked back to back. Absent is the
     * ordinary two-button form. The dialog owns the close itself; these only say what
     * to do with the files on the way out.
     */
    unsaved?: {
      /** paths, for the copy */
      files: string[]
      discard(): void
      /** true when every file reached the disk — false leaves the dialog up */
      save(): Promise<boolean>
    }
  } | null
  /**
   * file-edit B-24/B-25/B-26: the "you have unsaved changes" question, up for whichever
   * route is asking. The three answers are callbacks rather than an intent the dialog
   * reports back, because the routes end in genuinely different places — a tab close, a
   * session close, an approval sent back to main — and only the caller knows which.
   */
  unsavedPrompt: {
    /** the dirty files, workspace-relative, in the order they should be read out */
    files: string[]
    /** scheduled jobs this answer would also delete. Only the workspace-removal
     *  route has any — closing a tab or quitting deletes no job, and leaves it out. */
    jobs?: number
    onCancel(): void
    onDiscard(): void
    onSave(): void | Promise<void>
  } | null

  addTab: (t: Tab) => void
  /** main opened a pty by itself. Append it WITHOUT taking the selection and
   *  WITHOUT dropping the frozen tab the user is reading (the same branch adoptTabs
   *  uses) — a job that fires must never move what is on screen. */
  addTabQuiet: (t: Tab) => void
  setCron: (s: CronState) => void
  /** rebuild the tab strip from main's adoption inventory after a reload —
   *  append every entry WITHOUT spawning and WITHOUT touching activeTabId (addTab's
   *  auto-activation would thrash the selection and mis-clear attention), then
   *  activate `activeTabBeforeReload` only if it actually adopted. */
  adoptTabs: (tabs: AdoptableTab[], activeTabBeforeReload: string | null) => void
  removeTab: (id: string) => void
  /** close a tab: kill its pty, then drop it from the list (selects a neighbor) */
  closeTab: (id: string) => void
  setActive: (id: string) => void
  setTabTitle: (id: string, title: string) => void
  setTabAlive: (id: string, alive: boolean) => void

  /** user opened a tab: switch to it */
  activateTab: (id: string) => void
  /** ⇧⌘R — restart the active tab's claude session in place: kill its pty and respawn
   *  one running `<claude command> --resume <sessionId>` in the same slot (same index,
   *  title and viewer pane). Silently no-ops on a tab with no session to resume. */
  restartActiveSession: () => void

  setSessions: (s: SessionInfo[]) => void
  setSettings: (s: Settings) => void
  setSettingsOpen: (open: boolean) => void
  setWelcomeActive: (on: boolean) => void
  beginLogin: (reauthName?: string) => void
  setLoginProgress: (p: LoginProgress) => void
  clearLogin: () => void
  setOpenFile: (f: OpenFile | null) => void
  setWorkbenchWidth: (w: number) => void
  setTabWorkbenchWidth: (tabId: string, w: number) => void
  setSidebarWidth: (w: number) => void
  setNotesHeight: (h: number) => void
  setWorkspaceRows: (rows: WorkspaceRows[]) => void
  /** show a toast; `reveal` makes it a link to that file in Finder, and one that carries
   *  a link stays up until the user acts on it (F3) instead of expiring in 4s */
  showToast: (msg: string, reveal?: string) => void
  /** take the current toast down — the × and the click that follows its link */
  dismissToast: () => void
  setResumeDialog: (d: ResumeDialogState | null) => void
  setResumeLaunch: (l: AppState['resumeLaunch']) => void
  setCloseConfirm: (c: AppState['closeConfirm']) => void
  setUnsavedPrompt: (p: AppState['unsavedPrompt']) => void

  /**
   * Read a conversation tab's panel state from main, once, by the claude session id the
   * tab is bound to. The panel's bind-time mount reads through here, and so does every
   * write path that finds the tab unfetched — a write may only ever land ON TOP of what
   * main holds. Concurrent callers share one round trip; an already fetched tab resolves
   * at once. Resolves once the answer has gone through `setWorkbenchState`, and marks the
   * tab fetched even when main answered nothing.
   */
  ensureWorkbench: (tabId: string) => Promise<void>
  /**
   * Cache what `workbench:get` says a conversation tab's state is.
   *
   * Precedence, for both halves of the document: the renderer wins wherever it already
   * holds a value. A strip already in `workbench` is kept — the user has been working in
   * it (see the body). An `open` already in `workbenchOpen` is kept too: a toggle that
   * lands inside the read's round trip is the user's newest word, and main's answer is
   * the value from BEFORE that toggle (T-AUX-02b: the bind must not undo the user's own
   * expand). For a never-fetched tab neither exists, so main's persisted document is the
   * ground truth and lands whole.
   */
  setWorkbenchState: (tabId: string, state: SessionWorkbenchState) => void
  /** FR-06 — expand/collapse the tab's panel (T1↔T2), persisted under its bound session */
  setWorkbenchOpen: (tabId: string, open: boolean) => void
  /** the panel changed a tab's strip (navigate, retitle, close, ＋, drag). Applied at
   *  once for a fetched tab; for an unfetched one the updater waits for main's answer
   *  and runs against THAT strip, so a strip is never built from nothing. `after` runs
   *  once the updater has: what the gesture does with the result goes here, since the
   *  caller cannot know whether the updater ran before the call returned. */
  updateWorkbenchTabs: (
    tabId: string,
    update: (prev: WorkbenchTabSet) => WorkbenchTabSet,
    after?: () => void
  ) => void
  /**
   * FR-13/15/57 — route ONE web target into a session's panel. Dedup, the per-kind cap
   * and the source fork all run here for both callers (main's `browser:open` channel and
   * Koloft's own surfaces via `openWebPage`), so they cannot drift.
   *
   * Web only, deliberately. A FILE target never travels this path because FR-10/14 give
   * it no tab to make — it lands in the `files` reading area, which is `setOpenFile`'s
   * job, and a `file` TAB is only ever made deliberately (⌘T's picker, ↗ New tab) inside
   * the panel itself. Carrying a dead `kind` parameter here would advertise a route that
   * does not exist.
   */
  openWorkbenchTarget: (
    tabId: string,
    opts: {
      url: string
      source: 'agent' | 'user'
      /** the request came from the `open` PATH shim inside the session — see `agentOpen` */
      fromShim?: boolean
      sourceTabId?: string
      sourcePath?: string
    }
  ) => void
  /** FR-05 — enter/leave T3. Global, never persisted. */
  setWorkbenchFull: (on: boolean) => void
  /** R1 — a page with no session to land in goes to the global overlay: shown at once
   *  when the user just asked for it, taken in the background (toast + unread) when
   *  they did not. */
  landOverlay: (url: string, presentation: 'now' | 'background') => void
  /** the titlebar entry was clicked: show what the overlay is holding, unread cleared */
  showOverlay: () => void
  /** the overlay's ✕ — the page is done with, so the entry goes with it */
  closeOverlay: () => void
  /** hand a guest's dialog to the overlay that owns it (or clear the answered one) */
  setOverlayDialog: (d: BrowserJsDialog | null) => void
  /** D5 — main reporting which tabs a client holds */
  setCdpAttached: (sessionId: string, targetIds: string[]) => void
  /** §4.1c — a CDP client's `Target.createTarget`: a `web` tab that is never
   *  deduped and steps over no pinned tab. Resolves to the new tab's id, or null when
   *  the web cap is full of tabs other clients are driving (the client gets a standard
   *  error). Async because the session's strip may not have been read from main yet —
   *  a client can reach a background session's endpoint — and a write may only ever
   *  land ON TOP of what main holds (the data-loss family, `ensureWorkbench`). */
  /** §4.1c: a CDP client asked for a page. Takes the CONVERSATION TAB the page
   *  belongs to (D8) — the caller converts from the session id the relay names. */
  openCdpTab: (tabId: string, url: string) => Promise<string | null>
  setLastWsPath: (p: string) => void
  /**
   * D7 — the user clicked a workspace head: that workspace becomes the selection.
   * No session row is active any more, and the centre shows the workspace's welcome
   * panel. The sessions that were running keep running — only the selection moves.
   */
  selectWorkspace: (path: string) => void

  /** R5 — ask ONE shell, named by its pty id, to take the caret */
  focusPanelTerm: (ptyId: string) => void

  /** the Workbench reports whether the panel on screen is showing a GitHub
   *  button, so `hints.ts` can see it appear. */
  setGithubBtn: (on: boolean) => void
  /**
   * ⌃` / the titlebar Terminal icon / ＋ ▸ New terminal / ⌘T in a shell (R2/R4/R5) — open
   * ONE shell in this conversation tab's panel: check the cap, spawn a util pty in the
   * tab's own root directory, add a `terminal` tab for it at the right end of the strip,
   * expand a collapsed panel, and put the caret in the new shell.
   *
   * Callers do NOT gate on the cap or on the spawn: both answers are notices raised from
   * here, so ⌃`, the icon and the ＋ can never disagree about what a refusal looks like.
   * What callers DO gate on is R5's three greyed states — see App's `terminalReady`.
   */
  openTerminalTab: (tabId: string) => void
  /** ⌘W in a shell, or the tab's ✕ (R6/R7): kill that shell, without asking. The pty's
   *  own exit event is swallowed afterwards (`terminalExited`); dropping the TAB is the
   *  panel's own close path, which also promotes the neighbour. */
  closeTerminalTab: (ptyId: string) => void
  /**
   * A pty exited. Answers whether it was a terminal tab's shell, so App's exit chain can
   * stop — a shell is not a conversation tab and must never reach the session path.
   *
   * Two shapes (R7): a shell we killed ourselves is already accounted for and its exit is
   * swallowed whole, while a shell that ended on its own (`exit`, Ctrl-D, a crash) takes
   * its tab off the strip here.
   */
  terminalExited: (ptyId: string) => boolean
  /** main reports a shell's foreground process (R19: the label follows `zsh` → `node` →
   *  … the way any terminal's tab does) */
  setTermTabProcess: (ptyId: string, name: string) => void
  /** main's OSC 7 tracker reports a shell `cd`ed (R19): the kind bar's directory follows */
  setTermTabCwd: (ptyId: string, cwd: string) => void

  /** open the update modal and run a check (menu "Check for Updates…") */
  openUpdateCheck: () => void
  /** show what changed since the version this user last ran */
  openWhatsNew: (w: WhatsNew) => void
  /** confirm an available update: download the newest dmg, install, relaunch */
  startUpdateDownload: () => void
  /** merge a patch into the update state (download progress, close) */
  setUpdate: (patch: Partial<UpdateState>) => void
}

/** FR-23 — the per-kind cap really closed a tab, so the toast has to name which one: a
 *  freeze (FR-24) is recoverable, this is not. Shared by every caller that can evict
 *  (the panel's own ＋ / ⌘T / address bar, and main's two open-request channels). */
export function tabEvictedNotice(title: string): string {
  return `Closed ${title} — ${KIND_TAB_CAP} tabs is this session's limit per kind`
}

/** Strip Electron's "Error invoking remote method '…': Error: " wrapper off a rejected
 *  IPC error so the modal shows just the message the updater threw. */
function ipcErrMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const i = msg.lastIndexOf('Error: ')
  return i >= 0 ? msg.slice(i + 7) : msg
}

/** tabIds that have had a live claude session at least once. Gates the claude→shell
 *  revert so a tab is only flipped back *after* a session actually bound and ended —
 *  never during the launch window before its first session registers. */
const everBoundSession = new Set<string>()
/** the session a tab last had bound, kept beyond the tab's own `sessionId` — that field
 *  is cleared by the claude→shell revert, and a restart must still be able to resume the
 *  conversation of a claude that exited while its shell lived on. */
const lastSessionId = new Map<string, string>()
/** tab ids whose session restart is in flight — dedupes a double ⇧⌘R, which would
 *  otherwise leave two claude processes fighting over one session */
const restarting = new Set<string>()
/** pty ids a restart killed on purpose: their exit is expected and must NOT close the
 *  tab (its replacement pty is already on the way). See consumeRestartExit. */
const restartedPtys = new Set<string>()
/** how long a just-restarted tab stays in `restarting` after its swap — long enough to
 *  swallow a human double-tap of ⇧⌘R, short enough to never block a deliberate one */
const RESTART_COOLDOWN_MS = 1000
/** ⇧⌘R refused because the session has no conversation to resume. Two
 *  states, two truths: a LIVE claude gains one the moment the user says something
 *  ("yet"), while on a tab whose claude is gone nothing can ever give it one. The
 *  strings live here rather than beside the App.tsx notices: App imports the store, so
 *  importing back would close the cycle. */
const NO_CONVERSATION_LIVE_NOTICE = 'Nothing to restart yet — this session has no conversation.'
const NO_CONVERSATION_DEAD_NOTICE = 'Nothing to resume — this session never had a conversation.'
/** ptys launched from "Restore from history" (the lifecycle contract D5) that have not bound a
 *  session yet. A restore has no sidebar row to fall back to, so a pty that exits
 *  while still listed here died before ever becoming a session — the one case that
 *  earns its own failure toast. */
const restoreLaunches = new Set<string>()
/** pending auto-dismiss for the transient toast */
let toastTimer: ReturnType<typeof setTimeout> | null = null
/** R7 — pty ids of shells Koloft killed itself (⌘W, the tab's ✕, a conversation tab
 *  going away). Their exit event is the tail of a close that already happened: the tab is
 *  long gone from the strip, so without this the exit would fall through to the
 *  session-tab path and be handled a second time. Consumed on the first exit for the id
 *  (pty ids are never reused). */
const closedTermPtys = new Set<string>()
/** M5: adopted tabs owed a repaint nudge. The adopted xterm is blank (main
 *  buffers no scrollback) and a fit that lands on the pty's unchanged size raises no
 *  SIGWINCH — so each adopted tab's TerminalView jiggles the pty rows once, after its
 *  first successful fit while visible. Consumed on first read. */
const adoptedNudgePending = new Set<string>()
export function consumeAdoptedNudge(id: string): boolean {
  return adoptedNudgePending.delete(id)
}
/**
 * R2/R9 — which conversation tab owns the shell behind `ptyId`, by looking through every
 * tab's panel strip. Main deliberately knows nothing about this: it reports a shell's
 * exit, its foreground process, its `cd` and its `open` requests by PTY ID alone, and
 * the answer to "whose shell is that" lives here, where the strips are.
 */
function terminalOwner(s: AppState, ptyId: string): string | undefined {
  for (const [tabId, set] of Object.entries(s.workbench)) {
    if (set.tabs.some((t) => t.kind === 'terminal' && t.id === ptyId)) return tabId
  }
  return undefined
}

/** R9 — every shell a conversation tab owns. The kill list when its claude dies or the
 *  tab is closed, and (in the same breath) the tabs to take off its strip. */
function terminalsOf(s: AppState, tabId: string): string[] {
  return (s.workbench[tabId]?.tabs ?? []).filter((t) => t.kind === 'terminal').map((t) => t.id)
}

/**
 * R9 — kill every shell a conversation tab owns, and forget them.
 *
 * Deliberately NOT part of any `set()` updater: killing a pty is an effect on the world,
 * and React may call a reducer twice. Callers run this BEFORE (or after) their state
 * update, never inside one.
 */
function killTerminalsOf(tabId: string): string[] {
  const ids = terminalsOf(useStore.getState(), tabId)
  for (const id of ids) {
    closedTermPtys.add(id)
    window.api.terminal.kill(id)
  }
  return ids
}
/** Whether two sets project to the SAME persisted document — the test that keeps a pure
 *  activation off the disk. Compares the projection rather than the sets themselves, so
 *  a change to what `PersistedTab` holds cannot make the two drift. */
function samePersistedTabs(a: WorkbenchTabSet, b: WorkbenchTabSet): boolean {
  const x = persistTabs(a)
  const y = persistTabs(b)
  if (x.length !== y.length) return false
  return x.every((t, i) => {
    const o = y[i]
    return (
      t.kind === o.kind &&
      t.title === o.title &&
      t.url === o.url &&
      t.path === o.path &&
      t.view === o.view
    )
  })
}

/** Every `workbench:get` in flight, keyed by conversation tab, so concurrent callers of
 *  `ensureWorkbench` share one round trip instead of racing two restores. */
const workbenchFetches = new Map<string, Promise<void>>()

/**
 * D8 — the claude session id a conversation tab is bound to right now, or undefined.
 *
 * The disk key, and the only place the panel converts between the two layers. The chain
 * is the one `setOpenFile` and `restartActiveSession` already walk: the live binding
 * first, then the tab's own anchor, which a restart carries through the seconds before it
 * binds. `||` not `??`: the tracker reports sessionId `''` for a session REGISTERED but
 * not yet hook-bound — the window right after a launch and right after ⇧⌘R — and an empty
 * string must fall through to the anchor.
 *
 * Exported because it is also the honest test for "does this tab still have a claude",
 * which is what App's `liveTabs` and the Files view's reset anchor need: asking the live
 * binding ALONE reads a tab as session-less for the seconds a restart takes to re-bind,
 * and both consumers act on that answer — one unmounts the tab's shells and guests, the
 * other throws away the view state the user was looking at. Taking only the two arrays it
 * reads keeps it usable from a `useMemo` that has to re-run when either moves.
 */
export function boundSessionId(
  s: Pick<AppState, 'sessions' | 'tabs'>,
  tabId: string
): string | undefined {
  const sess = s.sessions.find((x) => x.tabId === tabId)
  return sess?.sessionId || s.tabs.find((t) => t.id === tabId)?.sessionId || undefined
}

/**
 * …and the inverse: the conversation tab bound to a claude session id, or undefined.
 *
 * ⇄ D8 — the CDP relay addresses SESSIONS (it resolves one from the pty it was
 * launched in) while the panel is keyed by CONVERSATION TAB, so every op crossing that
 * boundary needs this. It matches through `boundSessionId` rather than comparing
 * `sessions[].sessionId` directly, and that is the whole point: the tracker reports `''`
 * for a session registered but not yet hook-bound, so a direct comparison answers nothing
 * for exactly the tabs a client is most likely to be driving — and answering nothing here
 * means `Target.createTarget` resolves null and the client is told "the page did not open".
 *
 * Takes the state rather than closing over it: every caller is an event handler that runs
 * long after the render it was created in, where a captured array is already history.
 */
export function tabForSession(
  s: Pick<AppState, 'sessions' | 'tabs'>,
  sessionId: string
): string | undefined {
  if (!sessionId) return undefined
  return s.tabs.find((t) => boundSessionId(s, t.id) === sessionId)?.id
}

/**
 * The conversation tab the panel belongs to, or undefined (D8).
 *
 * The panel follows the TAB, not the claude session id the tab happens to be bound to:
 * `/clear` and `/resume` change that id and must leave the panel exactly as it is. A tab
 * qualifies by its `kind` alone — a selected-but-COLD session keeps its panel readable
 * (FR-04), and a tab whose claude ended reverts to `shell`, which has no panel.
 *
 * The old `panelSessionId`'s two consumers replace it differently, which is why it was
 * never simply renamed: `commandTarget`'s `browserActive` becomes "is the active tab
 * `web`", while ⌘W/⌘T/⌘F arbitration becomes "does the panel hold the focus"
 * (`focusedWorkbench`).
 */
export function panelTabId(s: Pick<AppState, 'tabs' | 'activeTabId'>): string | undefined {
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  // a remote session has no Workbench at all, so none of the keys that
  // start here (⇧⌘B, ⌘⏎, ⌃`, ⌘F, ⌘S) have anything to act on.
  return hasWorkbench(tab) ? tab?.id : undefined
}

/**
 * FR-01/05/51 — is this session's panel EXPANDED, as far as the renderer HONESTLY knows?
 *
 * The flag lives in main (layout v3), which also resolves the global default, so for one
 * IPC round trip after a session is selected the renderer holds no answer at all. The
 * `?? true` this replaced guessed "open" during that window, and the guess is not free:
 * the panel was laid out full width and WorkbenchPane's refresh effect ran — `diffBase`,
 * `gitStatus`, `gitNumstat` and a `watchDir` — for a workspace whose panel is persisted
 * COLLAPSED, which is precisely what FR-51 promises never happens (WB-K08/WB-K08b). Then
 * the answer landed and it collapsed again, so the user saw it flash open as well.
 *
 * Unknown therefore reads as NOT open, and the only thing that reads as open is an
 * explicit entry — a gesture set it, or main's answer landed (`setWorkbenchState`, where a
 * gesture outranks the answer). That is also FR-57's pre-bind route, which flips the flag
 * for a session the renderer has never read a thing about. A fetched session with no
 * entry (main answered nothing at all — no workspace manager, unreachable once a window
 * exists) reads as collapsed too: the shipped default IS collapsed
 * (`DEFAULT_PANEL_OPEN`), so the unknown case and the default agree and no `?? true`
 * remains anywhere.
 *
 * Every reader of the flag goes through here, so what is on screen, what ⇧⌘B toggles and
 * what ⌘⏎ refuses to act on can never disagree about a panel nobody has heard about yet.
 */
export function panelIsOpen(
  s: Pick<AppState, 'workbenchOpen'>,
  tabId: string | undefined
): boolean {
  if (!tabId) return false
  return s.workbenchOpen[tabId] === true
}

/**
 * Gestures made on a tab that has NOT bound a claude session yet, oldest first.
 *
 * R1 puts the one read at the tab's FIRST BIND, and until then there is no id to read by —
 * so a gesture in that window cannot be run (it would build a strip on `emptyTabSet()` and
 * then win over main's saved tabs for the rest of the run) and cannot be dropped (it is
 * the user's own click). It waits here, and `runParked` releases it the moment the read
 * that answers it has landed.
 *
 * The window is narrow and the one route into it is worth naming, because it is not the
 * obvious one: a ⇧⌘R or a resume carries the tab's own anchor, so `boundSessionId`
 * answers for those from the first frame. What has NO anchor is a brand-new ⌘N tab in the
 * seconds between its pty starting and Claude Code's SessionStart hook firing — and
 * claude prints its login/onboarding links in exactly those seconds. Clicking one goes
 * `termLinks` → `openWebPage` → here, and without the queue that click would either be
 * dropped or would mint a strip out of nothing.
 */
const workbenchParked = new Map<string, (() => void)[]>()

function parkWorkbench(tabId: string, fn: () => void): void {
  const q = workbenchParked.get(tabId)
  if (q) q.push(fn)
  else workbenchParked.set(tabId, [fn])
}

/** …and the release, once main's answer for the tab is in the store. */
function runParked(tabId: string): void {
  const q = workbenchParked.get(tabId)
  if (!q) return
  workbenchParked.delete(tabId)
  for (const fn of q) fn()
}

/**
 * A sessions push landed, so a tab that had nothing to read by may have one now. Called
 * from `setSessions` because that is where a bind becomes visible to the renderer — the
 * panel's own bind-time read (App's effect) only covers the tab ON SCREEN, and an agent
 * `open` into a background session that binds a moment later is parked behind this.
 */
function bindParkedWorkbench(): void {
  if (!workbenchParked.size) return
  const s = useStore.getState()
  for (const tabId of [...workbenchParked.keys()]) {
    // the tab went away before it ever bound — its gestures have nowhere to land
    if (!s.tabs.some((t) => t.id === tabId)) {
      workbenchParked.delete(tabId)
      continue
    }
    if (!boundSessionId(s, tabId)) continue
    void s.ensureWorkbench(tabId)
  }
}

/**
 * Run `fn` against a FETCHED strip: at once when main has already answered for the
 * conversation tab, after `ensureWorkbench` lands when the tab has an id to read by, and
 * otherwise once it binds. Every write path passes this gate — a tab's strip is never
 * built on `emptyTabSet()` until main has said that empty is what it holds. Callbacks
 * queued on one read run in call order, so two writes that arrive before the answer land
 * one on top of the other, never one over the other.
 */
function workbenchAllowed(s: AppState, tabId: string | null): boolean {
  const tab = s.tabs.find((t) => t.id === tabId)
  const backend =
    s.sessions.find((session) => session.tabId === tabId)?.backendId ??
    (tab?.kind === 'codex' ? 'codex' : 'claude')
  return SESSION_CAPABILITIES[backend].workbench
}

function whenWorkbenchFetched(tabId: string, fn: () => void): void {
  const s = useStore.getState()
  if (!workbenchAllowed(s, tabId)) return
  if (s.workbenchFetched[tabId]) return fn()
  // R1: no bound session id yet, so there is nothing to read and nothing may be written.
  // The gesture waits for the bind rather than running against an invented empty strip.
  if (!boundSessionId(s, tabId)) return parkWorkbench(tabId, fn)
  // A rejected read may neither drop the gesture on the floor nor wave the write through:
  // writing without having heard main is the data-loss route this gate exists to close.
  // The rejection cleared the in-flight entry, so one more ask is a fresh round trip and
  // covers a transient IPC hiccup; a second failure is said out loud, and the strip on
  // disk stays exactly as main last wrote it.
  void s
    .ensureWorkbench(tabId)
    .catch(() => useStore.getState().ensureWorkbench(tabId))
    .then(fn, () =>
      useStore.getState().showToast('Could not read this session’s panel state — try again.')
    )
}

/** The one spelling of the write — the tab's panel state as main persists it, under the
 *  claude session id the tab is bound to (D8's disk layer). An UNBOUND tab writes nothing:
 *  there is no key to file it under, and inventing one would put the panel somewhere no
 *  restart could find it. R11: right after an in-TUI `/resume` the bound id is the TARGET
 *  session's, so this write lands there and overwrites whatever that id held — the panel
 *  on screen is the one truth, and nothing is merged.
 *
 *  `open` and the tab set are ONE document (they were two channels before the merge), so
 *  every structural change and every T1↔T2 toggle submits both; a write that carried only
 *  one half would let the two drift apart on disk. Runtime state (activeId, unread,
 *  recency, T3) is dropped here by `persistTabs`, not merely omitted by the caller.
 *
 *  `s` must be a snapshot taken AFTER the tab was fetched: `emptyTabSet()` here means
 *  "main holds no tabs", never "not read yet". */
function writeWorkbench(tabId: string, s: AppState): void {
  const sid = boundSessionId(s, tabId)
  if (!sid) return
  window.api.workbench.setState(sid, {
    // `open` is never invented. `setWorkbenchState` stores main's value for a tab the
    // user has not toggled, so past the fetch gate the flag is unset only when main
    // answered nothing at all (no workspace manager — unreachable once a window exists,
    // and main drops the write in that state anyway). The fallback is what App renders
    // for an unknown flag (`panelIsOpen`: collapsed): it writes what is on screen.
    open: s.workbenchOpen[tabId] ?? DEFAULT_PANEL_OPEN,
    tabs: persistTabs(s.workbench[tabId] ?? emptyTabSet())
  })
}

/**
 * Write a session's panel state back to layout v3.
 *
 * The `?? emptyTabSet()` this used to carry was a DATA-LOSS bug, and the route into it is
 * not exotic: FR-57's pre-bind branch resolves a session id off the tab anchor and flips
 * `open`, which lands here for a session whose strip the renderer has never read — main
 * holds the restored `web`/`file` tabs, the renderer holds nothing, and an invented empty
 * set overwrites them. The read-first guard that replaced it keyed on the strip's ABSENCE,
 * and every caller that seeded the strip before persisting walked straight past it —
 * the same measured loss, one call later. So the gate now keys on `workbenchFetched`, a
 * fact no caller can fake by writing `workbench[sid]`, and what goes out is the flag the
 * gesture set, onto the tabs main actually holds.
 */
function persistWorkbench(tabId: string): void {
  whenWorkbenchFetched(tabId, () => writeWorkbench(tabId, useStore.getState()))
}

export const useStore = create<AppState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  sessions: [],
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  welcomeActive: false,
  accountLogin: null,
  openFiles: {},
  workbenchWidth: DEFAULT_SETTINGS.workbenchWidth,
  workbenchWidths: {},
  sidebarWidth: DEFAULT_SETTINGS.sidebarWidth,
  notesHeight: DEFAULT_SETTINGS.notesHeight,
  workspaceRows: [],
  toast: null,
  toastReveal: null,
  workbenchOpen: {},
  workbench: {},
  workbenchFetched: {},
  workbenchLoad: null,
  agentOpen: null,
  filesReveal: null,
  workbenchFull: false,
  overlay: null,
  overlayDialog: null,
  cdpAttached: {},
  termFocus: { ptyId: '', n: 0 },
  githubBtn: false,
  lastWsPath: null,
  selectedWs: null,
  update: { open: false, phase: 'checking' },
  updateOffer: null,
  setUpdateOffer: (updateOffer) => set({ updateOffer }),
  resumeDialog: null,
  resumeLaunch: null,
  closeConfirm: null,
  cron: { jobs: [], live: [], folders: {}, notes: {} },
  unsavedPrompt: null,

  addTab: (t) => {
    // a new tab on screen supersedes the click-time placeholder, whichever resume it
    // was for — the placeholder's whole job was to bridge until something showed
    set((s) => ({ tabs: [...s.tabs, t], activeTabId: t.id, resumeLaunch: null }))
  },
  addTabQuiet: (t) =>
    set((s) => (s.tabs.some((x) => x.id === t.id) ? {} : { tabs: [...s.tabs, t] })),
  setCron: (cron) => set({ cron }),
  adoptTabs: (tabs, activeTabBeforeReload) => {
    // a re-run boot effect (HMR disturbance, any future double-mount) must not put a
    // second tab on a pty the strip already shows — append only what is genuinely new
    const fresh = tabs.filter((a) => !get().tabs.some((t) => t.id === a.id))
    if (!fresh.length) {
      // activation may still refer to an already-present tab — honor it
      if (activeTabBeforeReload && get().tabs.some((t) => t.id === activeTabBeforeReload)) {
        set({ activeTabId: activeTabBeforeReload })
      }
      return
    }
    const adopted: Tab[] = fresh.map((a) => {
      const t: Tab = {
        id: a.id,
        kind: a.kind,
        title: a.title ?? (isSessionKind(a.kind) ? backendLabel(a.kind) : 'Terminal'),
        cwd: a.cwd,
        alive: true
      }
      if (a.sessionId) {
        t.sessionId = a.sessionId
        // seed the side tables a sessions push would normally fill — a session that
        // ended during the reload gap never appears in any push, so without this the
        // stale claude tab could never revert (and ⇧⌘R would lose its anchor)
        everBoundSession.add(a.id)
        lastSessionId.set(a.id, a.sessionId)
      } else if (a.resumeSessionId) {
        // the resume the old renderer had in flight: same tab shape runResume builds
        t.sessionId = a.resumeSessionId
        t.resuming = true
      }
      return t
    })
    for (const t of adopted) adoptedNudgePending.add(t.id)
    set((s) => ({
      tabs: [...s.tabs, ...adopted],
      // only a tab that actually adopted may take the selection — a remembered id
      // that died (or was a util shell) leaves the cold welcome path untouched
      activeTabId: adopted.some((t) => t.id === activeTabBeforeReload)
        ? activeTabBeforeReload
        : s.activeTabId
    }))
  },
  removeTab: (id) => {
    // R9 — the tab going away takes its shells with it. The kill happens HERE, before the
    // state update, and never inside the updater below: `set` runs a pure reducer that
    // React is free to call twice, and killing a pty twice is an effect on the world.
    killTerminalsOf(id)
    // …and its clean edit buffers, held outside the store. A DIRTY one stays: claude
    // exiting on its own lands here without the unsaved-work question the user's own close
    // asks first, and the buffer is the only copy — the quit guard's "Save all" can still
    // write it out.
    endEditsOf(id)
    set((s) => {
      everBoundSession.delete(id) // tab gone — drop its revert-gate entry
      lastSessionId.delete(id) // …and its resume anchor
      workbenchParked.delete(id) // …and any gesture still waiting for a bind that will not come
      const tabs = s.tabs.filter((t) => t.id !== id)
      // drop the tab's viewer pane too
      const openFiles = { ...s.openFiles }
      delete openFiles[id]
      let activeTabId = s.activeTabId
      if (activeTabId === id) activeTabId = tabs.length ? tabs[tabs.length - 1].id : null
      // R9: the tab going away IS the panel's end. The run-state is keyed by this tab id
      // and nothing will ever carry that id again, so keeping it would only hold an
      // evicted session's strip alive for the run — and would short-circuit the read a
      // later resume (which gets a NEW tab) has to do against disk. What main persisted
      // under the claude session id is untouched: that is what the resume comes back to.
      const workbench = { ...s.workbench }
      const workbenchOpen = { ...s.workbenchOpen }
      const workbenchFetched = { ...s.workbenchFetched }
      const workbenchWidths = { ...s.workbenchWidths }
      delete workbench[id]
      delete workbenchOpen[id]
      delete workbenchFetched[id]
      delete workbenchWidths[id]
      return {
        tabs,
        openFiles,
        activeTabId,
        workbench,
        workbenchOpen,
        workbenchFetched,
        workbenchWidths
      }
    })
  },
  closeTab: (id) => {
    // a deliberate close (⌘W Cancel, the D3 confirm) is not a restore that FAILED:
    // drop the marker before the kill's exit event reaches consumeRestoreExit, or a
    // cancelled restore apologizes for itself (D5)
    restoreLaunches.delete(id)
    window.api.terminal.kill(id)
    get().removeTab(id)
  },
  setActive: (id) => set({ activeTabId: id }),
  // No-op guards: the session stream re-sends every tab's title/alive on each
  // (throttled) update. Returning {} when nothing changed keeps the `tabs` array
  // reference stable so subscribers don't re-render on unchanged data.
  setTabTitle: (id, title) =>
    set((s) => {
      const cur = s.tabs.find((t) => t.id === id)
      if (!cur || cur.title === title) return {}
      return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }
    }),
  setTabAlive: (id, alive) =>
    set((s) => {
      const cur = s.tabs.find((t) => t.id === id)
      if (!cur || cur.alive === alive) return {}
      return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, alive } : t)) }
    }),
  activateTab: (id) => {
    if (!get().tabs.some((x) => x.id === id)) return
    // going to a tab abandons the click-time placeholder (the resume itself goes on
    // and its tab still lands, exactly as before)
    set({ activeTabId: id, resumeLaunch: null })
  },

  restartActiveSession: () => {
    const { tabs, activeTabId, sessions } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return
    const sess = sessions.find((s) => s.tabId === tab.id)
    const backend = sess?.backendId ?? (tab.kind === 'codex' ? 'codex' : 'claude')
    // What makes a tab restartable is having a claude session to resume — NOT its `kind`.
    // Sources, in order: the live binding, the tab's own anchor (set by an earlier
    // restart), and the last session the tab bound (lastSessionId — defensive: with
    // `exec claude` a tab no longer outlives its session, so this leg is a belt-and-
    // braces fallback, not a reachable shape). A tab with none of them → silent no-op.
    // Empty strings must
    // fall through, not stop the chain: the tracker carries sessionId '' for a session
    // REGISTERED but not yet hook-bound — the window right after a launch and right after
    // a restart — which is exactly when the previous anchor is the one to resume. (An
    // in-TUI /resume is NOT that window: `sessionTracker.bind` swaps the id on the entry
    // in place, so it goes straight from one id to the next.)
    const sessionId = sess?.sessionId || tab.sessionId || lastSessionId.get(tab.id)
    if (restarting.has(tab.id)) return
    const oldId = tab.id
    // Is there a claude sitting on this tab right now that could still be given a first
    // message? It only ever decides how a REFUSAL is worded (FR-02 / FR-07) — the restart
    // itself is identical either way. Both conditions carry weight: a session entry
    // outlives its process (the liveness sweep only clears `alive`), so a looser check
    // would answer "say something and try again" for a claude that is already gone.
    const liveClaude = !!sess?.alive && !!sess.sessionId
    const begin = async (resumeId: string, cwd: string, live: boolean): Promise<void> => {
      restarting.add(oldId)
      // Claude Code writes a session's transcript at the FIRST user message,
      // while SessionStart reports its path immediately — so a session that was never
      // typed into has an id, a path, and nothing on disk. The kill below cannot be
      // undone and `claude --resume` on such an id just errors out, which used to cost
      // the user a healthy session plus an error tab. Ask main for the disk truth first.
      let hasTranscript = false
      try {
        hasTranscript = await window.api.sessions.transcriptExists(resumeId)
      } catch {
        // no answer is not a yes — never kill a live claude on a guess
        restarting.delete(oldId)
        return
      }
      if (!hasTranscript) {
        restarting.delete(oldId)
        get().showToast(live ? NO_CONVERSATION_LIVE_NOTICE : NO_CONVERSATION_DEAD_NOTICE)
        return
      }
      // ⌘W can land inside the probe's round trip: restarting a tab that is gone would
      // spawn a claude nothing will ever show, bind it, and have it reaped right after —
      // the same double-bind noise this issue reported.
      if (!get().tabs.some((x) => x.id === oldId)) {
        restarting.delete(oldId)
        return
      }
      restartedPtys.add(oldId)
      // A claude title is only ever derived from the live session at render time, and the
      // kill untracks it — bake the current one onto the tab so the restart window shows
      // the session's name instead of falling back to "Terminal".
      get().setTabTitle(oldId, sess?.title ?? tab.title)
      // kill BEFORE creating: two claude processes must never hold one session at once
      window.api.terminal.kill(oldId)
      void window.api.terminal
        .create({ kind: backend, cwd, resumeSessionId: resumeId })
        .then((res) => {
          // D11: main refused the launch line — the tab keeps its session anchor and
          // goes dead, exactly as it does when the respawn itself fails
          if (!res.ok) throw new Error(res.code)
          if (!get().tabs.some((x) => x.id === oldId)) {
            // tab was closed mid-restart — don't leak the freshly spawned pty, and leave no
            // bookkeeping behind for an id no tab will ever carry
            window.api.terminal.kill(res.id)
            return
          }
          set((s) => {
            // swap the new pty into the SAME slot (index, title and pane preserved) — a
            // close+reopen would move the tab to the end of the bar and drop its viewer pane.
            const tabs = s.tabs.map((x) =>
              x.id === oldId
                ? {
                    ...x,
                    id: res.id,
                    kind: backend as TabKind,
                    cwd: res.cwd,
                    sessionId: resumeId,
                    alive: true
                  }
                : x
            )
            const activeTabId = s.activeTabId === oldId ? res.id : s.activeTabId
            // D8/R1: the panel travels with the slot, in this same step. ⇧⌘R is the one
            // event that changes a conversation tab's id, so it is the one event the
            // tab-keyed panel state has to be moved for — the pages, the open files and
            // the expand flag all stay exactly as they were. Moving `workbenchFetched`
            // too is what keeps the restart from re-reading disk and remounting the
            // strip the user is already looking at.
            const move = <T>(m: Record<string, T>): Record<string, T> => {
              if (!(oldId in m)) return m
              const next = { ...m, [res.id]: m[oldId] }
              delete next[oldId]
              return next
            }
            return {
              tabs,
              activeTabId,
              openFiles: move(s.openFiles),
              workbench: move(s.workbench),
              workbenchOpen: move(s.workbenchOpen),
              workbenchFetched: move(s.workbenchFetched)
            }
          })
          // …a gesture still waiting for a bind — narrow, but reachable: the restart's
          // own tracker fallback runs exactly when the renderer's snapshot has no id yet,
          // which is the state that parks. Dropping it would lose a click the user made.
          const parked = workbenchParked.get(oldId)
          if (parked) {
            workbenchParked.delete(oldId)
            workbenchParked.set(res.id, parked)
          }
          // …and the edit buffers, which are keyed by conversation tab exactly as the
          // three tables above are. Outside the `set` updater on purpose: the registry is
          // module state, not store state, and a reducer React may run twice is no place
          // to move it (see `rekeyOwner` for what going unmoved costs).
          rekeyOwner(oldId, res.id)
          // move the per-tab bookkeeping onto the new id along with the tab
          everBoundSession.delete(oldId)
          lastSessionId.delete(oldId)
          lastSessionId.set(res.id, resumeId)
          // Hold the new id briefly: `finally` frees the old one the moment create resolves,
          // so without this a real double-tap of ⇧⌘R (~200ms apart) restarts twice. The
          // entry also keeps the revert guard armed across the gap before the resumed
          // session re-binds.
          restarting.add(res.id)
          setTimeout(() => restarting.delete(res.id), RESTART_COOLDOWN_MS)
        })
        .catch(() => {
          // the respawn failed: keep the tab (its session anchor is intact) and just mark
          // it dead, so ⇧⌘R can retry once the user fixes the claude command
          get().setTabAlive(oldId, false)
        })
        .finally(() => restarting.delete(oldId))
    }
    // a worktree session runs in a dir the tab was never launched in, and `claude
    // --resume` only finds the conversation from the dir it was logged under — that is
    // the session's own root (treeRoot, which follows it when claude moves it to another
    // checkout), not its live cwd, which the TUI may have drifted anywhere since (and
    // which would both miss the transcript's project bucket and re-root the file panel
    // on respawn).
    if (sessionId) return void begin(sessionId, sess?.treeRoot ?? tab.cwd, liveClaude)
    // Nothing locally: this snapshot is THROTTLED (sessionTracker EMIT_THROTTLE_MS), so for
    // up to half a second after a session binds, main holds its id while the copy here
    // still carries the registration's empty one. ⇧⌘R is one-shot and never retries, so a
    // silent no-op in that window is indistinguishable from a dead shortcut — ask the
    // tracker, which is the authority for a LIVE session. (An ENDED one stays the local
    // chain's job: main untracked it, and only lastSessionId still remembers.) Hold the
    // restart slot across the round trip, or a double-tap inside it restarts twice.
    restarting.add(oldId)
    void window.api.sessions
      .list()
      .then((live) => {
        restarting.delete(oldId)
        const bound = live.find((s) => s.tabId === oldId && s.sessionId)
        if (!bound) return // never ran claude — silent no-op, exactly as before
        void begin(bound.sessionId, bound.treeRoot || tab.cwd, bound.alive)
      })
      .catch(() => restarting.delete(oldId))
  },

  // A tab's claude title/dot/active-state all derive from the live session, not a
  // persisted flag — EXCEPT a tab opened *as* a claude tab keeps kind:'claude' so it
  // still reads as claude during the window before its session binds. That static kind
  // would otherwise pin the tab to "claude" forever:
  // once its session ends and is untracked, isClaude() stays true and the dot never
  // reverts even though the title already falls back to "Terminal". So when a claude
  // tab's session disappears (a graceful SessionEnd, or the main-process liveness
  // fallback), flip it back to a plain shell so the whole tab reverts in lockstep.
  // Gated on everBoundSession so the launch window is never prematurely flipped — and
  // on !restarting, because ⇧⌘R untracks
  // the session the instant it kills the pty: that emit lands mid-restart and would
  // revert (and wipe the title, the sessionId and the active tab's viewer pane) a tab
  // whose replacement claude is already on its way. Only allocate a new tabs array when
  // something actually flips — the session stream re-sends on every throttled tick,
  // and an unconditional rebuild would defeat the referential-stability no-op guard
  // the other tab setters rely on.
  //
  // The title must reset too: the claude title is only ever *derived* from the live
  // session at render time (setTabTitle is never called), so once the session is gone
  // the render falls back to t.title — which still holds the last claude title that a
  // prior restore baked into the tab. Without this reset the dot reverts to shell but
  // the stale claude title lingers (and gets persisted onto the now-shell tab).
  setSessions: (sessions) => {
    set((s) => {
      const liveTabs = new Set(sessions.map((x) => x.tabId))
      for (const id of liveTabs) everBoundSession.add(id)
      for (const x of sessions) {
        if (!x.sessionId) continue
        lastSessionId.set(x.tabId, x.sessionId)
        restoreLaunches.delete(x.tabId) // it bound — no longer a restore that can fail
      }
      let changed = false
      let activeReverted = false
      const tabs = s.tabs.map((t) => {
        // resume completed: the bound session takes over — drop the overlay flag
        // now, so a LATER session end can't resurrect the "Resuming…" mask
        if (t.resuming && liveTabs.has(t.id)) {
          changed = true
          return { ...t, resuming: undefined }
        }
        if (
          isSessionKind(t.kind) &&
          !liveTabs.has(t.id) &&
          everBoundSession.has(t.id) &&
          !restarting.has(t.id)
        ) {
          changed = true
          if (t.id === s.activeTabId) activeReverted = true
          return { ...t, kind: 'shell' as TabKind, sessionId: undefined, title: 'Terminal' }
        }
        return t
      })
      if (!changed) return { sessions }
      // When the *active* tab's session ends and it reverts to a shell, its file-tree
      // root changes (a worktree session re-roots to the workspace). This revert happens
      // in place — no activeTabId change — so the active-tab-change subscriber that
      // normally resets the tab-bound tree view state never fires. Reset the same fields
      // it does (plus this tab's viewer pane), so a filter chosen on the (former)
      // session doesn't strand on the now-session-less shell. Pure terminal tabs never
      // revert, so this never fires for them.
      if (!activeReverted) return { sessions, tabs }
      const openFiles = { ...s.openFiles }
      if (s.activeTabId) delete openFiles[s.activeTabId]
      return { sessions, tabs, openFiles }
    })
    // D8/R1: a bind is what gives a tab an id to read its panel by, and this push is
    // where a bind becomes visible. Runs after the state is committed, so the read sees
    // the session it is about.
    bindParkedWorkbench()
  },
  setSettings: (settings) => set({ settings }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setWelcomeActive: (welcomeActive) => set({ welcomeActive }),
  // FR-06: open the login dialog (reauthName fixed when recovering an expired row),
  // record a progress event, or clear the slice (terminal phase / explicit dismiss)
  beginLogin: (reauthName) => set({ accountLogin: { reauthName, progress: null } }),
  setLoginProgress: (progress) =>
    set((s) => ({ accountLogin: { ...(s.accountLogin ?? {}), progress } })),
  clearLogin: () => set({ accountLogin: null }),
  // open/replace/clear the ACTIVE tab's viewer pane. No-op with no active tab (nowhere
  // to attach the pane).
  setOpenFile: (f) => {
    const s = get()
    const id = s.activeTabId
    if (!id) return
    // FR-57 vs FR-14 — the source fork, and the one place the merge CHANGED behavior.
    // A user open lands visibly: activate `files` and expand a collapsed panel. An
    // intercepted (agent) one is now completely silent: no panel, no `files` activation
    // and, unlike the former Eye's unread dot, NO signal at all — FR-51's zero-signal
    // rule and FR-14's explicitly accepted trade-off. To find what the agent opened
    // while the panel was collapsed, expand it and read Changes.
    if (f && f.source !== 'intercept') {
      // D8: the panel hangs off the CONVERSATION TAB, so the tab the file landed in is
      // already the key — no session id to resolve, and no pre-bind window to fall into.
      // (Before D8 this had to walk the live binding and then the tab's own anchor,
      // because during a resume's pre-bind window the sessions stream holds no entry at
      // all and FR-57's branch was silently skipped.)
      //
      // The tab may still be UNFETCHED here — the panel's bind-time read has not run —
      // and both calls tolerate that: the activation waits for main's strip and runs on
      // it, and the flag goes out onto main's tabs. Neither may seed a strip here: an
      // empty one written back is the session's saved tabs gone (measured:
      // `setState(sid, {open: true, tabs: []})`, no read first).
      get().updateWorkbenchTabs(id, (prev) => activateWbTab(prev, FILES_TAB_ID))
      if (!s.workbenchOpen[id]) get().setWorkbenchOpen(id, true)
      // …and the third consequence FR-57 attaches to a user open: the file has to be
      // VISIBLE, which means the pinned tab's inner half has to be Browse. Raised as a
      // nonce for the panel to consume rather than done here, because the panel is a
      // renderer concern — and because it may not exist yet (see the field's comment).
      set((st) => ({ filesReveal: { tabId: id, nonce: (st.filesReveal?.nonce ?? 0) + 1 } }))
    }
    set((st) => ({ openFiles: { ...st.openFiles, [id]: f } }))
  },
  setWorkbenchWidth: (workbenchWidth) => set({ workbenchWidth }),
  setTabWorkbenchWidth: (tabId, w) =>
    set((s) => ({ workbenchWidth: w, workbenchWidths: { ...s.workbenchWidths, [tabId]: w } })),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  setNotesHeight: (notesHeight) => set({ notesHeight }),
  // D8: the rows no longer say anything about the panel. Panel run-state is keyed by
  // conversation tab, so `removeTab` — the tab actually going away — is the one signal
  // that clears it; a row leaving the working set is main's business alone.
  // D7: a workspace the user unpinned can no longer be the selected one — drop the
  // head selection with the row, or the welcome panel would keep pointing at a folder the
  // sidebar no longer lists.
  setWorkspaceRows: (workspaceRows) =>
    set((s) => ({
      workspaceRows,
      selectedWs: workspaceRows.some((w) => w.workspace.path === s.selectedWs) ? s.selectedWs : null
    })),
  showToast: (msg, reveal) => {
    if (toastTimer) clearTimeout(toastTimer)
    // B9 (replaces F3): a toast is a notice again. F3 made a reveal toast wait for the
    // user because it was the ONLY door to a finished download — the download list is
    // that door now, so missing this costs nothing, and a card that sits over the page
    // indefinitely costs attention. Every toast gets the same window.
    toastTimer = setTimeout(() => {
      toastTimer = null
      set({ toast: null, toastReveal: null })
    }, 4000)
    set({ toast: msg, toastReveal: reveal ?? null })
  },
  dismissToast: () => {
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = null
    set({ toast: null, toastReveal: null })
  },
  setResumeDialog: (resumeDialog) => set({ resumeDialog }),
  setResumeLaunch: (resumeLaunch) => set({ resumeLaunch }),
  setCloseConfirm: (closeConfirm) => set({ closeConfirm }),
  setUnsavedPrompt: (unsavedPrompt) => set({ unsavedPrompt }),

  ensureWorkbench: (tabId) => {
    if (!workbenchAllowed(get(), tabId)) return Promise.resolve()
    if (get().workbenchFetched[tabId]) return Promise.resolve()
    const inflight = workbenchFetches.get(tabId)
    if (inflight) return inflight
    const sid = boundSessionId(get(), tabId)
    // D8/R1 — the read happens at the tab's FIRST BIND, by the id it bound to, and an
    // unbound tab is NOT "read and empty": marking it fetched here was measured to cost
    // every fresh session its panel, because the tab exists a beat before its session
    // does, the marker latched, and the bind that followed never asked main a thing. So
    // this is a no-op instead — `setSessions` calls back through `bindParkedWorkbench`
    // when the id arrives, and App's own effect re-runs on the same signal.
    if (!sid) return Promise.resolve()
    const p = window.api.workbench
      .get(sid)
      .then((st) => {
        // main resolves the global default for every id, so `st` is missing only when
        // main has no workspace manager (typed as possible, unreachable once a window
        // exists). Marked fetched regardless: a session main holds nothing for is a
        // genuinely new one, and re-reading it on every write would learn nothing.
        if (st) get().setWorkbenchState(tabId, st)
        else set((s) => ({ workbenchFetched: { ...s.workbenchFetched, [tabId]: true } }))
        // the answer is in the store, so anything the user did before the bind can now
        // run ON TOP of it rather than in place of it
        runParked(tabId)
      })
      // a rejected read leaves the tab UNFETCHED on purpose: nothing may write until
      // main has been heard, and the next write path simply asks again
      .finally(() => workbenchFetches.delete(tabId))
    workbenchFetches.set(tabId, p)
    return p
  },
  setWorkbenchState: (tabId, state) =>
    set((s) => ({
      // the user's own toggle outranks main's answer (precedence: the signature's note)
      workbenchOpen:
        tabId in s.workbenchOpen ? s.workbenchOpen : { ...s.workbenchOpen, [tabId]: state.open },
      // main's persisted tab list becomes the live set the FIRST time it is reported.
      // Never on a later report — that would throw away the strip the user has been
      // working in for whatever main last wrote. Keyed on the strip, not on
      // `workbenchFetched`, so a report for a tab main once answered nothing for still
      // lands.
      workbench:
        tabId in s.workbench ? s.workbench : { ...s.workbench, [tabId]: restoreTabSet(state.tabs) },
      workbenchFetched: { ...s.workbenchFetched, [tabId]: true }
    })),
  setWorkbenchOpen: (tabId, open) => {
    if (!workbenchAllowed(get(), tabId)) return
    set((s) => ({ workbenchOpen: { ...s.workbenchOpen, [tabId]: open } }))
    persistWorkbench(tabId)
  },
  updateWorkbenchTabs: (tabId, update, after) =>
    whenWorkbenchFetched(tabId, () => {
      // `emptyTabSet()` is legitimate ONLY past the gate: main has answered, and holds
      // nothing for this tab
      const prev = get().workbench[tabId] ?? emptyTabSet()
      const next = update(prev)
      // Identity in, identity out. The pure tab model hands `prev` straight back when it
      // decided nothing (activating the already-active tab, closing a tab that is already
      // gone), and a fresh `workbench` map for that re-renders every consumer selecting on
      // it for a set that did not move. It also keeps the "an absent id is NOT known
      // empty" rule intact: a no-op gesture no longer materializes `emptyTabSet()` into
      // the map for a tab main holds nothing for.
      if (next !== prev) set((s) => ({ workbench: { ...s.workbench, [tabId]: next } }))
      // Write only when the PERSISTED projection actually moved. Every caller funnels
      // through here — structural changes and pure activations alike — and activation,
      // unread and recency are runtime state: persisting them would turn every tab switch
      // into a layout.json write, which is precisely the call §Data Model makes against
      // storing `activeId`. Comparing the projection keeps that guarantee at the one
      // choke point instead of asking each caller to know which kind of change it made.
      if (!samePersistedTabs(prev, next)) persistWorkbench(tabId)
      after?.()
    }),
  openWorkbenchTarget: (tabId, opts) =>
    // The common way in here for an UNFETCHED tab is an agent `open <url>` in a
    // background session after a reload — App reads only the on-screen tab's strip.
    // Past the gate the tab is minted on top of main's saved tabs, and the saved `open`
    // is what an agent open leaves on disk (FR-13); only a user open flips it, below.
    whenWorkbenchFetched(tabId, () => {
      const s = get()
      const base = s.workbench[tabId] ?? emptyTabSet()
      const r = openTab(base, { kind: 'web', ...opts })
      set((st) => ({ workbench: { ...st.workbench, [tabId]: r.set } }))
      persistWorkbench(tabId)
      // FR-23: the cap's eviction is a real close, so it is said out loud
      if (r.evicted) s.showToast(tabEvictedNotice(tabLabel(r.set, r.evicted)))
      // FR-13: an agent open builds the tab and stops there — no panel, no fetch, no focus.
      if (opts.source !== 'user') {
        if (opts.fromShim)
          set((st) => ({
            agentOpen: {
              ownerTabId: tabId,
              tabId: r.tabId,
              nonce: (st.agentOpen?.nonce ?? 0) + 1
            }
          }))
        return
      }
      if (!s.workbenchOpen[tabId]) get().setWorkbenchOpen(tabId, true)
      set((st) => ({
        workbenchLoad: {
          ownerTabId: tabId,
          tabId: r.tabId,
          nonce: (st.workbenchLoad?.nonce ?? 0) + 1
        }
      }))
    }),
  setWorkbenchFull: (workbenchFull) => {
    if (workbenchFull && !workbenchAllowed(get(), get().activeTabId)) return
    set({ workbenchFull })
  },
  landOverlay: (url, presentation) => {
    // An overlay already on screen is a surface the user is looking at, so a second
    // landing simply replaces the page there (R1 §02: the guest navigates, so its own
    // Back button still reaches the page that was replaced) — nothing new to report.
    const shown = presentation === 'now' || (get().overlay?.open ?? false)
    set({ overlay: { url, unread: !shown, open: shown } })
    // R1: the receipt for a page Koloft took but did not show — "never silently
    // swallowed" is met by SAYING so and leaving the titlebar entry marked
    if (!shown) get().showToast('Page opened in the background — see the titlebar')
  },
  showOverlay: () =>
    set((s) => (s.overlay ? { overlay: { ...s.overlay, unread: false, open: true } } : {})),
  closeOverlay: () => set({ overlay: null }),
  setOverlayDialog: (overlayDialog) => set({ overlayDialog }),
  setCdpAttached: (sessionId, targetIds) =>
    set((s) => ({ cdpAttached: { ...s.cdpAttached, [sessionId]: targetIds } })),
  // §4.1c ⇄ D8. The CDP surface names SESSIONS and the panel is keyed by
  // CONVERSATION TAB, so the caller converts and hands the TAB in — `cdpAttached` is the
  // one thing here that stays session-keyed, because that is what the relay reports.
  openCdpTab: async (tabId, url) => {
    await get().ensureWorkbench(tabId)
    const s = get()
    const sid = boundSessionId(s, tabId)
    const r = openTab(s.workbench[tabId] ?? emptyTabSet(), {
      kind: 'web',
      url,
      source: 'cdp',
      pinned: new Set((sid && s.cdpAttached[sid]) || [])
    })
    if (r.refused) return null
    set((st) => ({ workbench: { ...st.workbench, [tabId]: r.set } }))
    persistWorkbench(tabId)
    if (r.evicted) s.showToast(tabEvictedNotice(tabLabel(r.set, r.evicted)))
    return r.tabId
  },
  setLastWsPath: (lastWsPath) => set({ lastWsPath }),
  // D7. `lastWsPath` moves with it because that is what the welcome panel follows
  // (O2), and the click-time resume placeholder goes because the user just asked to look
  // somewhere else — the same thing `activateTab` does.
  selectWorkspace: (path) =>
    set({ selectedWs: path, activeTabId: null, lastWsPath: path, resumeLaunch: null }),

  focusPanelTerm: (ptyId) => set((st) => ({ termFocus: { ptyId, n: st.termFocus.n + 1 } })),
  // Never `set` when nothing changed: zustand notifies on every set, even an empty one,
  // and the hint queue retries on EVERY store notification (useHints subscribes to it).
  // Extra churn here made a queued card appear a tick sooner than it used to.
  setGithubBtn: (on) => {
    if (get().githubBtn !== on) set({ githubBtn: on })
  },

  openTerminalTab: (tabId) =>
    // Past the fetch gate for the same reason every other strip mutation is: the set a
    // shell is added to must be the one main holds, never an invented empty one. A
    // terminal is not persisted, but the tabs it lands beside are.
    whenWorkbenchFetched(tabId, () => {
      const st = get()
      const base = st.workbench[tabId] ?? emptyTabSet()
      // R2 - checked BEFORE the spawn, so a refused ninth never starts a process that
      // would then have to be killed again
      if (base.tabs.filter((t) => t.kind === 'terminal').length >= KIND_TAB_CAP) {
        st.showToast(TERMINAL_CAP_NOTICE)
        return
      }
      // R4 - the conversation tab's OWN root: a worktree session's checkout, not the repo
      // it was launched from. The retired island asked "which workspace is active"; D1
      // deleted that question, and the answer here can never disagree with the Files
      // tab's root, which resolves through the same call.
      const tab = st.tabs.find((t) => t.id === tabId)
      const cwd = selectionRoot(
        tab,
        st.sessions.find((x) => x.tabId === tabId)?.treeRoot,
        undefined
      )
      void window.api.terminal
        .create({ kind: 'shell', cwd: cwd ?? window.api.home, util: true, ownerTabId: tabId })
        .then((res) => {
          if (!res.ok) throw new Error(res.code) // a refusal is a shell that never opened
          // Closing the conversation tab — or its claude dying, which closes
          // the tab too — can land inside the spawn's round trip, and either way the shell
          // has nowhere to live: adding it to a strip nobody holds any more would leak the
          // zsh for the rest of the run.
          if (!get().tabs.some((t) => t.id === tabId)) {
            window.api.terminal.kill(res.id)
            return
          }
          // R2 — the cap is checked twice, and it has to be. The first check is before
          // the spawn so a refusal normally starts no process at all; this one is after
          // it, because two ⌃`s at seven shells both pass the first check and only the
          // second is over the line. Its shell is already running by then, and a tab that
          // was never added is a zsh nothing can ever reach again.
          let refused = false
          get().updateWorkbenchTabs(tabId, (prev) => {
            const r = openTab(prev, {
              kind: 'terminal',
              // the tab IS the pty: every later report about this shell - its foreground
              // process, its cd, its `open`, its exit - names the pty id and nothing else
              id: res.id,
              cwd: res.cwd,
              title: DEFAULT_TERMINAL_TITLE,
              source: 'user'
            })
            refused = !!r.refused
            return r.set
          })
          if (refused) {
            window.api.terminal.kill(res.id)
            get().showToast(TERMINAL_CAP_NOTICE)
            return
          }
          // R4 - main answers with the directory the shell actually got: a root that has
          // vanished (a cleaned-up worktree) falls back down its own chain, and the shell
          // must not silently come back somewhere else
          if (cwd && res.cwd !== cwd) get().showToast(cwdFallbackNotice(res.cwd))
          // R5's other two halves: the panel comes up, and the caret goes into the shell
          if (!get().workbenchOpen[tabId]) get().setWorkbenchOpen(tabId, true)
          get().focusPanelTerm(res.id)
        })
        .catch(() => get().showToast(TERM_SPAWN_FAILED_NOTICE))
    }),

  closeTerminalTab: (ptyId) => {
    // R6 - no confirmation: a shell is not a session, and there is nothing in it the app
    // could offer to save. R7 - marked first, so the exit this kill produces is swallowed
    // rather than travelling the session path.
    closedTermPtys.add(ptyId)
    window.api.terminal.kill(ptyId)
  },

  terminalExited: (ptyId) => {
    if (closedTermPtys.delete(ptyId)) return true // R7: already accounted for
    const owner = terminalOwner(get(), ptyId)
    if (!owner) return false // not a shell of ours - the caller's chain carries on
    // R7 - `exit` typed in the shell is the same event as closing its tab
    get().updateWorkbenchTabs(owner, (prev) => closeWbTab(prev, ptyId))
    return true
  },

  setTermTabProcess: (ptyId, name) => {
    const s = get()
    const owner = terminalOwner(s, ptyId)
    if (!owner) return
    if (s.workbench[owner]?.tabs.find((t) => t.id === ptyId)?.title === name) return
    s.updateWorkbenchTabs(owner, (prev) => retitleTab(prev, ptyId, name))
  },

  setTermTabCwd: (ptyId, cwd) => {
    const s = get()
    const owner = terminalOwner(s, ptyId)
    if (!owner) return
    if (s.workbench[owner]?.tabs.find((t) => t.id === ptyId)?.cwd === cwd) return
    s.updateWorkbenchTabs(owner, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === ptyId ? { ...t, cwd } : t))
    }))
  },

  openUpdateCheck: () => {
    // Don't clobber an in-flight install: the menu item stays clickable, but while one is
    // running we just keep showing its progress instead of starting a check (which would
    // orphan the running install behind a fresh "checking" screen — and main would answer
    // the mid-flight error anyway, painting a failure over a healthy install).
    if (get().update.phase === 'downloading') {
      set((s) => ({ update: { ...s.update, open: true } }))
      return
    }
    set({ update: { open: true, phase: 'checking' } })
    void window.api.update
      .check()
      .then((r) =>
        set((s) => {
          if (!s.update.open) return {} // user closed the modal mid-flight
          // match each status explicitly — a fall-through to 'available' would render an
          // update offer for any status this renderer doesn't know about yet.
          if (r.status === 'available') {
            return {
              update: {
                ...s.update,
                phase: 'available' as const,
                current: r.current,
                installed: r.installed,
                latest: r.latest,
                releases: r.releases,
                omittedReleases: r.omittedReleases,
                htmlUrl: r.htmlUrl
              }
            }
          }
          if (r.status === 'restart-required') {
            return {
              update: {
                ...s.update,
                phase: 'restart-required' as const,
                current: r.current,
                installed: r.installed
              }
            }
          }
          return {
            update: {
              ...s.update,
              phase: 'current' as const,
              current: r.current,
              installed: r.installed
            }
          }
        })
      )
      .catch((e) =>
        set((s) =>
          s.update.open ? { update: { ...s.update, phase: 'error', error: ipcErrMessage(e) } } : {}
        )
      )
  },
  openWhatsNew: (w) =>
    set({
      update: {
        open: true,
        phase: 'whats-new',
        current: w.current,
        releases: w.releases,
        omittedReleases: w.omittedReleases
      }
    }),
  startUpdateDownload: () => {
    set((s) => ({ update: { ...s.update, phase: 'downloading', percent: 0 } }))
    // On success the main process quits + the detached installer relaunches, so this
    // promise only resolves/rejects when the install did NOT proceed — surface that.
    void window.api.update
      .download()
      .then((r) => {
        // the staged version turned out to be on disk already: show what actually applies —
        // the restart that resolves it, or "you're current" when disk and process agree —
        // rather than an error screen whose only button re-runs the same download
        if (r) {
          set((s) => ({
            update: {
              ...s.update,
              phase: r.status === 'restart-required' ? 'restart-required' : 'current',
              current: r.current,
              installed: r.installed,
              restarting: false
            }
          }))
        }
      })
      .catch((e) =>
        set((s) => ({ update: { ...s.update, phase: 'error', error: ipcErrMessage(e) } }))
      )
  },
  setUpdate: (patch) => {
    const prev = get().update
    const update = { ...prev, ...patch }
    // the version is recorded when the notes are DISMISSED, not when they are shown,
    // so a quit with the modal still up shows them again next launch. Every close route
    // (Esc, ×, backdrop, the Close button) lands here.
    if (prev.open && !update.open && update.phase === 'whats-new' && update.current) {
      void window.api.settings.set({ lastSeenVersion: update.current })
    }
    set({ update })
  }
}))

/** The active tab's open file (its viewer pane), or null. The pane is per-tab; components
 *  that show/decorate "the current preview" (the tree's active-row highlight, Recent MRU)
 *  read it through here rather than a global slot. */
export const useActiveOpenFile = (): OpenFile | null =>
  useStore((s) => (s.activeTabId ? (s.openFiles[s.activeTabId] ?? null) : null))

/** True when a pty exit is the tail of a session restart — we killed that pty on purpose
 *  and its tab lives on with a replacement, so the "pty exited → close the tab" rule must
 *  skip it. Consumed on the first exit for the id (pty ids are never reused). */
export function consumeRestartExit(ptyId: string): boolean {
  return restartedPtys.delete(ptyId)
}

/**
 * R12 — the conversation tab a pty belongs to: itself when it IS one, else the tab whose
 * panel holds a `terminal` tab for it.
 *
 * Main reports an `open` (and everything else about a shell) by pty id alone, on purpose:
 * it knows nothing about which conversation owns which shell, and does not need to. The
 * answer lives here, where the strips are. An id that is neither comes back unchanged, so
 * the caller's own "no such tab" branch stays the one place that decides what to do.
 */
export function conversationTabFor(ptyId: string): string {
  return terminalOwner(useStore.getState(), ptyId) ?? ptyId
}

/** A "Restore from history" launch is in flight on this pty (D5). */
export function markRestoreLaunch(ptyId: string): void {
  restoreLaunches.add(ptyId)
}

/** True when this pty exit ended a restore that never bound a session — the restore
 *  list's only failure report. Consumed on the first exit for the id. */
export function consumeRestoreExit(ptyId: string): boolean {
  return restoreLaunches.delete(ptyId)
}

/** An `open <file>` intercepted by the PATH shim in a tab: bring that tab active
 *  and show the file in its viewer pane. Ordering matters — activate first, so the
 *  active-tab-change subscriber's per-tab view-state reset runs BEFORE the preview
 *  is applied (the other way round it would immediately clear it). If the tab
 *  closed between the shim firing and delivery (`open x.md; exit`), the preview
 *  must still surface — show it beside whatever tab is active rather than dropping
 *  it (main has already consumed the request; there is no retry). */
export function openInterceptedFile(
  ptyId: string,
  src: string,
  source: 'agent' | 'user' = 'agent'
): void {
  const { tabs, activeTabId, activateTab } = useStore.getState()
  // R12: main names the PTY the `open` was typed in, and that may be a terminal tab's
  // shell rather than a conversation tab. The file belongs to the conversation that owns
  // the shell, so it is resolved here — landing "wherever is active" would drop it in
  // front of a different session whenever the user switched during a slow command.
  const tabId = conversationTabFor(ptyId)
  if (tabs.some((t) => t.id === tabId) && activeTabId !== tabId) activateTab(tabId)
  // The preview attaches to a tab's pane (openFiles is per-tab). If there's no tab at all —
  // the last tab exited racing this open — there's nowhere in-app to show it, so fall back to
  // the OS rather than silently dropping it (main already consumed the shim's invocation).
  if (!useStore.getState().activeTabId) {
    window.api.preview.osOpen(src)
    return
  }
  // FR-14/57: `source` is what forks the landing. 'intercept' is `setOpenFile`'s existing
  // word for "the agent did this" — a shell's own `open` is deliberately NOT marked
  // that way, so it takes the visible path (Files activated, panel expanded, Recents).
  useStore.getState().setOpenFile({
    src,
    label: basename(src),
    source: source === 'agent' ? 'intercept' : undefined
  })
}

/** X-9 — what a link inside a rendered markdown preview points at: an absolute target
 *  as written, a relative one resolved against the file it was written in. Query and
 *  fragment are dropped: the result is a filesystem path, not a url. */
export function previewLinkTarget(href: string, fromSrc: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return href
  const base = fromSrc.slice(0, fromSrc.lastIndexOf('/'))
  const out: string[] = []
  for (const seg of `${base}/${href.split(/[?#]/)[0]}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

/** FR-11 — a web page opened from one of Koloft's own surfaces (a Files click on .html/.htm,
 *  a link inside a rendered markdown file) renders in a `web` tab, never in a `file` one:
 *  a page runs only inside a guest. `sourceTabId` carries FR-56's "← Back to source"
 *  backlink when the open came from an artifact. With NO CONVERSATION TAB SELECTED there
 *  is no panel to attach it to, so it leaves for the OS instead. */
export function openWebPage(src: string, sourceTabId?: string, sourcePath?: string): void {
  const st = useStore.getState()
  const selected = st.tabs.find((t) => t.id === st.activeTabId)
  if (selected?.kind === 'codex') {
    if (canOpenExternally(src)) window.api.browser.openExternal(src)
    return
  }
  const decision = routeFor(src, 'user')
  if (decision.dest !== 'browser') return
  // FR-25/FR-04, and the same clause `panelTab` drops: a COLD session still owns a
  // readable panel, so its markdown links belong in it. Gating on `alive` sent every link
  // in a cold session's file tab straight to the OS browser (G0) — the user was never
  // offered the in-panel route at all, on a surface that is still on screen. The guest
  // behind the new `web` tab is what a cold session cannot have, and the mount site
  // already withholds that on its own (App's `liveTabs`).
  const tabId = st.tabs.find((t) => t.id === st.activeTabId && t.kind === 'claude')?.id
  if (!tabId) {
    // nothing in-app could take it, so the app-level overlay does — which is a
    // better answer than handing it to the OS, and the one place a page can always go.
    st.landOverlay(decision.target, 'now')
    return
  }
  st.openWorkbenchTarget(tabId, { url: decision.target, source: 'user', sourceTabId, sourcePath })
}

// FR-07: a session switch DISSOLVES T3. It is a global transient state, so the target
// session's TUI would otherwise come up buried under a full-width panel — and the target
// must land on its OWN `open` state (T1 or T2), which is exactly what dropping the global
// flag leaves behind. Nothing else is reset on a tab change: the file preview is per-tab
// (openFiles) and its pane stays mounted, so switching away and back restores it with
// scroll intact — that persistence is the whole point.
useStore.subscribe((state, prev) => {
  if (state.activeTabId === prev.activeTabId) return
  if (state.workbenchFull) useStore.setState({ workbenchFull: false })
})

// D7 — ONE rule, in one place: a tab and a workspace head can never both read as
// selected. Every door that makes a tab active (a new tab, a tab click, adoption after a
// reload, a resume, ⇧⌘R) passes through here, so none of them has to remember to drop the
// head selection itself — and a door added later cannot forget. A subscriber runs inside
// the same `set` that moved the tab, before React renders, so nothing ever paints with
// both highlights on.
//
// `resumeLaunch` counts as the selection having moved for the same reason: clicking a COLD
// row lights that row while its session is starting, and there is no tab yet to drop the
// head — so the head and the launching row would both read as picked.
useStore.subscribe((state) => {
  if ((state.activeTabId || state.resumeLaunch) && state.selectedWs)
    useStore.setState({ selectedWs: null })
})

// FR-25/FR-04 — a session going cold does not drop its `workbench` entry, and that
// REVERSES the pre-merge rule on purpose. Before, a dead session's whole aux entry was
// deleted so the resume rebuilt from disk; now what main persisted is what the resume
// comes back to, so keeping it costs nothing. Since a dead session leaves nothing on
// screen at all — its tab closes with its pty, and the row goes cold — so the entry that
// matters is the one on DISK, under the claude session id; the run-state this file keys by
// conversation tab goes with the tab (D8/R9, `removeTab`). Only the GUESTS of a session
// that is merely idle die here, which the mount site does on its own by filtering on
// `alive` (App's `liveTabs`) — no store hook is involved, and there is deliberately no
// subscriber here.
