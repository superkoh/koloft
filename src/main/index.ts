import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  protocol,
  dialog,
  session,
  shell,
  powerMonitor,
  screen,
  Notification,
  webContents,
  type WebContents
} from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { pathToFileURL } from 'url'
import { execFile } from 'child_process'
import { PtyManager, tabInstancePid } from './ptyManager'
import { probeClaude } from './claudeProbe'
import { adoptableTabs } from './tabInventory'
import { allowCrashReload } from './crashGuard'
import { FlowGate } from './flowControl'
import { SessionTracker, readAppendedLines, parseReportedTasks } from './sessionTracker'
import { CodexSessions } from './codexSessions'
import { SessionBackends } from './sessionBackends'
import { identityOf } from '@shared/sessionBackend'
import { AttentionTracker, type AttentionContext } from './attention'
import { route, dockBadgeText } from './notifyRouter'
import { setupShim } from './shim'
import { openDropTarget, type OpenDrop } from './openDrop'
import { leaveForOS, openUrlExternally, osOpenFallback } from './osOpen'
import {
  authPromptFor,
  certHostOf,
  certTrusted,
  chromeClientHints,
  enforceGuestAttach,
  gestureFresh,
  guestMenuItems,
  isAppNavigation,
  isAttachmentResponse,
  jsDialogFor,
  standardUserAgent
} from './browserSecurity'
import { directoryListingHtml } from './dirListing'
import { HOOK_SCRIPT, hookSettings, setupHooks, writeTabHookSettings } from './hooks'
import { formatRemoteKey, parseRemoteKey, type RemoteKey } from '@shared/remoteKey'
import { defaultControlDir, ensureControlDir, rsyncPull, runSsh, sshOptions } from './remote/ssh'
import { ENSURE_SH, TMUX_CONF } from './remote/install'
import {
  accountEnv,
  buildMachinePackage,
  killSessionCmd,
  launchLine,
  sessionIdOfTmux,
  tmuxSessionName,
  writeTabPackage,
  type MachinePackage
} from './remote/launch'
import {
  dq,
  machinePackageBase,
  mirrorHookDir,
  mirrorProjectsRoot,
  REMOTE_HOOK_DIR,
  remoteMachineDir,
  tabPackageDir
} from './remote/paths'
import { launchMode, RemoteSync } from './remote/sync'
import { makeDropDedupe, ownsHookReport, type HookReport } from './hookRouting'
import type { StatusLineSetting } from './statusline'
import {
  bundlePath,
  DEFAULT_THEME,
  remoteWrapperScript,
  setupStatusline,
  statusLineSetting
} from './statusline'
import {
  setFindAvailable,
  setKeepAwakeChecked,
  setSaveAvailable,
  setupAppMenu,
  setWorkbenchAvailable
} from './menu'
import { applyKeepAwake } from './keepAwake'
import {
  approve as approveQuit,
  approveAndRun,
  declineQuit,
  QUIT_ANSWER_GRACE_MS,
  quitDecision,
  reset as resetQuitGuard,
  setQuitAsk
} from './quitGuard'
import { rootsWithClaude } from './claudeLiveness'
import { loadSettings, saveSettings } from './settings'
import {
  keychainDelete,
  keychainRead,
  keychainWrite,
  recordFableCapability,
  recordProbeOutcome,
  removeAccountMeta,
  setAccountEnabled,
  listAccounts,
  findAccount,
  upsertAccountMeta,
  validateNewAccount
} from './accounts'
import { probeAccount, shouldSkipFable } from './usageProbe'
import { AccountPicker, PROBE_TIMEOUT_MS, type PickResponse } from './accountPicker'
import { loadLayout, saveLayout } from './layout'
import { ensureNotesFile, notesBaseDir } from './notes'
import { WorkspaceManager, type LiveSession } from './workspaces'
import { sanitizeSessionWorkbench } from '@shared/workbenchState'
import { planResume, worktreeHomeRoot, type ResumeProbes } from './resumePlan'
import { claudeArgv } from './claudeArgs'
import { isTrustedByClaude } from './claudeTrust'
import { CronRunner, type LaunchRequest } from './cronRunner'
import { cronFilePath, loadCron, saveCron } from './cronStore'
import { listSkills, type SkillFs } from './skillList'
import { CRON_SAVE_MESSAGES } from '@shared/cronMessages'
import { isValidWorktreeName } from '@shared/worktreeName'
import { GitFreshnessEngine } from './gitFreshness'
import { GithubLookup, parseGithubFixture } from './github'
import { restoredWindowGeometry, trackWindowState } from './windowState'
import { fullscreenOption, windowMinWidth } from './windowBounds'
import { dirExists, listDir, search, searchContent } from './fileTree'
import {
  watchFile as watchPreviewFile,
  unwatchFile as unwatchPreviewFile,
  closeAllFileWatchers,
  watchDir,
  unwatchDir,
  closeAllDirWatchers
} from './fileWatch'
import {
  MAX_READ_BYTES,
  createFile as createFileForEdit,
  looksBinary,
  openForEdit,
  writeText as writeTextForEdit
} from './fileEdit'
import {
  diffBase,
  gitStatus,
  gitNumstat,
  gitDiff,
  gitFileDiff,
  gitFileDiffFull,
  sanitizeBase
} from './gitStatus'
import { projectInfoFor, resolveSpawnCwd } from './projectInfo'
import { whatsNewDecision } from './releaseNotes'
import {
  checkForUpdates,
  downloadAndInstall,
  fetchPublishedReleases,
  fixturePath,
  releasePageUrl,
  restartApp
} from './updater'
import { currentOffer, startUpdateNotifier } from './updateNotifier'
import { extOf } from '@shared/preview'
import { canOpenExternally, routeFor, type RouteSource } from '@shared/browserRoute'
import {
  cdpEnvDir,
  relayStripChanged,
  relayTabClosed,
  relayTabRebound,
  setRelayEnabled,
  startRelay,
  writeRelayEnv,
  type RelayDeps
} from './cdpRelay'
import { safeDownloadName, suggestedDownloadName, uniqueDownloadName } from '@shared/downloadName'
import {
  permissionAsk,
  permissionKeysFor,
  type PermissionDetails,
  type PermissionName
} from './browserPermission'
import { sanitizeSettingsPatch } from '@shared/settingsOps'
import { CDP_OP_BUDGET_MS } from '@shared/cdpBudget'
import { applyWindowCommand, guestShortcut } from '@shared/shortcutDispatch'
import { BROWSER_PARTITION, PLACEHOLDER_SESSION_TITLE, isHttpUrl } from '@shared/types'
import {
  answerPermissionRequest,
  awaitGuestFor,
  beforeActivate,
  dismissActionPopup,
  listExtensions,
  onExtensionsChanged,
  reportActiveGuest,
  reportOpenDropped,
  setExtensionEnabled,
  setupExtensions,
  uninstallExtension
} from './extensionManager'
import type {
  AccountAddResult,
  AccountKind,
  AccountMeta,
  AccountView,
  BrowserAuthChallenge,
  BrowserDialogAnswer,
  BrowserDownload,
  BrowserJsDialog,
  BrowserCdpAttached,
  BrowserCdpOp,
  BrowserCdpOpResult,
  BrowserOpenRequest,
  BrowserOverlayOpen,
  BrowserStripTarget,
  ExtensionPopupAnchor,
  LoginProgress,
  CreateTabOptions,
  CreateTabResult,
  CronEffort,
  CronPermission,
  CronSaveInput,
  ProbeErrorKind,
  ResumePlan,
  SessionInfo,
  SessionStatus,
  AttentionEvent,
  AttentionKind,
  SessionResumeRequest,
  SessionResumeResult,
  SpawnedTab,
  TabInventoryReply,
  OpenRequest,
  UsageSnapshot,
  WindowCommand,
  SessionWorkbenchState,
  Settings,
  WhatsNew
} from '@shared/types'

// Two Koloft builds (the packaged app + `npm run dev`) must not share runtime state.
// Electron derives userData from the package.json "name" ("koloft") for BOTH, so a dev
// run would otherwise reuse the installed app's shim / registration dirs / per-tab
// settings and cross-bind tabs. Give the unpackaged (dev) build its own namespace.
// Must run before any app.getPath('userData') (i.e. before setupShim/setupHooks).
// (`npm run dist:beta` is the third build — it needs no branch here because it gets
// its namespace from electron-builder's extraMetadata.name, the same "name" field.)
if (!app.isPackaged) app.setName('koloft-dev')

// Background test mode: automated (Playwright/e2e) launches happen on a developer's
// LIVE machine — a launch that activates the app yanks macOS focus away from whatever
// the user is typing at that moment. CDP needs no OS focus to drive the window, so
// under KOLOFT_TEST_BACKGROUND=1 the app runs as a macOS accessory (no Dock icon, never
// activates) and every window show is inactive. The policy must be set before any
// window exists or the first show still activates.
const BACKGROUND_TEST = process.env.KOLOFT_TEST_BACKGROUND === '1'
if (BACKGROUND_TEST && process.platform === 'darwin') {
  app.setActivationPolicy('accessory')
  app.dock?.hide()
}

const ptyMgr = new PtyManager()
// Per-tab flow gates (see flowControl.ts): hold a lagging tab's output in the
// coalescing buffer instead of flooding the renderer; pause the pty itself only as
// an extreme-backlog memory backstop.
const flowGates = new Map<string, FlowGate>()
function flowGateFor(id: string): FlowGate {
  let gate = flowGates.get(id)
  if (!gate) {
    gate = new FlowGate({ onPause: () => ptyMgr.pause(id), onResume: () => ptyMgr.resume(id) })
    flowGates.set(id, gate)
  }
  return gate
}
// Renderer loss (window closed while the app lives on, or a dev hard reload) makes
// every inflight unit permanently unackable: revert to pre-gate behavior — drop the
// backlog, reopen every gate, and never leave a pty paused. Assigned where the
// coalescing buffer lives (whenReady); called from createWindow's lifecycle hooks.
let resetAllFlow: () => void = () => {}
// schedules a flush of backlog held by the gates; assigned next to flushData
let flushHeldData: () => void = () => {}
const tracker = new SessionTracker()
let codexSessions: CodexSessions | null = null
let codexStartupError: string | undefined
const sessionBackends = new SessionBackends()
function allSessions(): SessionInfo[] {
  return sessionBackends.list()
}
function isCodexSession(key: string): boolean {
  return identityOf(key).backendId === 'codex'
}
sessionBackends.register({
  id: 'claude',
  list: () => tracker.list(),
  create: createClaudeSession,
  resume: resumeClaudeSession,
  archive: (key) => workspaceMgr?.archiveSession(key) ?? false,
  transcriptExists: (key) => tracker.transcriptExists(key)
})
// the tab's pty process is the claude whose tool shells taskProcs inspects (a
// session pty runs `exec claude`)
tracker.pidOf = (tabId) => ptyMgr.pidOf(tabId)
// auto-close guards (the reasons themselves are listed at tryAutoClose)
const dirtyTabIds = new Set<string>()
tracker.activeTabId = () => uiActiveTabId
tracker.heldTabs = () => {
  const held = new Set(dirtyTabIds)
  for (const h of ptyMgr.list()) if (h.util && h.alive && h.ownerTabId) held.add(h.ownerTabId)
  return held
}
tracker.needsUser = (id) => attention.list().some((e) => e.tabId === id)
// "needs you" pending set — the one source behind both remaining outlets, so
// they can't disagree. Its only consumers are OS-level: the Dock badge mirrors the full
// pending count, and a freshly-raised `event` fans out to the per-event outlets (OS
// notification / sound) via routeAttentionEvent. The renderer no longer subscribes —
// the sidebar's status dot covers the in-app case on its own — but it can still QUERY
// the set through `attention:list` (the one observable an e2e run has, since D8 bars
// every OS-level outlet under a background test launch).
const attention = new AttentionTracker((pending, event) => {
  updateDockBadge(pending)
  retractStaleOsNotifications(pending)
  // resurrected events (reconsider's stale-context heal) pend silently: the dock count
  // only — the user plausibly watched the original, so no interrupting outlet
  if (event && !event.resurrected) routeAttentionEvent(event)
})
// the tab the user is looking at, as last reported by the renderer — one half of
// the suppression rule ("never notify about the tab the user is watching")
let uiActiveTabId: string | null = null
// M4: the active tab snapshotted at renderer teardown, served one-shot with
// the adoption inventory. A dedicated slot, not the live one: the fresh renderer's
// boot-time null report wipes uiActiveTabId before the inventory pull could read it,
// and a non-null live slot with no renderer showing it would corrupt suppression.
let activeTabBeforeReload: string | null = null
// tabId -> epoch ms its SessionEnd hook last fired (any reason): the periodic
// liveness sweep must not report these as hard exits — 'exited' is reserved for
// deaths that fired no SessionEnd at all. Timestamped, not a plain set: an
// ambiguous SessionEnd whose probe found claude still ALIVE would otherwise stick
// forever and silently swallow the alert for a genuine kill -9 an hour later.
// The sweep confirms a death within ~2 strike periods, so a short window is ample.
const sessionEndSeen = new Map<string, number>()
const SESSION_END_SEEN_TTL_MS = 30_000
/** current session title for a tab, snapshotted into attention events (an exited
 *  session is untracked moments later, and its OS notification must still name it) */
function sessionTitleOf(tabId: string): string | undefined {
  return allSessions().find((s) => s.tabId === tabId)?.title
}
function attentionCtx(): AttentionContext {
  let focused = false
  try {
    focused = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()
  } catch {
    /* window mid-teardown — treat as unfocused */
  }
  return { windowFocused: focused, activeTabId: uiActiveTabId }
}

// user-facing reason line for an attention event — the OS-notification body
const ATTENTION_REASON: Record<AttentionKind, string> = {
  'turn-done': 'turn done — your move',
  approval: 'waiting for your approval',
  exited: 'session exited unexpectedly'
}

/** The project folder name for a tab's session, for the OS notification body: the folder
 *  the session IS in, never its live cwd (a `cd` into a subfolder would rename the
 *  notification). Read from the still-tracked session — the attention callback fires
 *  synchronously before an exited session is untracked, so this resolves for every kind. */
function projectFolderName(tabId: string): string | undefined {
  const root = allSessions().find((s) => s.tabId === tabId)?.treeRoot
  return root ? path.basename(root) : undefined
}

/** Dock badge mirrors the pending "needs you" count (D4). '' clears it. The decision
 *  itself lives in notifyRouter.dockBadgeText (pure, unit-tested); D8's background-test
 *  guard is part of that decision. macOS only (`app.dock`). */
function updateDockBadge(pending: AttentionEvent[]): void {
  if (process.platform !== 'darwin') return
  const text = dockBadgeText(pending.length, loadSettings().dockBadge, BACKGROUND_TEST)
  if (text !== null) app.dock?.setBadge(text)
}

/** Bring the window forward and ask the renderer to activate a tab — the OS-notification
 *  click path (reuses the `open`-intercept restore/focus sequence). Not reachable under a
 *  background test launch, since D8 means no OS Notification is ever constructed there.
 *  With the window CLOSED (macOS app-alive case) the click must still do something:
 *  recreate the window and bring the app forward. The new window's renderer re-adopts
 *  the live ptys under their old ids, so the exact tab could in principle
 *  be deep-activated after boot — a follow-up; summoning the app is today's contract. */
function activateTabFromNotification(tabId: string): void {
  const win = mainWindow
  if (win && !win.isDestroyed()) {
    // Record the destination BEFORE focusing: the window 'focus' handler clears the
    // marker of whatever uiActiveTabId holds, and the renderer won't have processed
    // attention:activate-tab yet — without this, clicking session B's banner would
    // consume the still-unseen marker of the previously active tab A.
    uiActiveTabId = tabId
    tracker.noteActivity(tabId)
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    app.focus({ steal: true })
    sendToRenderer('attention:activate-tab', { tabId })
    return
  }
  createWindow()
  app.focus({ steal: true })
}

// Live OS notifications by tab. Two jobs: (1) hold a reference — an unreferenced
// Electron Notification can be GC'd while its banner sits in Notification Center,
// after which its 'click' handler silently never fires; (2) let the pending-set
// callback RETRACT a banner whose marker cleared, so Notification Center never
// advertises attention that no longer exists (the one-source invariant, D5).
const osNotifications = new Map<string, Notification>()
// test/diagnostic probe: how many OS notifications were ever constructed. The e2e
// suite asserts this stays 0 under KOLOFT_TEST_BACKGROUND (D8 hard rule).
;(globalThis as { __koloftOsNotifCount?: number }).__koloftOsNotifCount = 0

function retractStaleOsNotifications(pending: AttentionEvent[]): void {
  for (const [tabId, n] of osNotifications) {
    if (!pending.some((ev) => ev.tabId === tabId)) {
      try {
        n.close()
      } catch {
        /* already gone */
      }
      osNotifications.delete(tabId)
    }
  }
}

/** Raise an OS Notification for a freshly-raised event: title = session title (fallback
 *  'Claude session'), body = `<reason> · <project folder name>`; click jumps to the tab.
 *  A newer event for the same tab replaces (closes) the previous banner. */
function showOsNotification(event: AttentionEvent): void {
  const reason = ATTENTION_REASON[event.kind]
  const folder = projectFolderName(event.tabId)
  const g = globalThis as { __koloftOsNotifCount?: number }
  g.__koloftOsNotifCount = (g.__koloftOsNotifCount ?? 0) + 1
  const n = new Notification({
    title: event.title || PLACEHOLDER_SESSION_TITLE,
    body: folder ? `${reason} · ${folder}` : reason
  })
  n.on('click', () => {
    osNotifications.delete(event.tabId)
    activateTabFromNotification(event.tabId)
  })
  n.on('close', () => osNotifications.delete(event.tabId))
  const prev = osNotifications.get(event.tabId)
  if (prev) {
    try {
      prev.close()
    } catch {
      /* already gone */
    }
  }
  osNotifications.set(event.tabId, n)
  n.show()
}

/** A plain banner that belongs to no tab: a scheduled job that could not start (§4.5 step 8). It is not an attention event — there is no session to jump to — so it
 *  skips the whole routing matrix and its settings. The one rule it keeps is D8's: no
 *  Notification is ever CONSTRUCTED under a background test launch. */
function notifyPlain(title: string, body: string): void {
  if (BACKGROUND_TEST || !Notification.isSupported()) return
  const g = globalThis as { __koloftOsNotifCount?: number }
  g.__koloftOsNotifCount = (g.__koloftOsNotifCount ?? 0) + 1
  new Notification({ title, body }).show()
}

/** Fan a freshly-raised event out to the interrupting outlets, chosen by the matrix
 *  (notifyRouter.route) against fresh settings and the moment's focus. D8: under a
 *  background test launch route() returns nothing, so no OS Notification / beep is ever
 *  issued here. */
// Outlet-level flap guard: a status flap (e.g. a late post-Stop jsonl write flipping
// waiting→working→waiting) clears and re-raises the SAME tab+kind within moments —
// the pending set handles that fine, but re-firing an OS banner each time would turn
// one finished turn into a notification storm. Purely an outlet dedupe: the pending set
// and the dock count still track every change.
const OUTLET_DEDUPE_MS = 5000
const recentOutlets = new Map<string, number>()

/** The user demonstrably re-engaged this tab (visited it, switched to it, refocused
 *  on it) or started a new turn in it — the NEXT attention event is news, not a flap
 *  of the one they were already told about. Drop the outlet stamps so the dedupe
 *  can't swallow it. Flap clears (status working→waiting bounces) never pass through
 *  any of the call sites, so the storm guard itself still holds. */
function consumeOutletDedupe(tabId: string): void {
  recentOutlets.delete(`${tabId}:turn-done`)
  recentOutlets.delete(`${tabId}:approval`)
  recentOutlets.delete(`${tabId}:exited`)
}

function routeAttentionEvent(event: AttentionEvent): void {
  const outletKey = `${event.tabId}:${event.kind}`
  const lastAt = recentOutlets.get(outletKey)
  const now = Date.now()
  if (lastAt !== undefined && now - lastAt < OUTLET_DEDUPE_MS) return
  recentOutlets.set(outletKey, now)
  const decision = route(
    event,
    { windowFocused: attentionCtx().windowFocused, backgroundTest: BACKGROUND_TEST },
    loadSettings()
  )
  if (decision.os) showOsNotification(event)
  if (decision.sound) shell.beep()
}
const processedRegIds = new Set<string>()
let mainWindow: BrowserWindow | null = null

// Teardown-safe main→renderer IPC. On quit a pending timer/event can fire after the
// window's webContents is destroyed, where `webContents.send` throws "Object has been
// destroyed" — an uncaught exception inside a timer callback crashes the main process.
// The `?.` on mainWindow doesn't cover this: the window object outlives its webContents.
// Returns whether the message was actually handed to a live webContents, so callers
// with delivery-dependent accounting (the flow gates) can tell a send from a no-op.
function sendToRenderer(channel: string, ...args: unknown[]): boolean {
  try {
    const win = mainWindow
    // `win.webContents` is a getter that itself throws "Object has been destroyed" once the
    // window is gone, so the access must live inside the try — `mainWindow?.` only guards
    // null, and on quit `mainWindow` is a *destroyed-but-non-null* BrowserWindow.
    if (!win || win.isDestroyed()) return false
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return false
    wc.send(channel, ...args)
    return true
  } catch {
    // During app quit the window/webContents can be torn down between these checks and the
    // access/send. A throw here — often inside a pending flush timer — would crash the main
    // process, so swallow it; the renderer is going away.
    return false
  }
}

// Ask the renderer to clear the glyph atlas and repaint every live WebGL tab
// (webglRepair.ts). Debounced — the GPU-state-loss edges that need it (OS resume,
// display re-attach, window restore) arrive as bursts. Module scope: both the
// powerMonitor/screen wiring (whenReady) and the window edges (createWindow) call it.
let webglRepairTimer: NodeJS.Timeout | undefined
function requestWebglRepair(): void {
  clearTimeout(webglRepairTimer)
  webglRepairTimer = setTimeout(() => sendToRenderer('webgl:repair'), 500)
}

// layout v2 owner + multi-bucket session aggregation (agent-centric §6). Constructed
// in whenReady: loading the layout needs app.getPath('userData').
let workspaceMgr: WorkspaceManager | null = null

// workspace git freshness + the one-click ff pull (workspace-git-pull design)).
// Lives beside the manager, not inside it: its work reaches the network and the rescan
// path is the sidebar's lifeline.
let freshness: GitFreshnessEngine | null = null
// --- remote workspaces -----------------------------------------------------
let remoteSync: RemoteSync | null = null
let machinePkg: MachinePackage | null = null
const remoteControlDir = defaultControlDir()

/** Everything a remote session needs before the first one can start, built on the
 *  first remote launch rather than at startup — hashing the 3.3 MB statusline bundle
 *  is pure cost for the many runs that never touch a machine. Content-hashed, so a
 *  machine is only re-pushed when the contents actually change. */
function machinePackage(): MachinePackage {
  if (machinePkg) return machinePkg
  const pkgFiles: Record<string, string | Buffer> = {
    'ensure.sh': ENSURE_SH,
    'hook.sh': HOOK_SCRIPT,
    'tmux.conf': TMUX_CONF
  }
  try {
    pkgFiles['statusline/ccstatusline.js'] = fs.readFileSync(bundlePath())
    pkgFiles['statusline/package.json'] = '{"type":"module"}\n'
    pkgFiles['statusline/theme.json'] = JSON.stringify(DEFAULT_THEME, null, 2)
    pkgFiles['statusline/run.sh'] = remoteWrapperScript()
  } catch (err) {
    // no statusline on the machine is a missing bottom line, not a broken session
    console.error('[koloft] remote statusline bundle unreadable:', err)
  }
  return (machinePkg = buildMachinePackage(machinePackageBase(app.getPath('userData')), pkgFiles))
}
/** hook mirrors already handed to watchHookRegistrations — one watcher per dir,
 *  held by its disposer so unpinning the last workspace on a machine releases it */
const watchedHookMirrors = new Map<string, () => void>()
/** sessions Koloft has told a machine to kill. Kept apart from the heartbeat's own
 *  observations (launchMode says why) — this set is about what Koloft ASKED for, the
 *  alive set about what the machine last reported. */
const killedRemoteSessions = new Set<string>()
/** tmux kills still in flight, by tmux session name. ⇧⌘R kills and relaunches in one
 *  breath, and `new-session -A -D` reaching the machine before the kill would attach to
 *  the claude being destroyed — so the next launch of that name waits for it. */
const remoteKills = new Map<string, Promise<unknown>>()

// Scheduled jobs. Also constructed in whenReady, and only AFTER
// workspaceMgr.start(): the store drops a job whose workspace is not pinned, so it may
// not read the pinned list before the layout is real.
let cronRunner: CronRunner | null = null

/** When this launch started. Anything the clock says was due before it is a MISS, not
 *  something to catch up on — see cronScheduler's header. */
const BOOT_TIME = Date.now()

/** §4.5 dep `ready()`: the renderer answered `tabs:list` since its last teardown.
 *  A due that lands while this is false is held, not launched — there would be no tab
 *  bar to put the run's tab in. */
let rendererReady = false

// ---- multi-account balancing (the probe/header
// contract it rests on is docs/claude-code-contract.md §7) -------------------------
// Latest per-account usage / probe-failure for the settings panel. Keyed kind:name.
// Secrets never enter this map — it is exactly what accounts:list returns.
const usageViews = new Map<string, { usage?: UsageSnapshot; probeError?: ProbeErrorKind }>()

function viewKey(name: string, kind: AccountKind): string {
  return `${kind}:${name.toLowerCase()}`
}

function accountViews(): AccountView[] {
  return listAccounts().map((a) => ({ ...a, ...usageViews.get(viewKey(a.name, a.kind)) }))
}

function pushAccounts(): void {
  sendToRenderer('accounts:update', accountViews())
}

function notifyExpired(name: string): void {
  // one-shot OS notification on a CONFIRMED expiry (double-401). D8 hard rule: never
  // construct OS notifications under background test mode.
  if (BACKGROUND_TEST || !Notification.isSupported()) return
  new Notification({
    title: 'Claude account expired',
    body: `Account ${name} expired and left the pool — sign in again from Settings to restore it`
  }).show()
}

/** Fold one probe result into persisted status + the view store (§2.2 rule 6). */
function foldProbeResult(
  name: string,
  kind: AccountKind,
  result: Awaited<ReturnType<typeof probeAccount>>
): void {
  const prevStatus = findAccount(name, kind)?.status
  const key = viewKey(name, kind)
  if (result.ok) {
    recordProbeOutcome(name, kind, 'ok')
    if (result.fable) recordFableCapability(name, kind, result.fable)
    usageViews.set(key, { usage: result.usage ?? usageViews.get(key)?.usage })
    // keep the picker's scoring cache and the panel's display in ONE state: a manual
    // ↻ must change what the next launch picks, not just what the bars show
    if (result.usage) picker.cacheUsage(kind, name, result.usage)
  } else {
    const status = recordProbeOutcome(name, kind, result.error === 'expired' ? '401' : 'fail')
    usageViews.set(key, { ...usageViews.get(key), probeError: result.error })
    if (status === 'expired' && prevStatus !== 'expired') notifyExpired(name)
  }
  // a launch's round now lands AFTER the pick it belongs to has already answered from
  // cache, so this is the only thing that carries it to the renderer — the titlebar
  // capsule subscribes to accounts:update and would otherwise lag main's own truth
  // (including an expired flip) until something else pushed
  pushAccounts()
}

const picker = new AccountPicker({
  listAccounts,
  multiAccountOn: () => loadSettings().multiAccount,
  fablePriority: () => loadSettings().fablePriority,
  readSecret: (kind, name) => keychainRead(kind, name),
  probe: (a, secret) =>
    probeAccount(a.kind, secret, {
      timeoutMs: PROBE_TIMEOUT_MS,
      skipFable: shouldSkipFable(a, Date.now())
    }),
  onProbeOutcome: foldProbeResult,
  now: () => Date.now()
})

function watchPickRequests(pickDir: string): fs.FSWatcher | null {
  // main writes its own res-*.json into this dir and the write re-fires the watcher —
  // only req- names get a handler. Only OWN tabs are answered (a peer instance's shim
  // rides its own 3s timeout); picks are never swept on startup — a stale pick is
  // worthless by definition.
  return watchJsonDrops(pickDir, (name) =>
    name.startsWith('req-') ? (obj): void => void handlePickRequest(pickDir, name, obj) : null
  )
}

/** The pick both launch paths run: a picker fault must never block a launch, and a
 *  custom endpoint's url + model are NOT secrets, so they travel with the answer —
 *  only the credential stays in the Keychain for the launcher to fetch itself. */
async function pickForLaunch(): Promise<{
  res: PickResponse
  endpoint?: { baseUrl?: string; model?: string }
}> {
  let res: PickResponse
  try {
    res = await picker.pick()
  } catch {
    res = { account: null, reason: 'no-usable' }
  }
  if (!res.account || res.kind !== 'custom') return { res }
  const meta = findAccount(res.account, 'custom')
  return { res, endpoint: { baseUrl: meta?.baseUrl, model: meta?.model } }
}

async function handlePickRequest(pickDir: string, reqName: string, raw: unknown): Promise<void> {
  const obj = raw as { tabId?: string; ts?: number }
  if (!obj.tabId || !ptyMgr.get(obj.tabId)) return
  const id = reqName.slice('req-'.length).replace(/\.json$/, '')
  if (!/^[A-Za-z0-9-]+$/.test(id)) return
  const { res, endpoint } = await pickForLaunch()
  const payload: Record<string, unknown> = { ...res }
  if (res.account && loadSettings().skipPermissions) payload.skipFlag = true
  if (endpoint?.baseUrl) payload.baseUrl = endpoint.baseUrl
  if (endpoint?.model) payload.model = endpoint.model
  if (res.account) tracker.setPickedAccount(obj.tabId, res.account)
  const resPath = path.join(pickDir, `res-${id}.json`)
  const tmp = `${resPath}.tmp`
  try {
    // tmp + rename: the shim's poll is an existence check — existence must imply
    // completeness, or a mid-write read yields a truncated account name
    fs.writeFileSync(tmp, JSON.stringify(payload))
    fs.renameSync(tmp, resPath)
  } catch {
    /* shim falls back to a bare exec on its own timeout */
  }
  // the answer above came from cache; this push carries whatever the LAST round left
  // behind. The round this pick started pushes for itself, per account, as it lands.
  pushAccounts()
}

// ---- guided login (`claude setup-token`) ----------------------------------------
// The official flow prints a long-lived token to the terminal after a browser round
// trip. Koloft runs it in a REAL, visible tab and watches that tab's output for the token
// shape — deliberately not a hidden pty with strict output parsing: the browser step
// needs to be visible, and if the CLI's wording ever changes the user still sees the
// token and can paste it by hand instead of facing a silent hang.
interface LoginWatch {
  name: string
  buf: string
  startedAt: number
  /** the auth URL has already been reported — do not spam the panel with repeats */
  sawUrl: boolean
  done: boolean
}
const loginWatchers = new Map<string, LoginWatch>()
/** the ptys `claude setup-token` runs in, for as long as they live — a watcher is
 *  dropped the instant the token is read, which can be before the CLI's `open` lands */
const loginPtys = new Set<string>()
const LOGIN_TIMEOUT_MS = 10 * 60_000
const LOGIN_BUF_MAX = 8192
const AUTH_URL_RE = /https?:\/\/[^\s'"`<>]+/
// permissive on the prefix segment — the token format is not documented, so pin only
// what is stable: the sk-ant- namespace, a short kind segment, then the secret body
const TOKEN_RE = /sk-ant-[A-Za-z0-9]{2,12}-[A-Za-z0-9_-]{24,}/

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;?]*[A-Za-z]/g, '').replace(/[()][AB0]/g, '')
}

function sendLoginProgress(p: LoginProgress): void {
  sendToRenderer('accounts:login-progress', p)
}

/** Feed one pty's output to its login watcher, if it has one. */
function feedLoginWatcher(tabId: string, data: string): void {
  const w = loginWatchers.get(tabId)
  if (!w || w.done) return
  if (Date.now() - w.startedAt > LOGIN_TIMEOUT_MS) {
    failLogin(tabId, 'Sign-in timed out')
    return
  }
  w.buf = (w.buf + stripAnsi(data)).slice(-LOGIN_BUF_MAX)
  const m = TOKEN_RE.exec(w.buf)
  if (!m) {
    // the terminal is hidden, so the one link the user must click has to be surfaced
    // in the panel — a URL is the only part of this flow they cannot skip
    if (!w.sawUrl) {
      const u = AUTH_URL_RE.exec(w.buf)
      if (u) {
        w.sawUrl = true
        sendLoginProgress({ phase: 'browser', name: w.name, url: u[0] })
      }
    }
    return
  }
  w.done = true
  loginWatchers.delete(tabId)
  void completeLogin(tabId, w.name, m[0])
}

/** The CLI ended (or stalled) without a token. Hand back everything needed to
 *  recover: what it printed, and the pty id so the panel can offer to SHOW it. */
function failLogin(tabId: string, why: string): void {
  const w = loginWatchers.get(tabId)
  if (!w || w.done) return
  w.done = true
  loginWatchers.delete(tabId)
  const tail = w.buf.split('\n').filter(Boolean).slice(-8).join('\n')
  sendLoginProgress({
    phase: 'failed',
    name: w.name,
    tail: `${why}${tail ? `\n${tail}` : ''}`,
    tabId,
    cwd: ptyMgr.get(tabId)?.cwd
  })
}

/** Abandon a guided login: stop watching and kill its hidden pty. Used by the panel's
 *  cancel and whenever a second login starts. NOT used when the user asks to SEE the
 *  terminal — that promotes the same pty to a tab, so it must keep running. */
function cancelGuidedLogin(tabId: string): void {
  const w = loginWatchers.get(tabId)
  if (!w) return
  w.done = true
  loginWatchers.delete(tabId)
  try {
    ptyMgr.kill(tabId)
  } catch {
    /* already gone */
  }
}

/** Start the guided flow in a pty the renderer never learns about — no tab appears,
 *  and the user stays where they were. */
function startGuidedLogin(name: string): string {
  const handle = ptyMgr.create({
    kind: 'shell',
    cwd: os.homedir(),
    // A WIDE pty, because the CLI hard-wraps its output at the terminal width: at the
    // default 80 columns a ~108-char token arrives split across lines and the capture
    // stores a truncated credential that only fails later, at verification. Nobody is
    // looking at this terminal, so the width costs nothing. (If the user promotes it
    // to a visible tab, TerminalView's fit resizes it on attach.)
    cols: 800,
    rows: 50,
    setupCommand: setupLine(),
    launchCommand: 'claude setup-token'
  })
  loginWatchers.set(handle.id, { name, buf: '', startedAt: Date.now(), sawUrl: false, done: false })
  loginPtys.add(handle.id)
  sendLoginProgress({ phase: 'starting', name })
  return handle.id
}

async function completeLogin(tabId: string, name: string, token: string): Promise<void> {
  // Verify BEFORE storing. A truncated capture (the CLI hard-wrapping its output is
  // the way this happens — see the pty width in startGuidedLogin) still looks like a
  // token to the regex, and storing it first would leave a silently broken account
  // that only reveals itself later. A credential that cannot authenticate is not
  // worth keeping, so a failed probe here reports instead of writing.
  const result = await probeAccount('oauth', token, { timeoutMs: 10_000 })
  if (!result.ok && result.error === 'expired') {
    sendLoginProgress({
      phase: 'failed',
      name,
      tail:
        'The captured token was rejected — usually that means the capture was incomplete. ' +
        'Use “Paste token” instead, or “Show terminal” to see the raw output.',
      tabId,
      cwd: ptyMgr.get(tabId)?.cwd
    })
    return
  }
  const stored = await keychainWrite('oauth', name, token)
  if (!stored) return
  // re-auth of an existing row keeps the user's own choices (enabled) and its place in
  // the list; only the credential and the health it implies are replaced
  const prev = findAccount(name, 'oauth')
  upsertAccountMeta({
    name,
    kind: 'oauth',
    enabled: prev ? prev.enabled : true,
    fable: result.ok && result.fable ? result.fable : (prev?.fable ?? 'unknown'),
    // carry the previous §08 stamp through the rewrite; the conclusive verdict below
    // re-stamps via recordFableCapability — the single home of the clock policy
    ...(prev?.fableCheckedAt !== undefined ? { fableCheckedAt: prev.fableCheckedAt } : {}),
    status: result.ok ? 'ok' : 'unverified',
    addedAt: prev?.addedAt ?? Date.now()
  })
  if (result.ok && result.fable) recordFableCapability(name, 'oauth', result.fable)
  const key = viewKey(name, 'oauth')
  if (result.ok) {
    usageViews.set(key, { usage: result.usage })
    if (result.usage) picker.cacheUsage('oauth', name, result.usage)
  } else {
    usageViews.set(key, { probeError: result.error })
  }
  pushAccounts()
  sendLoginProgress({ phase: 'saved', name })
  // the pty is hidden and its only job is done — killing it takes the printed token
  // down with the process, so there is no scrollback left holding a credential
  try {
    ptyMgr.kill(tabId)
  } catch {
    /* already gone; the account is saved either way */
  }
}

/** settings-panel probe path (10s budget, all enabled accounts, both kinds).
 *  Single-flighted: three surfaces now reach this — the startup round (D9), opening
 *  Settings, and the capsule's own refresh — and they overlap easily (hovering the
 *  capsule while the startup round is still in flight is one hover away). Every
 *  extra round is a real billed request per account, so callers coalesce onto the
 *  one already running rather than each starting their own. */
let probeAllInFlight: Promise<AccountView[]> | null = null

function probeAllForPanel(): Promise<AccountView[]> {
  if (probeAllInFlight) return probeAllInFlight
  // the promise STORED in the latch must be the same object the cleanup compares
  // against (accountPicker.ts documents the same trap): a `.finally()` chain would
  // store a different one, the identity check would never match, and the latch would
  // wedge — after which no surface could ever probe again.
  const round = (async (): Promise<AccountView[]> => {
    const enabled = listAccounts().filter((a) => a.enabled)
    await Promise.all(
      enabled.map(async (a) => {
        const secret = await keychainRead(a.kind, a.name)
        if (!secret) return
        // the same §08 downgrade as the pick path — the panel's ↻ is still a routine
        // probe; only add/re-auth (explicit capability re-checks) stay fable-first.
        // baseUrl/model matter for 'custom' rows: without them the probe would post
        // the third-party bearer token to api.anthropic.com
        const result = await probeAccount(a.kind, secret, {
          timeoutMs: 10_000,
          skipFable: shouldSkipFable(a, Date.now()),
          baseUrl: a.baseUrl,
          model: a.model
        })
        foldProbeResult(a.name, a.kind, result)
      })
    )
    pushAccounts()
    return accountViews()
  })()
  probeAllInFlight = round
  const release = (): void => {
    if (probeAllInFlight === round) probeAllInFlight = null
  }
  void round.then(release, release)
  return round
}

async function addAccount(
  name: string,
  kind: AccountKind,
  secret: string,
  endpoint?: { baseUrl?: string; model?: string }
): Promise<AccountAddResult> {
  const v = validateNewAccount(name, kind)
  if (v !== 'ok') return { ok: false, error: v }
  const trimmed = typeof secret === 'string' ? secret.trim() : ''
  if (!trimmed) return { ok: false, error: 'unknown' }
  // a custom endpoint is only meaningful with a URL, and that URL reaches a shell
  // export — validate here, not just in the renderer
  const baseUrl = endpoint?.baseUrl?.trim()
  const model = endpoint?.model?.trim() || undefined
  if (kind === 'custom' && !isHttpUrl(baseUrl)) return { ok: false, error: 'invalid-endpoint' }
  if (!(await keychainWrite(kind, name, trimmed))) return { ok: false, error: 'unknown' }
  // verify — one probe doubles as validity check + fable detection + first usage read.
  // Failure still saves the account as 'unverified' (offline add), badge says so.
  const result = await probeAccount(kind, trimmed, { timeoutMs: 10_000, baseUrl, model })
  const meta: AccountMeta = {
    name,
    kind,
    enabled: true,
    fable: result.ok && result.fable ? result.fable : 'unknown',
    status: result.ok ? 'ok' : 'unverified',
    addedAt: Date.now(),
    ...(kind === 'custom' ? { baseUrl, model } : {})
  }
  upsertAccountMeta(meta)
  // the add-time verify is fable-first and conclusive — a 'no' starts the §08 weekly
  // clock; routed through recordFableCapability, the single home of the clock policy
  if (result.ok && result.fable) recordFableCapability(name, kind, result.fable)
  const key = viewKey(name, kind)
  if (result.ok) usageViews.set(key, { usage: result.usage })
  else usageViews.set(key, { probeError: result.error })
  pushAccounts()
  const account = accountViews().find((a) => a.kind === kind && a.name === name)
  return result.ok ? { ok: true, account } : { ok: false, error: result.error, account }
}

// privileged custom schemes: `koloft-file` serves local files into <webview>/<img>, `crx`
// serves extension action icons into the address bar's action row (the extension library
// registers it too, but only when imported before the app is ready — this one is)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'koloft-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  },
  { scheme: 'crx', privileges: { bypassCSP: true } }
])

/**
 * Test-only seam (KOLOFT_FILE_DIALOG_FILE, unset in production): answer the open dialog from
 * a file instead of raising a native panel. An e2e run launches as a background accessory
 * app, so a native modal would take focus and then hang with nothing able to dismiss it —
 * yet ⌘T's "Open file…" is the ONLY way to make a `file` tab, so four Workbench cases
 * (WB-T11/T19, WB-R01, WB-K02) cannot be written without it.
 *
 * The file is a queue, one absolute path per line, consumed head-first: a case that opens
 * nine files in a row queues nine paths once. Absent or exhausted reads as "the user
 * cancelled", which is both the safe default and the answer WB-K02 asserts.
 */
function takeQueuedPick(queueFile: string): string | null {
  let queued: string[]
  try {
    queued = fs
      .readFileSync(queueFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return null // nothing queued — the user cancelled
  }
  const picked = queued.shift()
  if (!picked) return null
  try {
    if (queued.length) fs.writeFileSync(queueFile, queued.join('\n') + '\n')
    else fs.rmSync(queueFile, { force: true })
  } catch {
    // an unwritable queue only means the next call answers the same path again
  }
  return picked
}

function mimeOf(p: string): string {
  const map: Record<string, string> = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.txt': 'text/plain'
  }
  return map[extOf(p)] || 'application/octet-stream'
}

/** the privileged bridge (pty spawn + account tokens) — the host window's alone, which
 *  is also what the guest attach guard measures a webview's `preload` against */
function hostPreload(): string {
  return path.join(__dirname, '../preload/index.js')
}

/** pty ids the reload teardown killed itself. Their exits must NOT be broadcast:
 *  did-start-navigation fires while the OLD document is still running (it lives
 *  until the new one commits), and hearing its own utility shell die makes it act on
 *  a close it never asked for — in the island era, persisting an EMPTY strip over the
 *  very state the next renderer was about to restore from. */
const teardownKilledPtys = new Set<string>()

/** The renderer's document is going away (hard reload, crash recovery, or window
 *  close) while main keeps the ptys. One teardown for every path (M8):
 *  drop what died with the document (watchers, flow accounting), snapshot what the
 *  next renderer re-adopts, and reap what nobody can adopt. Attention markers are
 *  deliberately KEPT — adopted tabs come back under the SAME pty ids, so the
 *  markers stay joinable and the dock badge survives the reload (decision ②). */
function rendererTeardown(): void {
  // no document means nowhere to put a run's tab. Dues that land from here on are
  // held until the next `tabs:list`, and go missed if that takes too long.
  rendererReady = false
  cronRunner?.onRendererTeardown()
  closeAllDirWatchers()
  closeAllFileWatchers()
  resetAllFlow()
  overlayListenerLost()
  // decision ③: remember the tab the user was on for the adoption reply; the live slot
  // goes null as before — no renderer is watching anything right now. Only a REAL
  // report may overwrite the snapshot: window close → reopen runs this teardown
  // twice ('closed', then the new window's initial navigation), and the second pass
  // sees uiActiveTabId already null — clobbering the snapshot the reopen boot is
  // about to consume. The slot is one-shot (tabs:list clears it), so keeping a
  // stale value can never outlive one boot.
  if (uiActiveTabId !== null) activeTabBeforeReload = uiActiveTabId
  uiActiveTabId = null
  dirtyTabIds.clear() // the document that reported those unsaved edits is gone
  // decision ④: nothing brings a shell back (D4), so an old one would simply leak
  for (const h of ptyMgr.list()) if (h.util) teardownKilledPtys.add(h.id)
  ptyMgr.killUtilOrphans()
  ptyMgr.reapDead()
}

function createWindow(): void {
  // reopen with the last session's geometry (validated against the connected
  // displays); fullscreen re-enters its Space directly, maximize re-applies below
  const geo = restoredWindowGeometry()
  mainWindow = new BrowserWindow({
    ...geo.bounds,
    minWidth: windowMinWidth(geo.bounds.width),
    minHeight: 560,
    // background test mode never enters fullscreen: it would grab a whole macOS Space
    ...fullscreenOption(geo.fullScreen && !BACKGROUND_TEST),
    show: !BACKGROUND_TEST,
    title: 'Koloft',
    backgroundColor: '#0e0e10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: hostPreload(),
      sandbox: false,
      contextIsolation: true,
      webviewTag: true,
      // a hidden test window must keep rAF + timers running (this also pins the Page
      // Visibility API to 'visible') — xterm's renderer queues frames on rAF, and a
      // throttled renderer would stall the whole suite
      backgroundThrottling: !BACKGROUND_TEST
    }
  })
  // SEC-2: this window runs Koloft's own preload (terminal:create, settings:get/set with
  // the account tokens) and Electron re-injects it after every navigation, so a single
  // hop onto a remote origin hands that bridge to the page. It may only ever be on the
  // document it was launched with, and it may not spawn a window at all — a link that
  // wants one is the Browser's job (D12), never a second privileged renderer.
  const appUrl = rendererUrl()
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // SEC-5/SEC-6: every guest is created through one factory — enforced here rather than
  // believed, since this is the only point that sees a <webview>'s preferences before it
  // has a renderer. A tag that named no browser partition never attaches at all.
  mainWindow.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    if (!enforceGuestAttach(webPreferences, params, hostPreload())) e.preventDefault()
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isAppNavigation(url, appUrl)) e.preventDefault()
  })
  // Background test mode: the window is NEVER shown — even an inactive window draws
  // over the user's current app (worst on a fullscreen Space). CDP drives layout,
  // input, and assertions without the window ever reaching the screen; maximize()
  // is skipped because it force-shows a hidden window on macOS.
  if (!BACKGROUND_TEST && geo.maximized && !geo.fullScreen) mainWindow.maximize()
  // pin maximized/fullScreen in background mode: this hidden window never enters
  // either, and writing live false values would clobber a real user's saved state
  // when the run shares userData (manual `KOLOFT_TEST_BACKGROUND=1 npm run dev`)
  trackWindowState(
    mainWindow,
    BACKGROUND_TEST ? { maximized: geo.maximized, fullScreen: geo.fullScreen } : undefined
  )

  // a hard reload (Cmd+R in dev) destroys the renderer without running React effect
  // cleanup, so drop stale fs watchers here; the renderer re-watches on remount.
  // Flow gates reset for the same reason: their unacked inflight died with the
  // renderer, and stale accounting would strand a pty's output held (or the pty
  // paused) forever. TerminalViews re-attach on remount.
  // Read off the host's own navigation, never off `did-start-loading`: a <webview> is a
  // frame of this document, so every page a Browser guest loads spins the embedder's
  // loading state too — and this teardown would then drop the session's watchers and
  // main's active-tab report (the tab a popup lands in, D12) on every page view.
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    rendererTeardown()
  })
  mainWindow.on('closed', () => {
    // same teardown as a reload (M8): on macOS the app outlives the window,
    // the ptys live on, and the next window's renderer re-adopts them — the two paths
    // must leave main in the same state
    rendererTeardown()
    // drop the reference so post-close timers see null and short-circuit in sendToRenderer
    mainWindow = null
  })
  // M1: a crashed renderer never navigates on its own — without this reload
  // the window stays dead and every session orphans (the production half of the issue).
  // The guard stops a renderer that crashes on boot from reloading forever; past the
  // cap the window stays down and the Force Close remains the way out.
  const crashReloads: number[] = []
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    if (!allowCrashReload(crashReloads, now)) {
      // crash loop: the window stays down, but main must not keep serving a dead
      // renderer — without this, watchers, attached flow gates, orphan util shells
      // and a non-null uiActiveTabId (wrongly suppressing attention) all persist
      rendererTeardown()
      return
    }
    crashReloads.push(now)
    // reload() is a real navigation, so did-start-navigation runs the same teardown
    // as a dev reload — one recovery path, not two. The webContents can already be
    // destroyed when the crash races an app quit — nothing to recover then.
    if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.reload()
  })
  // A minimized or fully occluded window's WebGL drawing buffers can be discarded by
  // Chromium with NO event (no webglcontextlost, no display change) — coming back
  // shows stale/blank static rows until something repaints. Repair on un-minimize
  // always; on plain refocus only after a long blur, because a cmd-tab flurry would
  // otherwise pay the full atlas wipe + re-rasterize on every switch.
  const WEBGL_REPAIR_BLUR_MS = 30_000
  let blurredAt = 0
  mainWindow.on('restore', requestWebglRepair)
  // refocusing the window while a pending tab is frontmost counts as "looked at it";
  // blurring is a switch-away — give a just-suppressed event its stale-context check
  mainWindow.on('focus', () => {
    // D5: the renderer's focus ring needs the WINDOW's focus, which the host document
    // cannot read while a guest page holds the caret (see `windowFocus` in types.ts)
    sendToRenderer('window:focus', true)
    if (blurredAt && Date.now() - blurredAt > WEBGL_REPAIR_BLUR_MS) requestWebglRepair()
    blurredAt = 0
    if (uiActiveTabId) {
      consumeOutletDedupe(uiActiveTabId)
      attention.clear(uiActiveTabId)
    }
    // coming back to Koloft is when a stale behind-badge is most likely (the user just
    // pulled in an external terminal) — the idle app has no other refresh trigger
    void freshness?.sweep()
  })
  mainWindow.on('blur', () => {
    sendToRenderer('window:focus', false)
    blurredAt = Date.now()
    if (uiActiveTabId) attention.reconsider(uiActiveTabId, attentionCtx())
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/** The one document the host window is allowed to be on (SEC-2) — the dev server when
 *  one is running, the bundled renderer otherwise. */
function rendererUrl(): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  return devUrl || pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString()
}

app.whenReady().then(() => {
  protocol.handle('koloft-file', async (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname)
    // this serves any file this Mac's user can read. The roots-based fence that used
    // to stand here was removed with the assumption behind it (that a session stays in the
    // workspace it started in), and the window's own pages are the only ones on this
    // scheme — the built-in browser runs in its own partition, which never had it.
    try {
      const data = await fs.promises.readFile(filePath)
      return new Response(new Uint8Array(data), {
        headers: { 'content-type': mimeOf(filePath) }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  setupBrowserPartition()
  // after the partition, never before: the alias preload has to be registered on top of
  // the extension lib's own, which are registered on this session by its constructor
  setupExtensions({
    window: () => mainWindow,
    openTab: openExtensionTab,
    ask: (request) => sendToRenderer('ext:permission-request', request)
  })
  onExtensionsChanged(() => sendToRenderer('ext:changed'))
  setupBrowserAuth()
  setupCertErrors()
  setupGuestUnload()
  setupGuestPopups()
  setupGuestContextMenu()
  setupGuestAudio()
  setupGuestGestures()
  setupGuestLinkReports()
  setupPermissionCleanup()
  setupGuestBackgroundOpen()
  setupGuestAudioState()
  setupGuestFullscreen()

  // install the claude + open shims and watch the dirs they drop registrations into
  const { shimDir, regDir, openDir, pickDir } = setupShim()
  ptyMgr.shimDir = shimDir
  ptyMgr.regDir = regDir
  watchRegistrations(regDir)
  // Only hand tabs KOLOFT_OPEN_DIR when the watcher is actually live: if fs.watch failed,
  // the shim must pass every open through instead of writing requests nobody reads.
  // The sweep (after the watch, so no gap) delivers near-live requests dropped while
  // no watcher ran — e.g. a shim racing an app relaunch after a crash.
  if (watchOpenRequests(openDir)) {
    ptyMgr.openDir = openDir
    sweepOpenRequests(openDir)
  }
  // multi-account pick channel: same watcher gate as opens (no watcher → no env → the
  // shim never waits on requests nobody reads). Mode policy lives in the ANSWER, not
  // in env presence, so toggling multiAccount reaches already-open tabs instantly.
  if (watchPickRequests(pickDir)) {
    ptyMgr.pickDir = pickDir
    ptyMgr.multiAccountOn = () => loadSettings().multiAccount
  }

  // P1: the browser-control endpoint. The relay owns the socket; everything it
  // needs from the app is handed in here, so nothing in it reaches for the renderer,
  // the tracker or the settings store directly.
  ptyMgr.cdpDir = cdpEnvDir()
  startRelay(relayDeps())
  setRelayEnabled(loadSettings().browserControl, ptyTabIds())

  // install the SessionStart hook Koloft injects into each claude (via --settings) and
  // watch the dir it reports authoritative tab→session bindings into. This is what
  // makes in-TUI /resume and multiple tabs in one cwd bind correctly.
  const hookPaths = setupHooks()
  // the vendored ccstatusline rides the same per-tab --settings file; the toggle is
  // read per tab creation, so flipping it applies to new sessions without a restart
  const statusline = setupStatusline()
  ptyMgr.makeHookSettings = (tabId) =>
    writeTabHookSettings(
      hookPaths,
      tabId,
      loadSettings().statuslineBuiltin ? statusLineSetting(statusline) : undefined
    )
  watchHookRegistrations(hookPaths.regDir)

  // Batch high-frequency pty output: during a heavy task node-pty emits many tiny
  // chunks; coalescing them per ~frame collapses thousands of IPC messages (each
  // a structured-clone round trip + a term.write) into a few, keeping the renderer
  // responsive. Per-id order is preserved by appending to that id's buffer.
  const pendingData = new Map<string, string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flushData = (): void => {
    flushTimer = null
    for (const [id, data] of pendingData) {
      const gate = flowGateFor(id)
      if (!gate.maySend()) {
        // renderer is behind: HOLD this tab's output here (it keeps coalescing) and
        // let the backstop decide whether the backlog is big enough to pause the pty.
        // The ack handler pumps it back out — a finished child produces no further
        // 'data' events to arm this timer, so the pump cannot rely on new output.
        gate.onBacklog(data.length)
        continue
      }
      if (!sendToRenderer('terminal:data', { id, data })) {
        // no live renderer: exactly the pre-gate app — output goes nowhere, the
        // child keeps running, and nothing may ever wait on an ack that can't come
        gate.reset()
        pendingData.delete(id)
        continue
      }
      gate.onForwarded(data.length)
      gate.onBacklog(0)
      pendingData.delete(id)
    }
  }
  resetAllFlow = (): void => {
    pendingData.clear()
    for (const gate of flowGates.values()) gate.reset()
  }
  flushHeldData = (): void => {
    if (!flushTimer) flushTimer = setTimeout(flushData, 0)
  }
  ptyMgr.on('data', (d: { id: string; data: string }) => {
    if (loginWatchers.size) feedLoginWatcher(d.id, d.data)
    pendingData.set(d.id, (pendingData.get(d.id) ?? '') + d.data)
    if (!flushTimer) flushTimer = setTimeout(flushData, 16)
  })
  ptyMgr.on('process-title', (t: { id: string; name: string }) => {
    sendToRenderer('terminal:processTitle', t)
  })
  // R19: the shell `cd`ed. Purely a label — a terminal tab is never persisted, so
  // nothing about this reaches disk.
  ptyMgr.on('cwd', (c: { id: string; cwd: string }) => {
    sendToRenderer('terminal:cwd', c)
  })
  ptyMgr.on('exit', (e) => {
    loginPtys.delete(e.id)
    // a shell the reload teardown killed itself: swallow the exit instead of
    // broadcasting it — the old document is still running mid-navigation and would
    // process its own shell's death as if the user had closed something.
    // Everything below is moot for it: flow was reset in the same teardown, a util
    // shell holds no attention marker, hook log, tracker entry or pending launch.
    if (teardownKilledPtys.delete(e.id)) {
      flowGates.get(e.id)?.reset()
      flowGates.delete(e.id)
      return
    }
    // the guided-login pty exited without ever printing a token — report it with the
    // tail rather than leaving the panel spinning on a process that is already gone
    if (loginWatchers.has(e.id)) failLogin(e.id, 'setup-token exited without printing a token')
    // A clean /exit is a race main used to lose. The SessionEnd hook lands in a file a
    // watcher picks up milliseconds later, but a session pty runs `exec claude` (§9), so
    // the pty dies WITH claude and the renderer tears the tab down — killing the handle
    // — before that watcher fires. handleHookRegistration then refuses the report as an
    // "already-closed tab" and the session never leaves the working set, contradicting
    // the lifecycle contract D1: the user said they were done, and the row stayed as a cold one.
    // claude waits for its own hooks, so the file is complete by the time the pty dies:
    // read it HERE, while the handle is still alive. A later watcher delivery of the
    // same file is a no-op (the tab is untracked by then).
    const remoteTab = tracker.remoteOf(e.id)
    // a remote tab's hook files live in the machine's MIRROR, which rsync owns: the
    // local reg dir has nothing of its, and deleting from the mirror would only make
    // the next round copy it back and replay every status line from offset zero
    if (!remoteTab) {
      drainExitRegistration(hookPaths.regDir, e.id)
      dropStatusLog(hookPaths.regDir, e.id) // its run-state log has no further readers
    }
    attention.clear(e.id) // dead tab can't need attention
    sessionEndSeen.delete(e.id)
    flushData() // deliver any buffered output before the exit notification
    // a blocked tab's held tail must survive its gate: forward it unconditionally —
    // it is bounded (≤ the backstop watermark), far under xterm's ~50MB discard cap
    const held = pendingData.get(e.id)
    if (held !== undefined) {
      pendingData.delete(e.id)
      sendToRenderer('terminal:data', { id: e.id, data: held })
    }
    flowGates.get(e.id)?.reset()
    flowGates.delete(e.id)
    tracker.setAlive(e.id, false)
    if (codexSessions?.hasTab(e.id))
      void codexSessions
        .stop(e.id, e.signal ? -1 : e.exitCode)
        .catch((error) => sendToRenderer('cron:toast', String(error)))
    if (remoteTab) {
      // the pty IS the remote session's lifetime here: there is no process table to
      // probe, and the row turns cold at once. Its SessionEnd, though, is still on the
      // machine and arrives with the next mirror pull — that is what tells a `/exit`
      // (the user said they were done: the row leaves the working set, the lifecycle contract D1)
      // from a tab merely closed.
      const sid = sessionIdOf(e.id)
      untrackSession(e.id)
      fs.rmSync(tabPackageDir(app.getPath('userData'), e.id), { recursive: true, force: true })
      void drainRemoteExit(
        remoteTab.host,
        mirrorHookDir(app.getPath('userData'), remoteTab.host),
        e.id,
        sid
      )
    }
    // Cancel, or claude dying before it ever bound: the pending row goes with the pty
    workspaceMgr?.launchEnded(e.id)
    // a scheduled run's pty is gone — closed by the person, or dead. Both look
    // the same from here, and both end the run.
    cronRunner?.onPtyExit(e.id)
    sendToRenderer('terminal:exit', e)
  })
  tracker.on('update', (sessions: SessionInfo[]) => {
    sendToRenderer('sessions:update', allSessions())
    // running-set changes (bind / exit / untrack) re-flag the aggregated rows
    workspaceMgr?.onTrackerUpdate()
    // §4.4: a tab that changed session (a restart, /clear, an in-TUI /resume) keeps
    // its endpoint — what a connected client sees is one tab set leave and another
    // arrive, never a dropped connection.
    const seen = new Set<string>()
    for (const s of sessions) {
      seen.add(s.tabId)
      const before = boundSessions.get(s.tabId)
      if (before === s.sessionId) continue
      boundSessions.set(s.tabId, s.sessionId)
      relayTabRebound(s.tabId, s.sessionId || null)
    }
    for (const tabId of [...boundSessions.keys()]) {
      if (seen.has(tabId)) continue
      boundSessions.delete(tabId)
      relayTabRebound(tabId, null)
    }
  })
  // R8/R9 — claude moved this session into another checkout and Koloft followed it
  // there. The renderer decides whether to say so: only the conversation the user is
  // looking at gets a word, because that is the only Workbench that actually moved.
  tracker.on('relocated', (e: { tabId: string; dir: string }) => {
    sendToRenderer('session:relocated', e)
  })
  // the session sat idle long enough and every guard said yes. Tell the renderer
  // BEFORE killing: the other way round it sees a pty die under a tab it still has and
  // says the session exited unexpectedly, which is the one thing this silent path
  // must not do.
  tracker.on('auto-close', ({ tabId }: { tabId: string }) => {
    sendToRenderer('tab:killedByMain', tabId)
    killTabPty(tabId)
  })
  tracker.on(
    'status',
    (t: { tabId: string; prev: SessionStatus | undefined; next: SessionStatus }) => {
      attention.onStatusChange(t.tabId, t.prev, t.next, attentionCtx(), sessionTitleOf(t.tabId))
      // "the turn ended" is read from THIS edge, not from the attention tracker —
      // attention swallows the event while the person is watching that very tab, and a
      // run they happened to be looking at would then never reach "done".
      cronRunner?.onStatus(t.tabId, t.prev, t.next)
    }
  )

  // Liveness fallback for the SessionEnd hook. The hook reverts a tab to a plain
  // terminal the instant claude exits in-TUI — but it only fires on a *graceful*
  // exit (/exit, Ctrl+D, logout). A hard exit (Ctrl+C kill, crash, SIGTERM) leaves
  // no SessionEnd, so the tab would stay "claude" forever (the intermittent "didn't
  // revert" bug). Independently of the hook, poll whether each *bound* claude tab
  // still has a live `claude` process in its shell; once it's gone — confirmed on a
  // second sweep, to ride out a transient ps glitch — untrack it so the tab reverts.
  // Unix only, matching the bash shim/hooks. The shell pty itself lives on untouched.
  if (process.platform !== 'win32') {
    const goneStrikes = new Map<string, number>()
    let sweeping = false // skip a tick if the previous ps spawn is still in flight
    const sweepLiveness = async (): Promise<void> => {
      if (sweeping) return
      sweeping = true
      try {
        // Only sessions that have actually bound (jsonlPath set ⇒ claude definitely
        // ran) and whose shell is still alive. A not-yet-bound tab is mid-launch,
        // where claude may not be visible yet — never untrack it on a transient absence.
        const pidByTab = new Map<string, number>()
        for (const s of tracker.list()) {
          // a remote claude runs on another machine — this Mac's process table cannot
          // see it, and a miss here would untrack every remote session on the first tick
          if (!s.alive || !s.jsonlPath || s.remote) continue
          const pid = ptyMgr.pidOf(s.tabId)
          if (pid) pidByTab.set(s.tabId, pid)
        }
        for (const tabId of [...goneStrikes.keys()]) {
          if (!pidByTab.has(tabId)) goneStrikes.delete(tabId) // out of scope: reset
        }
        if (!pidByTab.size) return // no claude sessions to probe — skip the ps spawn
        const alive = await rootsWithClaude([...pidByTab.values()])
        if (!alive) return // ps probe failed this round — never untrack on unknown state
        for (const [tabId, pid] of pidByTab) {
          if (alive.has(pid)) {
            goneStrikes.delete(tabId)
            continue
          }
          const strikes = (goneStrikes.get(tabId) ?? 0) + 1
          if (strikes >= 2) {
            goneStrikes.delete(tabId)
            // a hard exit is only worth the user's attention if no RECENT SessionEnd
            // fired — an ambiguous-reason SessionEnd whose confirm probe failed
            // still lands here shortly after, and alerting on it would be a false
            // alarm for an exit the user performed themselves. A STALE entry (the
            // probe found claude alive and the session kept running) must not
            // suppress a genuine kill -9 long after, hence the TTL.
            const endSeenAt = sessionEndSeen.get(tabId)
            if (endSeenAt === undefined || Date.now() - endSeenAt > SESSION_END_SEEN_TTL_MS) {
              attention.onExited(tabId, attentionCtx(), sessionTitleOf(tabId))
            }
            sessionEndSeen.delete(tabId)
            untrackSession(tabId) // claude gone, shell pty lives on → revert to terminal
          } else {
            goneStrikes.set(tabId, strikes)
          }
        }
      } finally {
        sweeping = false
      }
    }
    // .unref() so this background timer never holds the app open during shutdown
    setInterval(() => void sweepLiveness(), 2500).unref()
  }

  // layout v3 + aggregation: constructed here because loading the layout (and the
  // one-shot v2/v1 migration inside it) needs app.getPath('userData')
  const userData = app.getPath('userData')
  try {
    codexSessions = new CodexSessions(path.join(userData, 'sessions.json'), {
      pty: ptyMgr,
      projectInfo: projectInfoFor,
      changed: () => {
        sendToRenderer('sessions:update', allSessions())
        workspaceMgr?.onRemoteChanged()
      },
      attention: (tabId, kind) => {
        if (kind === 'clear') attention.clear(tabId)
        else attention.onEvent(tabId, kind, attentionCtx(), sessionTitleOf(tabId))
      },
      error: (message) => sendToRenderer('cron:toast', message)
    })
  } catch (error) {
    codexStartupError = `Codex session data could not be loaded; the original file is preserved. ${String(error)}`
  }
  if (codexSessions) {
    sessionBackends.register({
      id: 'codex',
      list: () => codexSessions!.list(),
      create: async (opts) => ({ ok: true, ...(await codexSessions!.launch(opts)) }),
      // Codex says why a resume cannot happen ("run codex unarchive …"); a rejected IPC
      // would reach the user as the generic "Resume failed" instead.
      resume: async (req) => {
        try {
          return { ok: true, kind: 'codex', ...(await codexSessions!.resume(req)) }
        } catch (error) {
          return {
            ok: false,
            code: 'backend',
            message: error instanceof Error ? error.message : String(error)
          }
        }
      },
      archive: (key) => codexSessions!.archive(key),
      transcriptExists: (key) => codexSessions!.transcriptExists(key)
    })
    // one probe at start; without Codex installed nothing else starts a login shell
    void codexSessions
      .availability()
      .then((codex) => (codex.available ? codexSessions!.refreshHistory() : undefined))
      .catch((error) => sendToRenderer('cron:toast', String(error)))
  }
  workspaceMgr = new WorkspaceManager({
    additionalRows: (wsPath) => codexSessions?.rows(wsPath) ?? [],
    additionalMembers: () => codexSessions?.members() ?? new Set(),
    projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
    loadLayout,
    saveLayout,
    projectInfo: projectInfoFor,
    runningBindings: () => {
      // tracker order = track() order = launch order; only bound live ptys count
      const m = new Map<string, string>()
      for (const s of allSessions()) if (s.alive && s.sessionId) m.set(s.sessionId, s.tabId)
      for (const [key, tabId] of codexSessions?.runningBindings() ?? []) m.set(key, tabId)
      return m
    },
    killTab: (tabId) => killTabPty(tabId),
    liveSessions: () => {
      const m = new Map<string, LiveSession>()
      for (const s of tracker.list()) {
        if (!s.alive || !s.sessionId) continue
        m.set(s.sessionId, {
          treeRoot: s.treeRoot,
          worktree: s.worktree,
          remote: !!s.remote,
          relocated: s.relocated
        })
      }
      return m
    },
    pushRows: (payload) => sendToRenderer('workspace:rows', payload),
    freshness: (wsPath) => freshness?.get(wsPath),
    // every pin and unpin ends in a rescan, so this is the one place the mirror
    // watchers have to follow the pinned machines from
    onRescanned: (wsPaths) => {
      void freshness?.refreshLocal(wsPaths)
      watchRemoteHookMirrors()
    },
    // read live: the runner is built a few lines below, and a workspace can be
    // removed long after that
    jobCountFor: (wsPath) => cronRunner?.jobCountFor(wsPath) ?? 0,
    remoteProjectsRoot: (host) => mirrorProjectsRoot(userData, host),
    remoteRunning: (host) => remoteSync?.alive(host) ?? new Set(),
    remoteConnected: (host) => remoteSync?.connected(host) ?? false,
    remoteGit: (host, p) => remoteSync?.gitInfo(host, p),
    killRemoteSession: (host, sessionId) => {
      void runSsh(host, killSessionCmd(tmuxSessionName(sessionId)), {
        controlDir: remoteControlDir
      }).then(() => remoteSync?.pokeNow(host))
      killedRemoteSessions.add(sessionId)
    }
  })
  remoteSync = new RemoteSync({
    run: (host, cmd) => runSsh(host, cmd, { controlDir: remoteControlDir }),
    rsync: (host, r, l, extra) => rsyncPull(host, r, l, extra, { controlDir: remoteControlDir }),
    targets: () => {
      const live = new Set(
        tracker
          .list()
          .filter((sess) => sess.alive && sess.remote)
          .map((sess) => sess.remote!.host)
      )
      return (workspaceMgr?.remoteTargets() ?? []).map((t) => ({
        host: t.host,
        mirrorProjectsRoot: mirrorProjectsRoot(userData, t.host),
        mirrorHookDir: mirrorHookDir(userData, t.host),
        paths: t.paths,
        hasTabs: live.has(t.host)
      }))
    },
    onChange: () => workspaceMgr?.onRemoteChanged()
  })
  freshness = new GitFreshnessEngine({
    workspaces: () => workspaceMgr?.pinnedPaths() ?? [],
    // read live: the switch takes effect on the next trigger, no restart
    autoFetch: () => loadSettings().gitAutoFetch,
    onChange: () => workspaceMgr?.restampLive()
  })
  workspaceMgr.start()
  freshness.start()
  // the heartbeat's ssh fires right away, and its shared master needs the control dir
  // before the first launch builds it
  ensureControlDir(remoteControlDir)
  remoteSync.start()

  // after start(), never before — the store drops a job whose workspace is not
  // pinned, and the pinned list is only real once the layout has loaded.
  const cronFile = cronFilePath(userData)
  const cronFs = {
    readFile: (p: string) => fs.readFileSync(p, 'utf8'),
    writeFile: (p: string, s: string) => fs.writeFileSync(p, s),
    rename: (a: string, b: string) => fs.renameSync(a, b)
  }
  cronRunner = new CronRunner({
    now: () => Date.now(),
    bootTime: BOOT_TIME,
    store: {
      load: () => {
        // missing pins included: a job whose folder vanished is reported when it fires,
        // never dropped silently at load
        const pinned = (workspaceMgr?.pinnedPaths() ?? []).map((w) => w.path)
        return loadCron(cronFs, cronFile, pinned)
      },
      save: (jobs) => saveCron(cronFs, cronFile, jobs)
    },
    // read live, never captured: a workspace pinned after boot must be saveable at once.
    // Without this a job saves against an unpinned path, runs this session, and is
    // dropped by the loader on the next start — it looks saved and quietly is not.
    isPinned: (p) => (workspaceMgr?.pinnedPaths() ?? []).some((w) => w.path === p),
    dirExists: dirExistsSync,
    gitDirExists: gitDirExistsSync,
    worktreeDirExists: (root, name) => dirExistsSync(path.join(worktreeHomeOf(root), name)),
    branchExists: resumeProbes.branchExists,
    countRunFolders: countRunFoldersSync,
    accountUsable,
    trusted: claudeTrusts,
    ready: () => rendererReady && BrowserWindow.getAllWindows().length > 0,
    launch: launchCronRun,
    killTab: killTabPty,
    toast: (text) => sendToRenderer('cron:toast', text),
    notify: notifyPlain,
    push: (state) => sendToRenderer('cron:state', state),
    killed: (tabId) => sendToRenderer('tab:killedByMain', tabId),
    bindDeadlineMs: cronBindDeadlineMs(),
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout
  })
  cronRunner.start()

  registerIpc()
  // tab shortcuts (⌘T / ⌘W) route through the app menu to the renderer, where tabs live.
  // The keep-awake checkbox is the one item main answers itself: the setting is main's
  // to write, and the renderer learns of it through the same settings:update echo as any
  // other write.
  setupAppMenu(
    (action) => {
      if (action === 'toggle-keep-awake') {
        commitSettings({ keepAwake: !loadSettings().keepAwake })
        return
      }
      sendToRenderer(`shortcut:${action}`)
    },
    (cmd) => sendToRenderer('shortcut:browser', cmd),
    loadSettings().keepAwake
  )
  applyKeepAwake(loadSettings().keepAwake)

  // A focused <webview> guest (a page, or the html/pdf preview the user clicked into)
  // swallows the Browser's keys before they reach the app menu, so the accelerators
  // alone can't drive it from in there — ⌘T has no accelerator at all (IMPL-4/§03B).
  // Intercept them on the guest's own webContents and forward them to the host. PDFs
  // keep their native PDFium find (findInPage can't search the out-of-process plugin),
  // so that one keystroke passes through untouched.
  /** FR-53 — one place decides which channel a guest-forwarded key travels on. The three
   *  are not interchangeable: `shortcut:browser` is arbitrated by `commandTarget`
   *  against "is the active tab web", `shortcut:find` is the panel's one find bar, and
   *  `shortcut:workbench` is the tab strip's own. Routing by value here keeps that
   *  arbitration out of both guest listeners. */
  const sendGuestCommand = (cmd: ReturnType<typeof guestShortcut>): void => {
    if (!cmd) return
    if (cmd === 'find') sendToRenderer('shortcut:find')
    else if (cmd === 'cycle-next' || cmd === 'cycle-prev') {
      sendToRenderer('shortcut:workbench', cmd)
    } else sendToRenderer('shortcut:browser', cmd)
  }
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (!(input.meta || input.control)) return
      const cmd = guestShortcut(input)
      // FR-35: ⌘F inside a pdf keeps PDFium's native find (findInPage cannot search the
      // out-of-process plugin), so that one keystroke passes through untouched — checked
      // BEFORE the forward, since 'find' is now a guestShortcut answer rather than the
      // fall-through it used to be.
      if (cmd === 'find' && contents.getURL().toLowerCase().endsWith('.pdf')) return
      if (cmd) {
        // preventDefault is what keeps this single-carrier: a pre-handled key is never
        // forwarded on to the renderer, so the input-event fallback below stays silent
        event.preventDefault()
        sendGuestCommand(cmd)
      }
    })
    // …and the same keys again for a keystroke that never passed through the browser
    // process at all: an event injected straight into the guest's render process reaches
    // its DOM without ever pre-handling, so before-input-event alone would let a Browser
    // accelerator die inside the page.
    contents.on('input-event', (_event, input) => {
      if (input.type !== 'rawKeyDown') return
      const mods = input.modifiers ?? []
      const cmd = guestShortcut({
        key: (input as { key?: string }).key ?? '',
        meta: mods.includes('meta') || mods.includes('command') || mods.includes('cmd'),
        control: mods.includes('control') || mods.includes('ctrl'),
        shift: mods.includes('shift'),
        alt: mods.includes('alt')
      })
      // The same pdf exemption as above, and it is REQUIRED here rather than merely
      // symmetrical: the branch above deliberately does not `preventDefault` for a pdf, so
      // the keystroke reaches the render process and lands in this listener. Without the
      // guard ⌘F in a pdf opens Koloft's find bar on top of PDFium's own (FR-35).
      if (cmd === 'find' && contents.getURL().toLowerCase().endsWith('.pdf')) return
      if (cmd) sendGuestCommand(cmd)
    })
  })

  // OS resume, screen unlock, and display topology changes can silently invalidate GPU
  // texture memory: no webglcontextlost fires and the glyph atlas's page versions still
  // match, so the WebGL renderer keeps sampling dead textures (blank/garbled cells until
  // something forces a re-upload). Nudge the renderer to clear the atlas and repaint
  // (webglRepair.ts). Debounced — resume and display re-attach arrive as a burst.
  // The window-level edges (restore, long-blur refocus) wire up in createWindow.
  powerMonitor.on('resume', requestWebglRepair)
  powerMonitor.on('unlock-screen', requestWebglRepair)
  // a laptop that slept through the day wakes with counts from yesterday
  powerMonitor.on('resume', () => void freshness?.sweep())
  // a launch in the first half-minute after waking fails — the network, the
  // keychain and the file watches all need a moment. Ticks wait that long.
  powerMonitor.on('resume', () => cronRunner?.onResume())
  screen.on('display-added', requestWebglRepair)
  screen.on('display-removed', requestWebglRepair)
  screen.on('display-metrics-changed', requestWebglRepair)

  createWindow()
  startUpdateNotifier((offer) => sendToRenderer('update:offer', offer))

  // One probe round at startup (D9). `usageViews` is main-memory only, so a fresh
  // launch otherwise shows a blank capsule until something happens to probe — and
  // "how much quota is left" is a question people open the app to answer.
  // The gate is the CAPSULE's own render condition, not just the balancer flag: with
  // no enabled OAuth account the capsule returns null, and a metered-only pool would
  // otherwise pay a billed /v1/messages on every launch for a UI nobody sees.
  const capsuleVisible = (): boolean =>
    loadSettings().multiAccount && listAccounts().some((a) => a.enabled && a.kind === 'oauth')
  if (capsuleVisible()) {
    // fire-and-forget: nothing waits on it. Per-account probe failures are already
    // folded inside (they surface as an empty bar + "Not probed yet" in the panel);
    // what reaches this catch is structural — no Keychain, unreadable settings — and
    // degrades the same way every other structural failure in main does: silently,
    // into the state the UI already knows how to draw. Hovering the capsule retries.
    void probeAllForPanel().catch(() => {})
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/** file-edit B-26: armed when a quit is blocked, so a renderer that never answers cannot
 *  wedge the app shut. Cleared the moment the renderer says anything. */
let quitFallback: ReturnType<typeof setTimeout> | null = null
function clearQuitFallback(): void {
  if (quitFallback) clearTimeout(quitFallback)
  quitFallback = null
}

/**
 * Put the unsaved-changes question to the renderer and start counting. False means there
 * is no renderer to ask, so there is nothing unsaved either.
 *
 * The renderer answers quickly either way — it approves, or it says it is taking the
 * question; a workspace note still inside its autosave window costs it one local file
 * write first — so silence this long means it is wedged, and a wedged renderer
 * could not have written the file anyway.
 */
function askQuit(): boolean {
  if (!sendToRenderer('app:quit-requested')) return false
  clearQuitFallback()
  quitFallback = setTimeout(() => {
    quitFallback = null
    approveAndRun(() => app.quit())
  }, QUIT_ANSWER_GRACE_MS)
  return true
}
setQuitAsk(askQuit)

let codexQuitPending = false
let codexQuitStopped = false
app.on('before-quit', (e) => {
  // file-edit B-26 — this handler is synchronous and the question ("you have unsaved
  // files, now what?") is not, so quitting runs through here more than once: block and
  // ask, then let the second quit past once the answer is in. `quitGuard` holds the
  // whole decision; everything here is the parts that need Electron.
  const decision = quitDecision(Date.now())
  if (decision === 'wait') {
    // already asked and still waiting — block again, but do not ask twice
    e.preventDefault()
    return
  }
  if (decision === 'ask') {
    if (askQuit()) {
      e.preventDefault()
      return
    }
    approveQuit()
  }
  clearQuitFallback()
  if (!codexQuitStopped && codexSessions?.hasRuns()) {
    e.preventDefault()
    if (!codexQuitPending) {
      codexQuitPending = true
      // the window is going away, so a failure has no one left to tell — quit regardless
      void codexSessions
        .stopAll()
        .catch((error) => console.error('[koloft] Codex did not stop cleanly:', error))
        .finally(() => {
          codexQuitStopped = true
          app.quit()
        })
    }
    return
  }
  // write every open run down as "ended — Koloft quit" BEFORE stopping the clock,
  // so the next launch shows what happened instead of a run that seems to still be
  // going. Below the unsaved-files question on purpose: a quit that is blocked to ask
  // must not end the runs — the person may answer Cancel and keep working.
  cronRunner?.quitSweep()
  cronRunner?.stop()
  workspaceMgr?.dispose()
  freshness?.stop()
  remoteSync?.stop()
  closeAllDirWatchers()
  // The approval is spent on THIS quit. Anything that vetoes one after we have allowed it
  // would otherwise leave the latch open, and the next ⌘Q would skip the question.
  resetQuitGuard()
})

// re-prepend the shim dir after the user's rc files run (which may reorder PATH),
// then clear the noise. Quoted so a userData path with spaces is safe.
function setupLine(): string | undefined {
  if (!ptyMgr.shimDir) return undefined
  return `export PATH="${ptyMgr.shimDir}:$PATH"; hash -r 2>/dev/null; clear`
}

/** Read one just-dropped registration file and hand its parsed JSON to `handle`.
 *  A drop may be read mid-write, so a parse failure retries a few times first. */
function readJsonDrop(full: string, attempt: number, handle: (obj: unknown) => void): void {
  fs.readFile(full, 'utf8', (err, data) => {
    if (err) return
    let obj: unknown
    try {
      obj = JSON.parse(data)
    } catch {
      if (attempt < 3) setTimeout(() => readJsonDrop(full, attempt + 1, handle), 60)
      return
    }
    handle(obj)
  })
}

/** Shared skeleton for every shim/hook registration dir: watch `dir` for `*.json`
 *  drops and route each through `handlerFor(name)` (null skips the file). Returns
 *  null when the watch could not be established. */
function watchJsonDrops(
  dir: string,
  handlerFor: (name: string) => ((obj: unknown, full: string) => void) | null
): fs.FSWatcher | null {
  try {
    return fs.watch(dir, (_event, filename) => {
      if (!filename) return
      const name = filename.toString()
      if (!name.endsWith('.json')) return
      const handle = handlerFor(name)
      if (!handle) return
      const full = path.join(dir, name)
      readJsonDrop(full, 0, (obj) => handle(obj, full))
    })
  } catch {
    return null // dir was created by setupShim/setupHooks; treat as watch failure
  }
}

function watchRegistrations(regDir: string): void {
  watchJsonDrops(regDir, () => handleRegistration)
}

function handleRegistration(raw: unknown): void {
  const obj = raw as {
    tabId?: string
    regId?: string
    sessionId?: string
    cwd?: string
    ts?: number
    mode?: string
  }
  if (!obj.tabId || !obj.regId) return
  if (processedRegIds.has(obj.regId)) return
  if (!ptyMgr.get(obj.tabId)) return // tab already gone / stale file
  processedRegIds.add(obj.regId)
  const cwd = obj.cwd && obj.cwd.length ? obj.cwd : os.homedir()
  // registration only opens the tab's entry; the jsonl comes from the SessionStart
  // hook (bindSession) — nothing is inferred from the shim's id/mode any more
  tracker.track(obj.tabId, cwd)
}

// The `open` shim drops one `<openId>.json` per intercepted target. Route it (D3) into
// the owning tab's Browser or viewer pane; when it can't be delivered (tab closed after
// the shim fired, orphaned drop from a dead instance, window gone — macOS keeps the app
// running after close, or the re-check fails), fall back to the OS default open so an
// intercepted call is never silently swallowed. A tab owned by another LIVE instance
// sharing this dir is left alone — that instance delivers it.
const processedOpenIds = new Set<string>()

function watchOpenRequests(openDir: string): fs.FSWatcher | null {
  return watchJsonDrops(openDir, () => (obj, full) => handleOpenRequest(obj as OpenDrop, full))
}

/** Deliver near-live requests that were dropped while no watcher ran (fs.watch only
 *  fires for new files). Anything older than a minute is long past its moment —
 *  surprise-opening it now would be worse than dropping it, so prune instead. */
function sweepOpenRequests(openDir: string): void {
  fs.readdir(openDir, (err, names) => {
    if (err) return
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const full = path.join(openDir, name)
      fs.stat(full, (e, st) => {
        if (e) return
        if (Date.now() - st.mtimeMs <= 60_000) {
          readJsonDrop(full, 0, (obj) => handleOpenRequest(obj as OpenDrop, full))
        } else {
          fs.rm(full, { force: true }, () => {})
        }
      })
    }
  })
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Hosts the user knowingly walked past a certificate warning for (SEC-8). In memory,
 *  for this process only — a restart asks again, and nothing about it reaches disk. */
const trustedCertHosts = new Set<string>()

/**
 * SEC-8/B6: certificate errors get Chrome's shape — the load fails, the surface paints
 * the interstitial, and only the user walking past it adds a host to the exception set.
 * The event is app-wide (Electron exposes no per-session one), so the partition check is
 * what confines the exceptions to guests: Koloft's own https (update check, account probes)
 * on the default session keeps Electron's default, which is to refuse.
 *
 * Decided here rather than in a session verify proc: Chromium caches that procedure's
 * answer per host, so a proc re-installed after the user continues is never consulted
 * again and the retry fails on the cached refusal.
 */
function setupCertErrors(): void {
  app.on('certificate-error', (event, contents, url, _error, _cert, callback) => {
    if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
    event.preventDefault()
    callback(certTrusted(trustedCertHosts, certHostOf(url)))
  })
}

/**
 * B8 — answers to page-permission prompts, per site and per permission, IN MEMORY for
 * this process only. Same posture as the certificate exceptions above (SEC-8): nothing
 * reaches disk, a restart asks again, and so no "revoke" surface has to exist.
 */
const permissionAnswers = new Map<string, boolean>()

/** A prompt the user has not answered yet. Keyed by its own id and carrying the guest
 *  it belongs to: the guest id is what survives the page it was asked about — reading
 *  a url back off a destroyed WebContents throws (measured), which is how an earlier
 *  revision leaked every pending prompt of a closed tab. */
interface PendingPermission {
  guestId: number
  origin: string
  permission: PermissionName
  answer: (granted: boolean) => void
}
const pendingPermissions = new Map<string, PendingPermission>()

/** Whether this site already answered for this permission in this run. */
function rememberedPermission(origin: string, permission: PermissionName): boolean | undefined {
  return permissionAnswers.get(permissionKeysFor(origin, permission)[0])
}

/**
 * Raise the prompt bar and hold the page's call until it is answered. A second request
 * from the SAME guest for the same permission joins the first rather than stacking a
 * bar behind it — a page that asks twice is common, and two identical bars are two
 * chances to answer differently. Joined per GUEST, never per origin: two tabs on one
 * site are two pages, and answering for one must not silently answer for the other.
 */
function askUserForPermission(
  guestId: number,
  origin: string,
  permission: PermissionName,
  callback: (granted: boolean) => void
): void {
  for (const pending of pendingPermissions.values()) {
    if (pending.guestId !== guestId || pending.permission !== permission) continue
    const first = pending.answer
    pending.answer = (granted) => {
      first(granted)
      callback(granted)
    }
    return
  }
  const id = crypto.randomUUID()
  pendingPermissions.set(id, { guestId, origin, permission, answer: callback })
  sendToRenderer('browser:permission-ask', { id, origin, permission })
}

/** The user's word on one prompt. Remembered for the rest of the run (B8). */
function answerPermission(id: string, granted: boolean): void {
  const pending = pendingPermissions.get(id)
  if (!pending) return
  pendingPermissions.delete(id)
  for (const key of permissionKeysFor(pending.origin, pending.permission)) {
    permissionAnswers.set(key, granted)
  }
  pending.answer(granted)
}

/**
 * Take down prompts that can no longer be answered, and ANSWER their pages — a call
 * left hanging is a page frozen inside `getUserMedia` for the rest of the run, and an
 * entry left in the map swallows every later request that would have joined it.
 * Nothing is remembered: the user never said anything.
 */
function dropPermissions(match: (p: PendingPermission) => boolean): void {
  for (const [id, pending] of [...pendingPermissions]) {
    if (!match(pending)) continue
    pendingPermissions.delete(id)
    pending.answer(false)
    sendToRenderer('browser:permission-drop', id)
  }
}

/** Basic-auth challenges waiting on the user's answer, by the id the modal carries. */
const pendingAuth = new Map<string, (username?: string, password?: string) => void>()

/**
 * SEC-10: a guest's basic-auth challenge, answered in Koloft's own modal instead of a
 * native dialog. The event is app-wide (Electron exposes no per-session one), so the
 * partition check is what confines it to guests: a challenge to Koloft's own traffic keeps
 * Electron's default, which is to cancel.
 */
function setupBrowserAuth(): void {
  app.on('login', (event, contents, details, authInfo, callback) => {
    if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
    const prompt = authPromptFor(details, authInfo, modalSlotTaken())
    if (!prompt) return
    event.preventDefault()
    const id = crypto.randomUUID()
    pendingAuth.set(id, callback)
    const payload: BrowserAuthChallenge = { id, kind: 'auth', ...prompt }
    sendToRenderer('browser:auth-challenge', payload)
  })
}

/** Guests blocked inside window.alert/confirm/prompt, by the id their modal carries.
 *  Calling one back is what lets that page's JS run on (§05D-11). */
const pendingJsDialogs = new Map<string, (answer: BrowserDialogAnswer) => void>()

/** SEC-10/§05D-11: the surface renders ONE modal, and its two producers — a basic-auth
 *  challenge and a guest's alert/confirm/prompt — would otherwise paint over each other,
 *  stranding whichever request lost the slot with no way left to answer it. */
function modalSlotTaken(): boolean {
  return pendingAuth.size > 0 || pendingJsDialogs.size > 0
}

/**
 * §05D-11: a page may not refuse to be closed. Electron asks main whether a beforeunload
 * handler's cancel should stand and takes the answer synchronously — there is no moment
 * in which the user could be asked — and an unhandled event means "stay", so a guest
 * carrying a beforeunload handler aborts its own navigation and wedges its tab. Koloft
 * always proceeds: the page's handler still runs, it just cannot cancel. No native
 * dialog exists on this path either way.
 */
function setupGuestUnload(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('will-prevent-unload', (event) => {
      if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
      event.preventDefault()
    })
  })
}

/** SEC-4: when each guest last had real input, so the OS hand-off can tell a user's
 *  click from a page navigating itself. Weakly keyed — a closed guest's entry goes with
 *  it. */
const guestGestures = new WeakMap<WebContents, number>()

function setupGuestGestures(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('input-event', (_ev, input) => {
      // the two Chromium itself counts as activation — a mouse MOVE across the page is
      // not the user asking for anything
      if (input.type === 'mouseDown' || input.type === 'keyDown') {
        guestGestures.set(contents, Date.now())
      }
    })
  })
}

/** One hand-off per gesture: a page that fires a burst of external-protocol navigations
 *  off a single click gets exactly the one the user asked for. */
function takeGuestGesture(contents: WebContents): boolean {
  const fresh = gestureFresh(guestGestures.get(contents), Date.now())
  guestGestures.delete(contents)
  return fresh
}

/**
 * D12/§05B row 13: `window.open` and `target=_blank` become a tab in the same Browser.
 * The handler always denies — Electron would otherwise raise a bare OS window with no
 * address bar and no Browser guard on it — and a guest's target is instead re-routed
 * through the one routing table (D3), exactly like any other in-page action. This is
 * what carries an OAuth popup: the tab follows the redirect chain itself.
 */
function setupGuestPopups(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setWindowOpenHandler(({ url }) => {
      if (contents.session === session.fromPartition(BROWSER_PARTITION)) {
        routeGuestPopup(url, contents)
      }
      return { action: 'deny' }
    })
  })
}

/**
 * §05D-10/G0-1: the guest's own context menu — a self-built one, never the renderer's
 * role menu, whose Cut/Copy/Paste act on Koloft rather than on the page. Built in main
 * because that is where the two destinations already live: a link becomes a tab through
 * the same popup route (D4 dedup and the per-session cap included), and an image is
 * saved by asking the guest to download it, which lands in the partition's own
 * `will-download` (§05D-2) with nothing new to unpick.
 */
function setupGuestContextMenu(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('context-menu', (_event, params) => {
      if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
      const items = guestMenuItems(params)
      if (!items.length) return
      Menu.buildFromTemplate(
        items.map((item) => ({
          label: item.label,
          click: () => {
            if (item.action === 'copy-link') clipboard.writeText(item.target)
            else if (item.action === 'open-link') routeGuestPopup(item.target, contents)
            else contents.downloadURL(item.target)
          }
        }))
      ).popup()
    })
  })
}

/**
 * R5 pins "autoplay off by default", nothing more, and the attach-time `autoplayPolicy`
 * already delivers exactly that — so in the product, audio the user starts with a
 * gesture plays, as in Chrome (B6 alignment; a silent video player forces the exit G0
 * exists to close). The blanket mute survives only under the test harness, where the
 * sensory-silence hard rule wants guests provably silent even if a spec clicks play.
 * Muted here rather than on the <webview> element, where the same call is a race —
 * `did-attach` fires before the element can name its guest, so the mute throws
 * (electron#31918's other half) and takes the load that followed it down with it.
 */
function setupGuestAudio(): void {
  if (!BACKGROUND_TEST) return
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setAudioMuted(true)
  })
}

/**
 * SEC-4: a remote page's `file://` link never reaches main at all — Chromium refuses the
 * navigation inside the guest's own renderer, with nothing but a console line to show for
 * it. The guest preload reports the click instead, so the drop is TOLD rather than reading
 * as a dead link. Nothing is trusted from the report: it only ever produces the notice a
 * refusal already owes, and the hand-off whitelist is untouched by it.
 */
function setupGuestLinkReports(): void {
  ipcMain.on('browser:link-blocked', (e, url: unknown) => {
    if (e.sender.session !== session.fromPartition(BROWSER_PARTITION)) return
    if (typeof url !== 'string' || !url) return
    sendToRenderer('browser:blocked-scheme', url.slice(0, 2048))
  })
}

/**
 * §07 #1 (B11): a guest reported a ⌘+click or middle click on a link. The report is not
 * trusted — it runs the same routing table (D3) every other in-page action does, and the
 * only thing it can produce is a background tab. `source: 'agent'` is reused on purpose:
 * it is exactly the landing the PRD already pins for a tab the user did not ask to look
 * at yet — no focus steal, an unread dot, and the page loads when it is opened (B5).
 */
function setupPermissionCleanup(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    // BB-C45: the page that asked is gone. Its id is captured HERE, while the object is
    // still alive — inside `destroyed` every getter on it throws, so an earlier revision
    // read an empty url and dropped nothing at all.
    const guestId = contents.id
    contents.once('destroyed', () => {
      dropPermissions((pending) => pending.guestId === guestId)
    })
    // A prompt must not outlive the page that raised it. Navigating away leaves a bar
    // asking in the name of a site the user has left — and worse, it holds the one bar
    // slot, so whatever the NEW page asks for is never shown at all (found in manual
    // testing: an unanswered camera prompt swallowed the next page's refusal notice).
    // Chrome dismisses on navigation for the same reason.
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      dropPermissions((pending) => pending.guestId === guestId)
    })
  })
}

function setupGuestBackgroundOpen(): void {
  ipcMain.on('browser:open-background', (e, url: unknown) => {
    if (e.sender.session !== session.fromPartition(BROWSER_PARTITION)) return
    if (typeof url !== 'string' || !url) return
    // R1: a ⌘+click inside an overlay has no strip to open a background tab in — it
    // takes the same in-place route as that page's window.open
    if (isOverlayGuest(e.sender)) {
      routeGuestPopup(url.slice(0, 4096), e.sender)
      return
    }
    const tabId = uiActiveTabId
    if (!tabId) return
    const decision = routeFor(url.slice(0, 4096), 'user')
    if (decision.dest !== 'browser') {
      // anything the table does not route into the Browser keeps its own path — the
      // modifier is not a way around the routing rules
      routeGuestPopup(url, e.sender)
      return
    }
    const payload: BrowserOpenRequest = { tabId, url: decision.target, source: 'agent' }
    sendToRenderer('browser:open', payload)
  })
}

/**
 * §07 #3 (B11): a page asked for fullscreen. The guest gets it — but only inside Koloft:
 * the renderer fills the center row (the surface Focus mode already defines) and the
 * host window stays exactly as it is. Letting Electron take the window into macOS
 * fullscreen would put the user in a space with no Koloft around it, which is the opposite
 * of what this browser is for.
 */
function setupGuestFullscreen(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('enter-html-full-screen', () => {
      if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
      // Electron answers a guest's fullscreen by taking the WINDOW into macOS
      // fullscreen — measured, not assumed (2026-08-18 spike). That is the one thing
      // §07 #3 forbids: a Koloft window alone in its own Space is the user carried out of
      // the app this feature exists to keep them in. Pushed straight back; the guest
      // keeps believing it is fullscreen, so a video player's own chrome stays right.
      const win = mainWindow
      if (win && !win.isDestroyed() && win.isFullScreen()) win.setFullScreen(false)
      sendToRenderer('browser:fullscreen', true)
    })
    contents.on('leave-html-full-screen', () => {
      if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
      sendToRenderer('browser:fullscreen', false)
    })
  })
}

/**
 * §07 #4 (B11): which guests are making noise, so the strip can show it and offer the
 * mute. Reported rather than polled — a tab that starts playing while the user is
 * elsewhere is exactly the one they need to find.
 */
function setupGuestAudioState(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('audio-state-changed', (event) => {
      if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
      sendToRenderer('browser:audio-state', {
        guestId: contents.id,
        audible: event.audible,
        muted: contents.isAudioMuted()
      })
    })
  })
}

/**
 * R1: the guests living in an app-level overlay — the global one, the Web Store's.
 * A guest carries no mark of the surface it was mounted in, and only the renderer knows,
 * so it reports the identity here. Main needs it for the three things §02 forbids an
 * overlay page: landing a popup in some session's strip, raising a permission bar, and
 * having its JS dialog drawn on a pane the page is not in.
 */
const overlayGuests = new Set<number>()

function isOverlayGuest(contents: WebContents): boolean {
  return overlayGuests.has(contents.id)
}

/**
 * R1: pages waiting for the renderer to be listening.
 *
 * `webContents.send` to a window whose renderer has not yet run its effects is a silent
 * no-op that still reports success, so firing and forgetting loses the page outright —
 * measured: ~6% of app-startup opens under load, with the drop file already consumed and
 * nothing on screen. That is precisely the silent swallow D8 forbids, and the startup
 * sweep (whose whole job is to deliver drops made while no watcher ran) fires straight
 * into that window. So an overlay page waits here until the renderer says it is ready.
 */
const pendingOverlayOpens: BrowserOverlayOpen[] = []
let overlayListening = false

/** R1: hand an app-level page to the global overlay. `presentation` is §02's split —
 *  `now` when the user just asked for this themselves, `background` when they did not. */
function sendOverlayOpen(url: string, presentation: 'now' | 'background'): void {
  pendingOverlayOpens.push({ url, presentation })
  flushOverlayOpens()
}

/** Deliver what is queued, oldest first, and keep whatever could not be delivered. */
function flushOverlayOpens(): void {
  if (!overlayListening) return
  while (pendingOverlayOpens.length) {
    if (!sendToRenderer('browser:overlay-open', pendingOverlayOpens[0])) return
    pendingOverlayOpens.shift()
  }
}

/** The renderer is gone or going (a reload — Koloft does one to recover a crashed window),
 *  so anything sent now would land nowhere. It announces itself again when it is back. */
function overlayListenerLost(): void {
  overlayListening = false
}

// ---- P1: the CDP relay's side of the house ------------------------------------

/** in-flight asks of the renderer, by op id */
const cdpOps = new Map<string, (res: BrowserCdpOpResult) => void>()
/** tab → the session it was last seen bound to, so a rebind can be spotted (§4.4) */
const boundSessions = new Map<string, string>()

/** the tabs an endpoint may be published for — D9 keeps the utility shells out, and
 *  what is not on disk cannot be read by a shim that ignores the marker */
function ptyTabIds(): string[] {
  return ptyMgr
    .list()
    .filter((p) => !p.util && p.kind !== 'codex')
    .map((p) => p.id)
}

/** Ask the renderer to do one thing to a strip. A window that never answers must not
 *  leave the client hanging either — the op resolves as a failure it can act on. */
function cdpOp(
  kind: BrowserCdpOp['kind'],
  sessionId: string,
  extra: { targetId?: string; url?: string } = {}
): Promise<BrowserCdpOpResult> {
  const opId = crypto.randomUUID()
  return new Promise<BrowserCdpOpResult>((resolve) => {
    // strictly longer than the renderer's own worst case for a mount (cdpBudget.ts):
    // a shorter timer here answered "did not answer" to a slow first load that the
    // renderer then finished anyway — a guest the relay never attached
    const timer = setTimeout(() => {
      cdpOps.delete(opId)
      resolve({ opId, ok: false, error: 'the Koloft window did not answer' })
    }, CDP_OP_BUDGET_MS)
    cdpOps.set(opId, (res) => {
      clearTimeout(timer)
      resolve(res)
    })
    const payload: BrowserCdpOp = { opId, kind, sessionId, ...extra }
    sendToRenderer('browser:cdp-op', payload)
  })
}

function relayDeps(): RelayDeps {
  return {
    sessionForTab: (tabId) => sessionIdOf(tabId) ?? null,
    mount: async (sessionId, targetId) => {
      const r = await cdpOp('mount', sessionId, { targetId })
      if (!r.ok || typeof r.guestId !== 'number')
        throw new Error(r.error ?? 'could not open that tab')
      return r.guestId
    },
    create: async (sessionId, url) => {
      const r = await cdpOp('create', sessionId, { url })
      if (!r.ok || !r.targetId || typeof r.guestId !== 'number') {
        throw new Error(r.error ?? 'could not create a tab')
      }
      return { targetId: r.targetId, url, title: '', guestId: r.guestId }
    },
    close: async (sessionId, targetId) => {
      await cdpOp('close', sessionId, { targetId })
    },
    stage: async (sessionId, targetId) => {
      await cdpOp('stage', sessionId, { targetId })
    },
    setAttached: (sessionId, targetIds) => {
      const payload: BrowserCdpAttached = { sessionId, targetIds }
      sendToRenderer('browser:cdp-attached', payload)
    }
  }
}

/** The popup's landing session is the one the user is in: a guest can only ask while its
 *  own surface is on screen, and main has no other name for the tab set it belongs to. */
function routeGuestPopup(url: string, from?: WebContents): void {
  // R1 §02: a page in an overlay keeps its popups IN the overlay (navigating in place).
  // A surface that owes nothing to any session must never deposit tabs in one — that
  // pollution is precisely what R1 exists to prevent.
  if (from && isOverlayGuest(from)) {
    const decision = routeFor(url, 'user')
    if (decision.dest === 'browser') sendOverlayOpen(decision.target, 'now')
    else if (decision.dest === 'system') openUrlExternally(decision.target)
    // nothing else has a home here, and SEC-4 owes the drop a word either way
    else sendToRenderer('browser:blocked-scheme', url)
    return
  }
  const tabId = uiActiveTabId
  if (!tabId) return
  const decision = routeFor(url, 'user')
  if (decision.dest === 'browser') {
    const payload: BrowserOpenRequest = { tabId, url: decision.target, source: 'user' }
    sendToRenderer('browser:open', payload)
  } else if (decision.dest === 'preview' && fs.existsSync(decision.target)) {
    // a link the user clicked in a guest page, exactly like its `browser:open` sibling
    // two lines up — never an agent request, so it lands visibly (FR-57)
    const payload: OpenRequest = { tabId, path: decision.target, source: 'user' }
    sendToRenderer('preview:open-file', payload)
  } else if (decision.dest === 'system') {
    openUrlExternally(decision.target)
  } else {
    // SEC-4: a dropped navigation says so — silence reads as a dead link
    sendToRenderer('browser:blocked-scheme', url)
  }
}

/**
 * browser-extensions D6: an extension's `chrome.tabs.create` lands in the CURRENT
 * session's strip, active at once — the user's own action, not an agent's (no unread
 * dot). The routing table judges the url exactly as it judges a page's own window.open,
 * with one addition: an extension's own `chrome-extension://` page is a legitimate
 * Browser tab (design §05, BB-C15) and no other source may produce one.
 */
async function openExtensionTab(url: string): Promise<WebContents | null> {
  const tabId = uiActiveTabId
  if (!tabId) return null
  const decision = routeFor(url, 'user')
  const extensionPage = /^chrome-extension:\/\//i.test(url)
  if (!extensionPage && decision.dest !== 'browser') return null
  const target = extensionPage ? url : decision.target
  const payload: BrowserOpenRequest = { tabId, url: target, source: 'user' }
  // return the guest the strip actually made (D4), matched on the ROUTED target — the
  // caller uses it directly instead of awaiting the RAW url again, which a routing
  // rewrite (a search term, an added scheme) would never match.
  if (!sendToRenderer('browser:open', payload)) return null
  return awaitGuestFor(target)
}

/** D4: how many guests may be live at once. The e2e cap cases inject a smaller number
 *  rather than spinning up a dozen renderer processes. */
function browserGuestLimit(): number {
  const injected = Number(process.env.KOLOFT_BROWSER_GUEST_LIMIT)
  return Number.isInteger(injected) && injected > 0 ? injected : 12
}

/** The directory a `file://` request points at, or null for anything else — a file, a
 *  path that is gone, or a url with a host, which is not this machine's filesystem.
 *  Every sub-resource of a local page comes through here, so it never blocks the loop. */
async function directoryTarget(url: string): Promise<string | null> {
  let target: string
  try {
    const u = new URL(url)
    if (u.host && u.host !== 'localhost') return null
    target = decodeURIComponent(u.pathname)
  } catch {
    return null
  }
  try {
    return (await fs.promises.stat(target)).isDirectory() ? target : null
  } catch {
    return null
  }
}

/** Downloads still writing, so "Cancel" has something to stop (B9). Cleared on done. */
const liveDownloads = new Map<string, Electron.DownloadItem>()

/** Where each download came from, so "Retry" can ask for it again. Pruned when its row
 *  is retried into a new attempt, so it does not grow for the life of the process. */
const downloadSources = new Map<string, string>()

/** url → the row id a retry should land back in, set for the moment between asking and
 *  the new download starting. */
const retryTargets = new Map<string, string>()

function setupBrowserPartition(): void {
  const ses = session.fromPartition(BROWSER_PARTITION)
  // SEC-3: Electron grants a permission it has no handler for, so a page could take the
  // camera the moment it loads. Both handlers answer from the same table — deny, minus
  // the sanitized clipboard write; per-permission prompts are P2.
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const decision = permissionAsk(permission, (details ?? {}) as PermissionDetails)
    // R1 §02: a page in an overlay never gets a prompt bar — the overlay is a temporary
    // landing surface, not a browser the user keeps things in, and there is no strip to
    // draw the bar on. The external-protocol door below is untouched: mailto: from an
    // overlay page still reaches the OS on the user's own click (SEC-4).
    if (isOverlayGuest(_wc) && decision.kind === 'ask') {
      callback(false)
      return
    }
    if (decision.kind === 'allow') {
      callback(true)
      return
    }
    if (decision.kind === 'refuse') {
      callback(false)
      // B7: a refusal the user can connect to something they just did is SAID —
      // silence is exactly what sends them to Safari. `tell` is what keeps a page's
      // own machinery (an ad frame, a storage-access probe) from raising the same bar.
      if (decision.tell) {
        sendToRenderer('browser:permission-refused', {
          origin: decision.origin,
          permission: decision.permission
        })
      }
      return
    }
    if (decision.kind === 'ask') {
      const remembered = rememberedPermission(decision.origin, decision.permission)
      if (remembered !== undefined) {
        callback(remembered)
        return
      }
      askUserForPermission(_wc.id, decision.origin, decision.permission, callback)
      return
    }
    // 'elsewhere' — openExternal keeps its own door below. Electron still needs its
    // answer: an un-called callback holds the request, and the WebContents it points
    // at, for the life of the process.
    callback(false)
    // SEC-4: granting 'openExternal' would have Electron call shell.openExternal
    // itself, around Koloft's own whitelist and around the choke point every hand-off is
    // read from. So the page never gets the permission, and Koloft decides separately:
    // a whitelisted scheme leaves through the one door, anything else is refused and
    // reported — and only ever on the user's own click, which this handler is told
    // nothing about and reads off the guest's last input instead (SEC-4).
    if (permission !== 'openExternal') return
    const target = (details as { externalURL?: string }).externalURL ?? ''
    if (canOpenExternally(target) && takeGuestGesture(_wc)) openUrlExternally(target)
    else if (target) sendToRenderer('browser:blocked-scheme', target)
  })
  // What `Notification.permission` and `navigator.permissions.query()` read (2026-08-18
  // spike). It answers from the same store as the prompt, and never raises one: this
  // fires on page load with no user action behind it.
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    const decision = permissionAsk(permission, (details ?? {}) as PermissionDetails)
    if (decision.kind === 'allow') return true
    if (decision.kind !== 'ask') return false
    return rememberedPermission(decision.origin, decision.permission) ?? false
  })
  // SEC-1/IMPL-6: the privileged reader is registered on the default session, so a
  // guest cannot reach it — say so here rather than leave it to that fact, since a
  // future partition-level registration would silently re-open arbitrary file read to
  // every page an agent opens.
  ses.protocol.handle('koloft-file', async () => new Response('Forbidden', { status: 403 }))
  // §05B/C-33: a `file://` url that points at a directory is a listing page. Electron's
  // own file loader answers ERR_FILE_NOT_FOUND for one, so the directory case is served
  // here and every other file request is forwarded to that same built-in loader —
  // `bypassCustomProtocolHandlers` is what keeps the forward from re-entering this
  // handler. Partition-scoped: Koloft's own renderer keeps stock file: behavior.
  ses.protocol.handle('file', async (request) => {
    const dir = await directoryTarget(request.url)
    if (dir) {
      const entries = (await fs.promises.readdir(dir, { withFileTypes: true })).map((e) => ({
        name: e.name,
        isDir: e.isDirectory()
      }))
      return new Response(directoryListingHtml(dir, entries), {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    }
    return ses.fetch(request, { bypassCustomProtocolHandlers: true })
  })
  // SEC-12: the guest is a Chromium browser and says so. Partition-scoped on purpose —
  // app.userAgentFallback is the identity Koloft's own update check and account probes go
  // out with, and it stays put.
  const guestUA = standardUserAgent(app.userAgentFallback, app.getName())
  ses.setUserAgent(guestUA)
  // SEC-12b: the UA claims Chrome; make the Client Hints agree. Electron sends NO
  // Sec-CH-UA at all, and a Chrome UA with no Client Hints is the tell an embedder gives
  // off (e.g. Google's sign-in gate, read server-side). Add the three low-entropy hints
  // real Chrome always sends on secure contexts, brands carrying Google Chrome — so
  // header, navigator.userAgentData (guest preload) and the real Chrome TLS stack are one
  // identity. Browser partition + https only; Koloft's own traffic is on the default session.
  const guestHints = chromeClientHints(guestUA)
  if (guestHints) {
    const managed = new Set(Object.keys(guestHints).map((k) => k.toLowerCase()))
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (!/^https:/i.test(details.url)) return callback({})
      const headers = details.requestHeaders
      // replace only the three low-entropy hints we own — leave any high-entropy hints
      // Chromium negotiated via Accept-CH alone, rather than stripping requested hints
      for (const name of Object.keys(headers)) {
        if (managed.has(name.toLowerCase())) delete headers[name]
      }
      callback({ requestHeaders: { ...headers, ...guestHints } })
    })
  }
  // §05D-11: the JS-dialog channel (src/preload/guest.ts), on this partition alone —
  // the host window and Preview's viewer are on the default session and never load it.
  // Registered here rather than as a <webview preload> attribute so the guest attribute
  // set stays the locked one (SEC-5/SEC-6): what runs inside a guest is main's call.
  ses.registerPreloadScript({
    type: 'frame',
    filePath: path.join(__dirname, '../preload/guest.js')
  })
  // G0-3: a download hangs on this session, never on the guest that started it — but
  // Chromium only moves it there once the response's type is settled, and it MIME-sniffs
  // an attachment it will never render. A body that trickles keeps the sniff (and so the
  // transfer) inside the asking frame for its whole life, and ⌘W on that tab then cancels
  // a download the user already started. `nosniff` on exactly the responses that declare
  // themselves attachments settles it at the headers instead; nothing renderable is
  // touched, since an attachment is by definition not rendered.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders
    if (!headers || !isAttachmentResponse(headers)) return callback({})
    callback({ responseHeaders: { ...headers, 'x-content-type-options': ['nosniff'] } })
  })
  ses.on('will-download', (_e, item) => {
    // the seam the suite injects: a test run may never write into the real ~/Downloads
    const dir = process.env.KOLOFT_DOWNLOAD_DIR || app.getPath('downloads')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      return // no directory to write into: let Chromium's own prompt handle it
    }
    // SEC-9: the suggested name is the site's word, not a path — a basename, uniquified
    // against what is already there, is the only thing that may become one here
    const name = uniqueDownloadName(
      safeDownloadName(suggestedDownloadName(item.getContentDisposition(), item.getFilename())),
      (candidate) => fs.existsSync(path.join(dir, candidate))
    )
    const savePath = path.join(dir, name)
    item.setSavePath(savePath)

    // B9: the list is the durable home for a finished file, so every stage of a
    // download's life is reported — not just the successful end. A failure that says
    // nothing is read as "my click did nothing", which is a forced exit.
    const url = item.getURL()
    // a retry lands back in the row it came from (B9); anything else is a new row
    const retryId = retryTargets.get(url)
    retryTargets.delete(url)
    const id = retryId ?? crypto.randomUUID()
    if (retryId) downloadSources.delete(retryId)
    liveDownloads.set(id, item)
    sendToRenderer('browser:download-event', {
      id,
      kind: 'started',
      name,
      total: item.getTotalBytes()
    })
    item.on('updated', (_ev, state) => {
      if (state !== 'progressing') return
      sendToRenderer('browser:download-event', {
        id,
        kind: 'progress',
        received: item.getReceivedBytes()
      })
    })
    item.once('done', (_ev, state) => {
      liveDownloads.delete(id)
      if (state === 'completed') downloadSources.set(id, url)
      sendToRenderer('browser:download-event', {
        id,
        kind: 'done',
        state,
        path: state === 'completed' ? savePath : undefined
      })
      if (state !== 'completed') {
        // keep the url so "Retry" has something to ask for again
        downloadSources.set(id, url)
        return
      }
      const payload: BrowserDownload = { name, path: savePath }
      sendToRenderer('browser:download', payload)
    })
  })
}

function handleOpenRequest(obj: OpenDrop, full: string): void {
  if (!obj.tabId || !obj.openId) return
  if (processedOpenIds.has(obj.openId)) return
  const p = openDropTarget(obj)
  if (!p) return
  const tab = ptyMgr.get(obj.tabId)
  if (!tab) {
    // Unknown tab: if a LIVE peer instance owns it, it will deliver — leave the file.
    // Otherwise (our tab closed after the shim fired, or the owning instance is dead)
    // the shim already consumed the invocation, so the request has to surface somewhere.
    // R1: that somewhere is the global overlay, in the background — nobody asked
    // for this page just now — and only what the overlay cannot render (a previewable
    // file: the overlay is a browser, not a viewer) still leaves for the OS. With the
    // window gone there is no overlay either, so the OS is the only non-silent
    // destination left (BB-08, the one exempt escape). 'agent' is the conservative
    // label: this path has already lost the tab, so nothing can prove the user typed it.
    const ownerPid = tabInstancePid(obj.tabId)
    if (ownerPid !== null && ownerPid !== process.pid && pidAlive(ownerPid)) return
    processedOpenIds.add(obj.openId)
    fs.rm(full, { force: true }, () => {})
    const w = mainWindow
    const decision = w && !w.isDestroyed() ? routeFor(p, 'agent') : null
    if (decision?.dest === 'browser') sendOverlayOpen(decision.target, 'background')
    else osOpenFallback(p)
    return
  }
  processedOpenIds.add(obj.openId)
  fs.rm(full, { force: true }, () => {})
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    osOpenFallback(p)
    return
  }
  // SEC-14: the drop directory's trust boundary is "any process of this user", so a
  // delivered target runs the same routing table (D3) as every other source — the
  // shim's own filtering is a convenience, never the check. A session tab's open is an
  // agent request: Q5 rules that it never steals the window and never forces a pane
  // open (D10/B5), unlike the user typing `open` themselves. A terminal tab's shell is the
  // one pty where that reading flips — no agent can reach a utility shell (interactive
  // claude is hard-blocked there), so its opens ARE the user's own (D8 amended). The
  // renderer maps the pty back to the conversation tab that owns it (R12); main
  // deliberately does not know which conversation a shell belongs to.
  const source: RouteSource = tab.util ? 'user' : 'agent'
  const decision = routeFor(p, source)
  // the guided login's authorization page goes to the user's OWN browser: the OAuth
  // callback has to come back from wherever their Anthropic login lives, and a page
  // parked in the background overlay reads as "nothing opened"
  if (decision.dest === 'browser' && loginPtys.has(obj.tabId)) {
    openUrlExternally(decision.target)
    return
  }
  if (decision.dest === 'browser') {
    // `osFallback` carries the target as the shim handed it over (a path for a local
    // page, which the file: url the Browser wants could not be handed to the OS under
    // SEC-4). It is what makes "an intercepted open is never silently swallowed" hold
    // on this channel too: with no session to render it, the renderer sends it back out.
    const payload: BrowserOpenRequest = {
      tabId: obj.tabId,
      url: decision.target,
      source,
      osFallback: p
    }
    sendToRenderer('browser:open', payload)
  } else if (decision.dest === 'preview' && fs.existsSync(decision.target)) {
    // the same `source` the Browser branch above carries: the routing table's verdict
    // splits by destination, never by who asked. FR-14 (agent: no tab, no Recents, no
    // signal) vs FR-57 (user: activate `files`, render, expand a collapsed panel) is
    // the renderer's fork on this one field.
    const payload: OpenRequest = { tabId: obj.tabId, path: decision.target, source }
    sendToRenderer('preview:open-file', payload)
  } else if (decision.dest !== 'drop') {
    // a file that vanished between the shim and here: the shim already consumed the
    // invocation, so hand it to the OS rather than swallow it. A routed 'drop' is
    // silent instead — nothing renders it, and it may not leave for the OS either.
    osOpenFallback(p)
  }
}

// The injected SessionStart hook drops `<tabId>.json` here on every startup AND
// in-TUI /resume, overwriting it with the tab's *current* session. We hand that to
// the tracker as the authoritative binding (replacing the mtime guess).
function watchHookRegistrations(dir: string, mirror = false): () => void {
  // Binding reports are `<tab>.json` — a snapshot file, safe to re-read whole.
  // In a MIRROR the same file arrives again every rsync round, so only a file whose
  // content actually moved is a report (hookRouting.makeDropDedupe). The local dir
  // writes each event exactly once and must keep re-delivering whatever it is given.
  const isNews = mirror ? makeDropDedupe() : null
  const drops = watchJsonDrops(dir, () => (obj, full) => {
    if (isNews && !isNews(full, JSON.stringify(obj))) return
    handleHookRegistration(obj)
  })
  // Run-state reports are `<tab>.status.jsonl` — an append-only LOG, drained by
  // byte offset. A snapshot file cannot carry them: a fast turn fires prompt and
  // stop within the reader's latency, and both change events would then read the
  // same (final) contents — the 'working' edge silently lost, so the dot never
  // shows the turn running and its turn-done is never raised.
  const logs = watchStatusLogs(dir)
  return () => {
    drops?.close()
    logs()
  }
}

/** byte cursor per run-state log, so every appended transition is handled exactly
 *  once, in order. Keyed by absolute path (tab ids are globally unique). */
const statusLogCursors = new Map<string, { offset: number; tail: Buffer }>()
/** serializes drains of one log: a change event arriving mid-read must not double
 *  -consume from a cursor the in-flight read has not advanced yet */
const statusLogDraining = new Map<string, boolean>()

/** how often the poll backstop re-drains every run-state log. fs.watch can drop
 *  events; any LATER event self-heals (the drain reads from a byte cursor), but a
 *  dropped FINAL event — a turn's Stop — has no later event and would pin the dot
 *  'working' forever. A fully-consumed log costs one stat per sweep. */
const STATUS_LOG_POLL_MS = 2000

function watchStatusLogs(dir: string): () => void {
  let watcher: fs.FSWatcher | null = null
  try {
    watcher = fs.watch(dir, (_event, filename) => {
      const name = filename?.toString()
      if (!name || !name.endsWith('.status.jsonl')) return
      void drainStatusLog(path.join(dir, name))
    })
  } catch {
    /* dir was created by setupHooks; a failed watch degrades to the poll below */
  }
  const poll = setInterval(() => {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.endsWith('.status.jsonl')) void drainStatusLog(path.join(dir, name))
    }
  }, STATUS_LOG_POLL_MS)
  return () => {
    watcher?.close()
    clearInterval(poll)
  }
}

/** A closed tab's log will never be appended to or read again: drop the file and
 *  its cursor rather than carry both for the app's whole life. */
function dropStatusLog(regDir: string, tabId: string): void {
  const full = path.join(regDir, `${tabId}.status.jsonl`)
  statusLogCursors.delete(full)
  statusLogDraining.delete(full)
  fs.rm(full, { force: true }, () => {})
}

/** Read whatever the hooks appended since last time and apply each transition in
 *  order. Re-entrant-safe and restart-safe (a truncated/rotated log rewinds). */
async function drainStatusLog(full: string): Promise<void> {
  if (statusLogDraining.get(full)) return
  statusLogDraining.set(full, true)
  try {
    let again = true
    while (again) {
      again = false
      let size: number
      try {
        size = (await fs.promises.stat(full)).size
      } catch {
        return
      }
      let cur = statusLogCursors.get(full)
      if (!cur) {
        cur = { offset: 0, tail: Buffer.alloc(0) }
        statusLogCursors.set(full, cur)
      }
      if (size < cur.offset) {
        cur.offset = 0
        cur.tail = Buffer.alloc(0)
      }
      if (size <= cur.offset) return
      const lines = await readAppendedLines(full, size, cur)
      if (!lines) return
      for (const line of lines) {
        if (!line) continue
        try {
          handleStatusRegistration(JSON.parse(line))
        } catch {
          /* a torn line: skip it rather than stall the whole log */
        }
      }
      again = true // a hook may have appended while we were reading
    }
  } finally {
    statusLogDraining.set(full, false)
  }
}

/** Map a run-state hook event (+ Notification message) to a status dot state. */
function statusFromEvent(event?: string, message?: string): SessionStatus | null {
  switch (event) {
    case 'prompt':
      return 'working' // UserPromptSubmit — the user kicked off a turn
    case 'stop':
      return 'waiting' // Stop — main turn ended, back to the user
    case 'notify': {
      const m = (message || '').toLowerCase()
      // "Claude needs your permission to use Bash" — a tool is paused on approval
      if (m.includes('permission') || m.includes('approval')) return 'approval'
      // otherwise an idle "waiting for your input" nudge — still the user's turn
      return 'waiting'
    }
    default:
      return null
  }
}

/**
 * The live tab a hook report is for. Usually the id the report names — but a remote
 * claude keeps the tab id that was baked into its settings when it STARTED, and a
 * Koloft that was quit and reopened re-attaches to it under a new one. Such a report
 * still names the tmux session it came from (hooks.ts `tmux`), and the tracker knows
 * which tab holds that session. Undefined when neither leads to a live tab.
 */
function liveTabFor(report: { tabId?: string; tmux?: string }): string | undefined {
  if (report.tabId && ptyMgr.get(report.tabId)) return report.tabId
  if (!report.tmux) return undefined
  for (const s of tracker.list()) {
    if (s.alive && tracker.remoteOf(s.tabId)?.tmuxName === report.tmux && ptyMgr.get(s.tabId)) {
      return s.tabId
    }
  }
  return undefined
}

/** One line of a tab's run-state log (`<tabId>.status.jsonl`); fold it into the
 *  tracker so the tab's status dot reflects what Claude is doing. */
function handleStatusRegistration(raw: unknown): void {
  // extends HookReport rather than re-declaring its fields: these are casts on `unknown`,
  // so a hand-copied shape would still compile after HookReport changed — and the gate
  // below would quietly read undefined and fail open, with every test still green
  const obj = raw as HookReport & { tabId?: string; message?: string; bgl?: string }
  obj.tabId = liveTabFor(obj)
  if (!obj.tabId) return // unknown / already-closed tab
  // A `/fork`ed background copy shares this tab's hook settings, so ITS turns land here
  // under THIS tab's id — driving the dot and the turn-done alerts of a session the user
  // is not even looking at. Only the tab's own session may move its run-state.
  if (!ownsHookReport(obj, sessionIdOf(obj.tabId))) return
  // a genuine new prompt starts a NEW turn: its completion must reach the outlets
  // even if it lands within OUTLET_DEDUPE_MS of the previous turn's notification
  if (obj.event === 'prompt') consumeOutletDedupe(obj.tabId)
  const status = statusFromEvent(obj.event, obj.message)
  // turn-end signals (Stop, idle nudge) are gated: while background subagents /
  // workflows are still running the session is NOT waiting — the tracker holds
  // 'working' and applies 'waiting' only once the background drains. `bgl` is
  // Claude Code's own typed list of what is still running at this turn-end
  // (hooks.ts); absent on a claude too old to report it, which the tracker reads
  // as "fall back to the inferred ledger".
  if (status === 'waiting') void tracker.reportTurnEnd(obj.tabId, parseReportedTasks(obj.bgl))
  else if (status) tracker.setStatus(obj.tabId, status)
}

// A SessionEnd whose reason doesn't unambiguously mean "claude exited": it may have
// exited, OR be re-initing in place. `/clear` and in-TUI `/resume` both fire SessionEnd
// (then a fresh SessionStart) while the *same* claude process keeps running, and a real
// /resume reports reason 'other' — the same catch-all a genuine exit may use. So instead
// of trusting the reason string, ask the OS: after a short settle window (enough for a
// genuinely exiting claude to leave the process table) probe the tab's shell and untrack
// only if no claude survives under it. A live TUI is thus never stranded as a "terminal"
// regardless of Claude's (undocumented, version-dependent) reason semantics, while a real
// exit still reverts in well under a second. The periodic sweep stays the backstop for
// when the probe is inconclusive (ps glitch -> null) or the settle window was too short.
const SESSION_END_SETTLE_MS = 800
function untrackIfClaudeGone(tabId: string): void {
  if (tracker.remoteOf(tabId)) return // no local process to probe; the pty exit is its end
  setTimeout(async () => {
    const pid = ptyMgr.pidOf(tabId)
    if (!pid) return // tab/pty already gone
    // never untrack a not-yet-bound tab (mid-launch / mid-transition) on a transient
    // absence — mirrors the periodic liveness sweep's jsonlPath guard
    if (!tracker.list().some((s) => s.tabId === tabId && s.jsonlPath)) return
    const alive = await rootsWithClaude([pid])
    if (!alive) return // probe failed — leave it to the periodic sweep
    if (!alive.has(pid)) {
      // SessionEnd DID fire (this probe only runs after one) — a graceful end,
      // nothing to alert about; just drop any stale pending marker with the session
      attention.clear(tabId)
      sessionEndSeen.delete(tabId)
      untrackSession(tabId) // claude gone, shell lives on -> revert
    }
  }, SESSION_END_SETTLE_MS)
}

function sessionIdOf(tabId: string): string | undefined {
  return tracker.list().find((s) => s.tabId === tabId)?.sessionId
}

/** How the occupancy evidence names a session. Never falsy for a session that DID
 *  match: a pty that has not bound yet has neither a real title nor an id, and an
 *  empty string would read back as "nobody is in there". */
function occupantName(s: { title: string; sessionId: string }): string {
  if (s.title && s.title !== PLACEHOLDER_SESSION_TITLE) return s.title
  return s.sessionId || 'a launching session'
}

/** the lifecycle contract D9: the RUNNING session working in this dir — the resume dialog's
 *  occupancy evidence. Only ptys Koloft spawned are visible here: a claude started
 *  outside Koloft cannot be detected at all, which is why the dialog warns rather than
 *  locks. */
function occupantOfDir(dir: string): string | null {
  const target = path.resolve(dir)
  for (const s of allSessions()) {
    if (!s.alive || s.remote) continue // a path on another machine is not this dir
    if (s.treeRoot && path.resolve(s.treeRoot) === target) return occupantName(s)
    // asked of treeRoot, the directory the session IS in. Its `cwd` would answer
    // yes forever once the session LEFT this worktree — that field stays pointed at the
    // checkout it left (195/195 measured) — and would warn about a conflict that is over.
    // The row's binding is still read as well: a resumed `-w` session re-enters the
    // worktree itself, and treeRoot only catches up once that rename is noticed.
    const bound = s.sessionId ? workspaceMgr?.findRow(s.sessionId)?.worktreeState : undefined
    if (bound && path.resolve(bound.worktreePath) === target) return occupantName(s)
  }
  for (const tab of ptyMgr.list()) {
    if (tab.kind === 'codex' && tab.alive && path.resolve(tab.cwd) === target)
      return 'a starting Codex session'
  }
  return null
}

/**
 * The tab's session stops running — SessionEnd hook, ps liveness probe, Close
 * session, or the pty dying under it. §4 gives this one verdict: the row turns cold.
 * Nothing else is torn down: since D1 a session owns no shells of its own, and the
 * center TUI pty is untouched — its exit output has to stay readable.
 */
function untrackSession(tabId: string): void {
  tracker.untrack(tabId)
}

/** Tear down a pty Koloft kills itself — the renderer learns via terminal:exit. */
function killTabPty(tabId: string): void {
  if (codexSessions?.hasTab(tabId)) {
    void codexSessions.stop(tabId).catch((error) => sendToRenderer('cron:toast', String(error)))
    return
  }
  const remote = tracker.remoteOf(tabId)
  if (remote) {
    // BEFORE the local pty: closing the pty first only drops the ssh connection and
    // leaves claude running inside tmux over there. Nothing waits on the answer here —
    // a machine that cannot be reached keeps its session and the row honestly keeps
    // saying so — but the next launch of this tmux name does (remoteKills).
    const kill = runSsh(remote.host, killSessionCmd(remote.tmuxName), {
      controlDir: remoteControlDir
    }).then(() => {
      if (remoteKills.get(remote.tmuxName) === kill) remoteKills.delete(remote.tmuxName)
      remoteSync?.pokeNow(remote.host)
    })
    remoteKills.set(remote.tmuxName, kill)
    const killedId = sessionIdOfTmux(remote.tmuxName)
    if (killedId) killedRemoteSessions.add(killedId)
    fs.rmSync(tabPackageDir(app.getPath('userData'), tabId), { recursive: true, force: true })
  }
  ptyMgr.kill(tabId)
  attention.clear(tabId) // the tab is gone — nothing left to point the user at
  sessionEndSeen.delete(tabId)
  untrackSession(tabId)
  // §4.4: the endpoint belongs to the TAB, so it dies with it — the client is
  // told (its targets go, then the socket closes) rather than left holding a key to a
  // door that no longer exists.
  relayTabClosed(tabId)
  boundSessions.delete(tabId)
}

/** the lifecycle contract D1 — the SessionEnd reasons that unambiguously mean claude is exiting
 *  on the user's own say-so, and the ONLY ones that evict a session from the working
 *  set. Everything else (in-TUI /clear and /resume, a SIGHUP'd quit) is ambiguous and
 *  at most turns the row cold. */
const EVICTING_END_REASONS = new Set(['prompt_input_exit', 'logout'])

/** how long a remote tab's SessionEnd is waited for after its pty died: it is written
 *  on the machine and only reaches the mirror with the next rsync round */
const REMOTE_EXIT_WAIT_MS = 10_000
/** how much older than the pty's death a report may be and still be this exit's: the
 *  hook runs before claude exits, and the two clocks need not agree to the second */
const REMOTE_EXIT_SLACK_MS = 30_000

/**
 * A remote tab's counterpart to drainExitRegistration. The report cannot be read off
 * disk when the pty dies — it is still on the other machine — so watch the mirror for
 * it instead, and evict the session on the same whitelist the local path uses.
 *
 * The report is NOT looked up by this tab's id: the machine's claude writes under the
 * id of the tab that STARTED it, and after an attach (a Koloft restart, a re-adopted
 * row) that is a different, long-dead tab. So it is any freshly written mirrored report
 * naming this session (an attached tab's /exit never left the
 * working set while the drain waited on `<its own id>.json`).
 */
async function drainRemoteExit(
  host: string,
  mirrorDir: string,
  tabId: string,
  sid?: string
): Promise<void> {
  // rsync keeps the machine's mtime, so "written for this exit" is a report younger
  // than the pty by at most the slack — a leftover from an earlier exit of the same
  // session is minutes old
  const since = Date.now() - REMOTE_EXIT_SLACK_MS
  const thisExit = (): { name: string; raw: { event?: string; reason?: string } } | undefined => {
    let names: string[] = []
    try {
      names = fs.readdirSync(mirrorDir)
    } catch {
      return undefined
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const full = path.join(mirrorDir, name)
      try {
        if (fs.statSync(full).mtimeMs < since) continue
        const text = fs.readFileSync(full, 'utf8')
        if (!sid || !text.includes(`"${sid}"`)) continue
        const raw = JSON.parse(text) as { event?: string; reason?: string }
        if (raw.event === 'end') return { name, raw }
      } catch {
        /* mid-rewrite by rsync — the next poll reads it whole */
      }
    }
    return undefined
  }
  remoteSync?.pokeNow(host) // the report may be one idle round (20s) away otherwise
  const deadline = Date.now() + REMOTE_EXIT_WAIT_MS
  let hit = thisExit()
  while (!hit && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    hit = thisExit()
  }
  if (hit && EVICTING_END_REASONS.has(hit.raw.reason ?? '')) {
    // two tabs, one session: only the last one out evicts (same rule as the local path)
    const stillBound = !!sid && tracker.list().some((t) => t.alive && t.sessionId === sid)
    if (sid && !stillBound) workspaceMgr?.dropOwnership(sid)
  }
  // nothing reads these again; rsync's `--delete` follows the machine's own removal
  for (const name of new Set([`${tabId}.json`, hit?.name ?? ''])) {
    if (name) fs.rmSync(path.join(mirrorDir, name), { force: true })
  }
  dropStatusLog(mirrorDir, tabId)
}

/** A dying tab's own SessionEnd, read straight off disk instead of waiting for the
 *  watcher that will arrive after the pty handle is gone (see the pty 'exit' handler).
 *  Only an EVICTING reason is drained: those are the reports whose whole effect happens
 *  after claude is already dead, so losing them is silent. The ambiguous ones are
 *  handled by the pty teardown itself, which turns the row cold either way. */
function drainExitRegistration(regDir: string, tabId: string): void {
  let raw: { event?: string; reason?: string }
  try {
    raw = JSON.parse(fs.readFileSync(path.join(regDir, `${tabId}.json`), 'utf8'))
  } catch {
    return // a utility shell, a login pty, or a launch that never bound — nothing to drain
  }
  if (raw.event === 'end' && EVICTING_END_REASONS.has(raw.reason ?? '')) {
    handleHookRegistration(raw)
  }
}

function handleHookRegistration(raw: unknown): void {
  // extends HookReport (same reason as handleStatusRegistration): event / source /
  // sessionId have exactly one declaration, so the gate below cannot drift into a no-op
  const obj = raw as HookReport & {
    tabId?: string
    transcriptPath?: string
    cwd?: string
    reason?: string
    account?: string
    ccVersion?: string
  }
  obj.tabId = liveTabFor(obj)
  if (!obj.tabId) return // unknown / already-closed tab
  // `/fork` copies the conversation into a BACKGROUND session and keeps this tab where
  // it is — but the copy is a child of this claude and inherits its `--settings`, so its
  // SessionStart/SessionEnd arrive stamped with THIS tab's id. Acting on them rebinds
  // the tab to the copy and adopts it into the sidebar (start), then unbinds the very
  // much alive session when the copy stops (end — a background job self-stops with
  // reason `prompt_input_exit`, which this handler's whitelist reads as "the user quit").
  // ownsHookReport is the one gate: source for a start, session id for everything else.
  if (!ownsHookReport(obj, sessionIdOf(obj.tabId))) return
  if (obj.event === 'end') {
    // Revert the tab to a plain terminal on a reason that unambiguously means claude
    // is *exiting* (Ctrl+D at the prompt -> 'prompt_input_exit', or 'logout'). In-TUI
    // transitions keep the TUI alive and fire a SessionEnd *followed by* a fresh
    // SessionStart: '/clear' (reason 'clear') and, crucially, in-TUI '/resume' (reason
    // 'other'). Untracking those strands the tab as a terminal while the TUI is still
    // up, because (a) the end/start hooks overwrite the same $tab.json so the content
    // we read back races, and (b) once untracked the following SessionStart's
    // bindSession is a no-op (no tracked entry left to bind). 'other' is also the
    // catch-all a genuine exit may report, so for it (and any other ambiguous reason)
    // verify claude is actually gone before reverting (untrackIfClaudeGone).
    if (EVICTING_END_REASONS.has(obj.reason ?? '')) {
      // the lifecycle contract D1: this whitelist is ALSO the only eviction signal for the
      // working set. Read the id first — untrackSession drops the tracker entry
      // sessionIdOf reads — and evict strictly after it, or filterOwned's running
      // fallback keeps the row alive for one rescan and it flashes.
      const sid = sessionIdOf(obj.tabId)
      attention.clear(obj.tabId) // graceful end: the user did this themselves
      untrackSession(obj.tabId)
      // two tabs, one session: another live tab still drives this id (a second resume
      // of the same transcript), and it still owns the row — only the last one out
      // evicts. The untrack above already dropped THIS tab's binding.
      const stillBound = !!sid && tracker.list().some((s) => s.alive && s.sessionId === sid)
      if (sid && !stillBound) workspaceMgr?.dropOwnership(sid)
    } else {
      // remember the SessionEnd even if the confirm probe below fails: should the
      // periodic sweep end up reaping this tab, it was NOT a hard exit — no alert.
      // D1: this path only turns the row COLD, never evicts — E6 proved SIGHUP (⌘W,
      // workspace removal, Koloft quit) fires SessionEnd with reason 'other', so evicting
      // on anything outside the whitelist would empty the list on every quit.
      sessionEndSeen.set(obj.tabId, Date.now())
      untrackIfClaudeGone(obj.tabId)
    }
    return
  }
  // a live SessionStart supersedes any earlier SessionEnd (in-TUI /clear, /resume)
  sessionEndSeen.delete(obj.tabId)
  // rescan trigger (b): a session started in a cwd outside every known bucket —
  // a fresh `claude -w` worktree or one created outside Koloft (agent-centric §6)
  if (obj.cwd) workspaceMgr?.onSessionStart(obj.tabId, obj.cwd)
  const prevId = sessionIdOf(obj.tabId)
  tracker.bindSession(
    obj.tabId,
    obj.transcriptPath || '',
    obj.sessionId || '',
    obj.cwd || '',
    obj.account || '',
    obj.ccVersion || '',
    obj.source || ''
  )
  // the resume this pty was spawned for has landed — drop the spawn-time intent so
  // a later adoption can't rebuild a "resuming" overlay over a settled tab
  ptyMgr.clearResumeIntent(obj.tabId)
  // an in-TUI /clear moves the tab to a new id; its Workbench state follows (§4)
  const nextId = sessionIdOf(obj.tabId)
  if (prevId && nextId && nextId !== prevId) {
    // the hook renamed the tmux session over there to match (hooks.ts), so the name the
    // kill, the heartbeat and the restart use has to move with it
    if (tracker.remoteOf(obj.tabId)) tracker.setRemoteTmuxName(obj.tabId, tmuxSessionName(nextId))
    workspaceMgr?.onSessionRebind(prevId, nextId, obj.source || '')
    if (obj.source === 'clear') {
      // the lifecycle contract D2: /clear re-inits in place, so the old id leaves the working
      // set — together with the panel entry onSessionRebind just copied onto the new
      // id, that makes the session a MOVE rather than a duplicate (FR-29)
      workspaceMgr?.dropOwnership(prevId)
    }
    // §4② + D8: an in-TUI /resume is a session SWITCH, and the panel does NOT
    // follow it — the panel belongs to the conversation TAB, which has not moved, so the
    // renderer is told nothing and shows exactly what it was showing. (Its next write
    // lands under the target id, R11.) the lifecycle contract D2 (follow-up decision): a switch is not
    // an end — the previous id keeps its working-set membership and turns cold.
  }
  // the bind is what makes a session Koloft's own — the owned-only sidebar lists it from
  // here on (new launches, resumes, and future imports all pass through this)
  if (nextId) workspaceMgr?.onSessionBound(nextId)
  // a scheduled run has started for real — the start deadline is over. This fires
  // again on an in-TUI /clear or /resume, where only the session id changes.
  if (nextId) cronRunner?.onBound(obj.tabId, nextId)
}

// Launch claude in a fresh pty (the one claude spawn path: new tabs and the cold-row
// resume both build the same command).
function createClaudeTab(
  cwd: string,
  resumeSessionId?: string,
  cols?: number,
  rows?: number,
  worktree?: string,
  // only a scheduled run passes these. `env` carries the job's first message and
  // its name — they must NEVER join the launch line, which is typed into a login shell
  // (see cronRunner's header); model and permission are regex-checked tokens.
  extra?: {
    env?: { KOLOFT_FIRST_PROMPT?: string; KOLOFT_SESSION_NAME?: string }
    model?: string
    effort?: CronEffort
    permission?: CronPermission
  }
): CreateTabResult {
  // launch claude; the shim assigns the session id and registers it. The base is
  // FIXED (D4: the claudeCommand setting is retired — auth comes from the
  // multi-account balancer or the system /login); KOLOFT_CLAUDE_CMD is a test-only
  // seam that points the shim's PATH scan at the e2e fake claude.
  const base = process.env.KOLOFT_CLAUDE_CMD || 'claude'
  // D11: an id or a worktree name that cannot go on the command line fails the launch
  // here — dropping the flag would spawn a session somewhere the caller never asked for.
  const args = claudeArgv(base, {
    resumeSessionId,
    worktree,
    model: extra?.model,
    effort: extra?.effort,
    permission: extra?.permission
  })
  if (!args.ok) return args
  // `exec`: claude REPLACES the shell, so the pty dies with it. A session tab is a
  // session, not a terminal that happens to run one (free terminal retired, §9) —
  // and this is what lets a launch that never binds end (pty exit → launchEnded →
  // the pending row goes) instead of leaving a shell prompt behind forever.
  const launchCommand = `exec ${args.argv.join(' ')}`
  const handle = ptyMgr.create({
    kind: 'claude',
    cwd,
    cols,
    rows,
    setupCommand: setupLine(),
    launchCommand,
    // retained on the handle (M2): main's only pty→session link until the
    // SessionStart hook binds — the adoption inventory needs it to keep a reloaded
    // renderer from double-resuming the same transcript
    resumeSessionId,
    extraEnv: extra?.env
  })
  // A brand-new session has no jsonl to aggregate yet: hold a pending sidebar row
  // until the SessionStart hook + Claude's storage catch up (§4). A resume of a LIST
  // MEMBER already owns a (cold) row that simply turns running — but a lifecycle-contract
  // D5 restore resumes a session that is not a member, so it has no row either and
  // the click would give zero feedback until the bind lands (§3.2).
  if (!resumeSessionId || !workspaceMgr?.isMember(resumeSessionId)) {
    workspaceMgr?.launchStarted(handle.id, cwd, worktree)
  }
  // D2: publish this tab's endpoint before anything can be typed in it, so the
  // very first `claude` launch already carries it
  writeRelayEnv(ptyTabIds())
  return { ok: true, id: handle.id, cwd }
}

function dirExistsSync(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false // vanished worktree / bad path — report, never spawn blind
  }
}

/** The mirror of each pinned machine's hook folder, watched exactly like the local
 *  one — the files rsync lands there are ordinary `<tab>.json` / `<tab>.status.jsonl`
 *  drops with our own tab ids in them, so everything downstream is unchanged.
 *  Reconciles against the pinned machines, so both an add and a remove land here. */
function watchRemoteHookMirrors(): void {
  const wanted = new Set(
    (workspaceMgr?.remoteTargets() ?? []).map((t) => mirrorHookDir(app.getPath('userData'), t.host))
  )
  for (const [dir, dispose] of watchedHookMirrors) {
    if (wanted.has(dir)) continue
    dispose()
    watchedHookMirrors.delete(dir)
  }
  for (const dir of wanted) {
    if (watchedHookMirrors.has(dir)) continue
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* userData unwritable — the watcher below degrades to its own poll */
    }
    watchedHookMirrors.set(dir, watchHookRegistrations(dir, true))
  }
}

/**
 * The machine a session lives on, or null for a local one. Two sources, live tabs
 * first: a caller holds the session's cwd, and for a remote session that is an absolute
 * path ON THE MACHINE — indistinguishable from a local one by itself. ⇧⌘R hands exactly
 * that (the session's pinned root), so without this the restart would spawn a local
 * claude on a path that means nothing here.
 */
function remoteKeyOfSession(sessionId?: string): RemoteKey | null {
  if (!sessionId) return null
  // a tab of THIS run knows its own machine and the path over there — including right
  // after an in-TUI /clear, before any mirrored row carries the new id
  for (const t of tracker.list()) {
    const remote = tracker.remoteOf(t.tabId)
    if (remote && t.sessionId === sessionId) return { host: remote.host, path: t.cwd }
  }
  const wsPath = workspaceMgr?.workspaceOf(sessionId)
  return wsPath ? parseRemoteKey(wsPath) : null
}

/**
 * Start (or re-attach to) a claude session on another machine. Where a local launch
 * types `exec claude` into the tab's shell, this types one line that pushes two
 * packages over ssh and then runs claude inside tmux over there. Everything the shim
 * does locally — pick an account, read the Keychain, mint a session id, register the
 * tab — happens here instead: there is no shim on the machine.
 */
async function createRemoteClaudeTab(
  key: RemoteKey,
  opts: { resumeSessionId?: string; cols?: number; rows?: number; worktree?: string }
): Promise<CreateTabResult> {
  const pkg = machinePackage()
  ensureControlDir(remoteControlDir) // idempotent; the ssh master needs it to exist
  const settings = loadSettings()
  const sid = opts.resumeSessionId ?? crypto.randomUUID()
  // tabScript types the command itself (it wedges `--settings` after it), so only the
  // flags go over
  const args = claudeArgv('claude', {
    resumeSessionId: opts.resumeSessionId,
    sessionId: opts.resumeSessionId ? undefined : sid,
    worktree: opts.worktree,
    permission: settings.skipPermissions ? 'skipAll' : undefined
  })
  // refused here, before a tab exists — tabScript would throw from inside the launch
  if (!args.ok) return args
  const claudeArgs = args.argv.slice(1)
  const tmuxName = tmuxSessionName(sid)
  const mode = launchMode({
    alive: remoteSync?.alive(key.host) ?? new Set(),
    killed: killedRemoteSessions,
    sessionId: sid
  })
  // it is being started again, so a later launch may attach to it once more
  killedRemoteSessions.delete(sid)
  // a resume starts in the directory the transcript recorded (a worktree, for a
  // session opened inside one), as a local resume does; `key.path` is only the
  // workspace root for a cold row, and the root is where claude falls back to when
  // that directory is gone
  // the machine's own path, symlinks resolved: claude records THAT as cwd and slugs
  // its transcript by it, so a launch aimed at the typed path would never match its
  // own bucket or its own mirrored transcript (contract §2)
  const root = workspaceMgr?.realRemotePath(key) ?? key.path
  const cwd = (opts.resumeSessionId && workspaceMgr?.findRow(sid)?.cwd) || root
  const wsKey = parseRemoteKey(workspaceMgr?.workspaceOf(sid) ?? '')
  const wsRoot = wsKey ? (workspaceMgr?.realRemotePath(wsKey) ?? wsKey.path) : root

  let env: Record<string, string> | undefined
  let picked: string | undefined
  let banner = "[Koloft] using this machine's own claude login"
  if (mode === 'start' && settings.multiAccount) {
    const { res, endpoint } = await pickForLaunch()
    if (res.account) {
      const secret = await keychainRead(res.kind, res.account)
      if (secret) {
        env = accountEnv(res.kind, res.account, secret, endpoint)
        picked = res.account
        banner = res.warning ? `${res.banner}\n${res.warning}` : res.banner
      }
    }
  }

  const remoteStatusLine: StatusLineSetting | undefined = settings.statuslineBuiltin
    ? {
        type: 'command',
        command: dq(`${remoteMachineDir(pkg.name)}/statusline/run.sh`),
        padding: 0
      }
    : undefined
  const userData = app.getPath('userData')
  // a ⇧⌘R kill of this very name may still be on the wire: `new-session -A -D` landing
  // first would attach to the claude being destroyed. runSsh's own timeout bounds it.
  await remoteKills.get(tmuxName)
  const handle = ptyMgr.create({
    kind: 'claude',
    // the machine's directory is not this Mac's: the local shell that types the line
    // starts at home, and the `cd` happens on the other side
    cwd: os.homedir(),
    cols: opts.cols,
    rows: opts.rows,
    setupCommand: setupLine(),
    // the tab id is minted by create(), and both packages are named after it
    launchCommand: (tabId) => {
      // tab ids are recycled across Koloft runs, and the mirror still holds whatever a
      // previous tab of this id reported — the watcher would replay it as this
      // session's own. The machine's copies go the same way (launch.ts tabScript).
      const mirror = mirrorHookDir(userData, key.host)
      fs.rmSync(path.join(mirror, `${tabId}.json`), { force: true })
      dropStatusLog(mirror, tabId)
      const tabDir = tabPackageDir(userData, tabId)
      writeTabPackage(tabDir, {
        tabId,
        tmuxName,
        machineName: pkg.name,
        cwd,
        fallbackCwd: wsRoot !== cwd ? wsRoot : undefined,
        banner,
        env,
        settings: hookSettings(
          `${remoteMachineDir(pkg.name)}/hook.sh`,
          REMOTE_HOOK_DIR,
          tabId,
          remoteStatusLine,
          dq
        ),
        claudeArgs
      })
      return launchLine({
        host: key.host,
        sshOptions: sshOptions(remoteControlDir, false),
        machine: pkg,
        tabDir,
        tabId,
        mode
      })
    },
    resumeSessionId: opts.resumeSessionId,
    // the line is sh/zsh syntax typed into the login shell; a fish user's own shell
    // would not run it
    shell: '/bin/zsh'
  })

  tracker.track(handle.id, cwd, {
    host: key.host,
    projectsRoot: mirrorProjectsRoot(userData, key.host),
    tmuxName
  })
  if (picked) tracker.setPickedAccount(handle.id, picked)
  if (mode === 'attach') {
    // no SessionStart will ever fire for an attach, so nothing else would tie this
    // tab to its session. A start is bound by the mirrored hook like a local launch —
    // binding it here would show a launch that dies installing as a running session.
    tracker.bindSession(handle.id, '', sid, cwd)
    workspaceMgr?.onSessionBound(sid)
  } else if (!opts.resumeSessionId) {
    workspaceMgr?.launchStarted(handle.id, root, opts.worktree, key.host)
  }
  writeRelayEnv(ptyTabIds())
  remoteSync?.pokeNow(key.host)
  // the renderer identifies a remote tab by parsing this key; the tracker keeps the
  // machine-side path
  return { ok: true, id: handle.id, cwd: formatRemoteKey(key.host, key.path) }
}

// ---- scheduled jobs: the bits of the runner's world that touch disk ---------

/** Where `claude -w <name>` puts a run's copy of the repo. */
function worktreeHomeOf(root: string): string {
  return path.join(root, '.claude', 'worktrees')
}

/** True only for a REAL repo root. A `.git` FILE means a linked worktree or a
 *  submodule, where `-w` cannot make a sibling copy — such a job runs in place. */
function gitDirExistsSync(root: string): boolean {
  return dirExistsSync(path.join(root, '.git'))
}

/** Run folders this job has left behind — the card's "n run folders on disk". Koloft
 *  never removes them, so the count is the person's cue to clean up. */
function countRunFoldersSync(root: string, slug: string): number {
  try {
    return fs
      .readdirSync(worktreeHomeOf(root), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(`${slug}-`)).length
  } catch {
    return 0 // no worktrees home yet, or unreadable — nothing to report
  }
}

/** Can a run reach Claude at all? With the balancer off the system login answers, so
 *  the only "no" is a pool that is on and empty. Mirrors accountPicker's `eligible()`. */
function accountUsable(): boolean {
  if (!loadSettings().multiAccount) return true
  return listAccounts().some((a) => a.enabled && a.status === 'ok')
}

/** Has claude been trusted with this folder? Read fresh every time: the person can answer
 *  claude's question in another window at any minute, and `~/.claude.json` is one small
 *  file. Koloft never writes it (claudeTrust.ts says why). */
function claudeTrusts(dir: string): boolean {
  return isTrustedByClaude(
    () => JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')),
    dir
  )
}

/** The one place a scheduled run becomes a tab. The renderer is TOLD about it rather
 *  than asking, and adds it without activating anything — the person keeps their place
 *  (§5.1 addTabQuiet). */
function launchCronRun(req: LaunchRequest): { ok: true; tabId: string } | { ok: false } {
  // A THROW here would be worse than a refusal: the runner only knows `{ ok: false }`,
  // so an escaping error would take the due with it — no history line, no toast, and on
  // the timed path an unhandled rejection in main. Spawning can genuinely throw: the
  // folder can vanish between the check and the spawn, and the per-tab hook settings
  // still have to be written. Turn all of it into the refusal the runner understands,
  // which reads as "Claude exited before it started".
  try {
    const r = createClaudeTab(req.cwd, undefined, undefined, undefined, req.worktree, {
      env: req.env,
      model: req.model,
      effort: req.effort,
      permission: req.permission
    })
    if (!r.ok) return { ok: false }
    const spawned: SpawnedTab = {
      id: r.id,
      kind: 'claude',
      cwd: r.cwd,
      // a placeholder only: the tracker retitles the tab the moment the session binds
      title: req.env.KOLOFT_SESSION_NAME,
      jobId: req.jobId
    }
    sendToRenderer('terminal:spawned', spawned)
    return { ok: true, tabId: r.id }
  } catch (err) {
    console.error('[koloft] a scheduled run could not be launched:', err)
    return { ok: false }
  }
}

/** Real files for `listSkills`, which is pure over this. */
const skillFs: SkillFs = {
  readdir: (p) => fs.readdirSync(p),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  isDir: dirExistsSync,
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  }
}

/** 90 seconds is how long a launched session may take to say SessionStart before the
 *  run is written off. The e2e suite cannot wait that long, so a background test launch
 *  may shorten it — and only a background test launch may. */
function cronBindDeadlineMs(): number {
  return (
    (process.env.KOLOFT_TEST_BACKGROUND === '1' &&
      Number(process.env.KOLOFT_CRON_BIND_DEADLINE_MS)) ||
    90_000
  )
}

/** One git call with the 5s budget the rest of main uses. null on ANY failure (git
 *  missing from a packaged app's PATH, not a repo, dead worktree registration) — the
 *  resume plan reads null as an anomaly, never as a green light. */
function gitOut(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5000 }, (err, stdout) =>
      resolve(err ? null : stdout)
    )
  })
}

/** Branch/commit-ish shape accepted from the renderer's rebuild spec. execFile takes
 *  an argv array (no shell), so this is about git itself: a leading `-` would be read
 *  as an option, and a leading `/` is not a ref. */
const GIT_REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,120}$/

const resumeProbes: ResumeProbes = {
  dirExists: dirExistsSync,
  branchAt: async (dir) => (await gitOut(dir, ['symbolic-ref', '--short', 'HEAD']))?.trim() || null,
  dirtyAt: async (dir) => {
    const out = await gitOut(dir, ['status', '--porcelain'])
    return out === null ? null : out.trim() !== ''
  },
  occupantOf: occupantOfDir,
  branchExists: async (repoDir, branch) =>
    (await gitOut(repoDir, ['rev-parse', '--verify', 'refs/heads/' + branch])) !== null,
  headAt: async (repoDir) => (await gitOut(repoDir, ['rev-parse', 'HEAD']))?.trim() || null
}

/** The plan for one session id, off main's own row + bucket (never the renderer's). */
function resumePlanFor(sessionId: string): Promise<ResumePlan> {
  const row = isCodexSession(sessionId)
    ? codexSessions?.findRow(sessionId)
    : workspaceMgr?.findRow(sessionId)
  if (isCodexSession(sessionId) && row && !row.worktreeState && !dirExistsSync(row.cwd)) {
    return Promise.resolve({ action: 'unavailable', reason: 'no-cwd' })
  }
  return planResume(
    row,
    resumeProbes,
    isCodexSession(sessionId)
      ? row?.worktreeState?.worktreePath
      : workspaceMgr?.bucketDirOf(sessionId)
  )
}

/** the lifecycle contract §4: recreate the checkout claude (or the user) removed, at the recorded
 *  path and baseline, then the caller resumes into it. Creation ONLY — the path must sit
 *  in a `.claude/worktrees` home, and `git worktree add` refuses an existing path, which
 *  IS the safe outcome (§7: Koloft never deletes or overwrites what it didn't create). The
 *  branch is re-checked here rather than trusted from the plan: the two are separate user
 *  gestures and the repo can move in between. */
async function rebuildWorktree(spec: {
  worktreePath: string
  branch: string
  baseRef: string
}): Promise<boolean> {
  const root = worktreeHomeRoot(spec.worktreePath)
  if (!root) return false
  const branchLives =
    (await gitOut(root, ['rev-parse', '--verify', 'refs/heads/' + spec.branch])) !== null
  const args = branchLives
    ? ['worktree', 'add', spec.worktreePath, spec.branch]
    : ['worktree', 'add', '-b', spec.branch, spec.worktreePath, spec.baseRef]
  return (await gitOut(root, args)) !== null
}

/** Every settings write lands here — the renderer's settings:set and the View menu's
 *  keep-awake checkbox alike — so the echo and the side effects can never drift apart. */
function commitSettings(patch: Partial<Settings>): Settings {
  const s = saveSettings(patch)
  sendToRenderer('settings:update', s)
  // reflect a dockBadge toggle at once, without waiting for the next attention change
  updateDockBadge(attention.list())
  // D2: browser control is a SECURITY switch — off means off now, for the tools
  // already connected, not "off for whatever launches next"
  setRelayEnabled(s.browserControl, ptyTabIds())
  // keepAwake: hold or release the caffeinate child now, and keep the menu checkbox
  // honest whichever surface flipped the setting
  applyKeepAwake(s.keepAwake)
  setKeepAwakeChecked(s.keepAwake)
  return s
}

async function createClaudeSession(opts: CreateTabOptions): Promise<CreateTabResult> {
  const key =
    (typeof opts.cwd === 'string' ? parseRemoteKey(opts.cwd) : null) ??
    remoteKeyOfSession(opts.resumeSessionId)
  if (key) {
    return createRemoteClaudeTab(key, {
      resumeSessionId: opts.resumeSessionId,
      cols: opts.cols,
      rows: opts.rows,
      worktree: opts.worktree
    })
  }
  const cwd = resolveSpawnCwd(opts.cwd)
  return createClaudeTab(cwd, opts.resumeSessionId, opts.cols, opts.rows, opts.worktree)
}

async function resumeClaudeSession(req: SessionResumeRequest): Promise<SessionResumeResult> {
  const sid = req?.sessionId
  const cwd = req?.cwd
  if (
    typeof sid !== 'string' ||
    !/^[a-zA-Z0-9-]+$/.test(sid) ||
    typeof cwd !== 'string' ||
    !path.isAbsolute(cwd)
  ) {
    return { ok: false, code: 'invalid-args' }
  }
  const remoteKey = remoteKeyOfSession(sid)
  if (remoteKey) {
    // no plan, no worktree rebuild and no "does the dir exist" gate: none of them
    // can see the machine, and the resume is simply `--resume <id>` over there
    const r = await createRemoteClaudeTab(remoteKey, {
      resumeSessionId: sid,
      cols: req.cols,
      rows: req.rows
    })
    return r.ok ? { ok: true, id: r.id, cwd: r.cwd } : { ok: false, code: r.code }
  }
  const mode = req.mode ?? 'direct'
  // §4.1 "Resume in new worktree" (D10): claude creates/enters it itself, spawning
  // from `cwd`. Same name shape createClaudeTab enforces — rejected here so a bad
  // name fails the call instead of silently resuming with no isolation.
  let worktree: string | undefined
  if (mode === 'renamed') {
    if (typeof req.worktree !== 'string' || !isValidWorktreeName(req.worktree)) {
      return { ok: false, code: 'invalid-args' }
    }
    worktree = req.worktree
  }
  if (mode === 'rebuild') {
    // the request's `rebuild` field is the renderer's copy of a plan main made —
    // display data. What git is actually pointed at is re-derived here from the
    // row and the probes main reads itself, so a stale or tampered payload can
    // never aim `git worktree add`. The refs still pass GIT_REF_RE: they come
    // from a transcript on disk and land in an argv.
    const plan = await resumePlanFor(sid)
    // the worktree reappeared (and reads green) between plan and click — there is
    // nothing to rebuild; resume directly rather than raising D12's escape for a race
    if (plan.action === 'direct') {
      const r = createClaudeTab(plan.cwd, sid, req.cols, req.rows)
      return r.ok ? { ok: true, id: r.id, cwd: r.cwd } : { ok: false, code: r.code }
    }
    if (
      plan.action !== 'rebuild' ||
      !GIT_REF_RE.test(plan.branch) ||
      !GIT_REF_RE.test(plan.baseRef)
    ) {
      return { ok: false, code: 'rebuild-failed' }
    }
    // a path outside a `.claude/worktrees` home is not malformed input, it is
    // simply not rebuildable — report it as a rebuild failure so the renderer can
    // offer D12's escape hatch instead of a dead end
    if (!(await rebuildWorktree(plan))) return { ok: false, code: 'rebuild-failed' }
  }
  // A3/V4: every mode spawns in the recorded cwd or not at all — never a fallback
  // dir (resolveSpawnCwd is for shells, not resumes). For a root-slug bound session
  // this is the ORIGINAL cwd and claude re-enters the worktree itself; mode 'main'
  // is D12's escape hatch, where forgoing that re-enter is the whole point. Checked
  // after the rebuild, which is what CREATES that dir when the session's own bucket
  // is the worktree (§1✎).
  let spawnCwd = cwd
  if (mode === 'main' && !dirExistsSync(spawnCwd)) {
    // D12's escape must not dead-end when the vanished dir IS the unrebuildable
    // worktree (worktree-slug bound sessions hand exactly that as resumeCwd):
    // "in main" literally means the repo root, so derive it from the binding —
    // main-side, never from renderer input.
    const wt = workspaceMgr?.findRow(sid)?.worktreeState?.worktreePath
    const root = wt ? worktreeHomeRoot(wt) : null
    if (root && dirExistsSync(root)) spawnCwd = root
  }
  if (!dirExistsSync(spawnCwd)) return { ok: false, code: 'cwd-missing' }
  const r = createClaudeTab(spawnCwd, sid, req.cols, req.rows, worktree)
  return r.ok ? { ok: true, id: r.id, cwd: r.cwd } : { ok: false, code: r.code }
}

/** the Workbench GitHub button's data, one instance for the whole app so its
 *  per-repository cache is shared by every session (§5). */
const githubLookup = new GithubLookup({
  fixture: parseGithubFixture(process.env.KOLOFT_GITHUB_FIXTURE),
  // D1: read at CLICK time, never from a snapshot taken minutes earlier. `logged_in` is
  // set on github.com for a signed-in browser; `user_session` is the session itself.
  signedIn: async () => {
    try {
      const jar = await session.fromPartition(BROWSER_PARTITION).cookies.get({
        domain: 'github.com'
      })
      return jar.some(
        (c) => (c.name === 'logged_in' && c.value === 'yes') || c.name === 'user_session'
      )
    } catch {
      return false
    }
  }
})

function registerIpc(): void {
  ipcMain.handle(
    'terminal:create',
    async (_e, opts: CreateTabOptions): Promise<CreateTabResult> => {
      if (
        opts.kind !== 'shell' &&
        !opts.resumeSessionId &&
        !loadSettings().sessionMethods.enabled[opts.kind]
      ) {
        throw new Error('This session method is disabled in Settings ▸ Sessions.')
      }
      if (opts.kind !== 'shell') return sessionBackends.create(opts)
      // A global-terminal tab belongs to no session (D1), so nothing overrides the cwd
      // the renderer resolved from the active-workspace chain (§04A) — main only runs it
      // through the shared existence fallback. `util` is what marks it a utility shell
      // (§06): hard-blocked for interactive claude, and cut off from the session env.
      const cwd = resolveSpawnCwd(opts.cwd)
      const handle = ptyMgr.create({
        kind: 'shell',
        cwd,
        cols: opts.cols,
        rows: opts.rows,
        setupCommand: setupLine(),
        util: opts.util === true,
        ownerTabId: typeof opts.ownerTabId === 'string' ? opts.ownerTabId : undefined
      })
      // D2: publish the tab's endpoint before anything can be typed in it. A utility
      // shell gets none (D9) — writeRelayEnv skips the ones ptyManager withheld the dir
      // from, and the shim reads the file, not the env.
      writeRelayEnv(ptyTabIds())
      return { ok: true, id: handle.id, cwd }
    }
  )

  ipcMain.on('terminal:write', (_e, id: string, data: string) => ptyMgr.write(id, data))
  // a real keystroke in a session's terminal restarts its close clock. Not
  // terminal:write: that also carries what xterm answers by itself (focus reports,
  // mouse reports, DA/CPR replies), which nobody typed.
  ipcMain.on('sessions:activity', (_e, id: unknown) => {
    if (typeof id === 'string' && id) tracker.noteActivity(id)
  })
  // xterm consumed a chunk (renderer aggregates the write-callback bytes). Renderer
  // input is untrusted: ignore anything but a positive finite count so a bad value
  // can never unblock a genuinely-behind gate or poison its accounting.
  ipcMain.on('terminal:ack', (_e, id: string, units: number) => {
    if (typeof units === 'number' && Number.isFinite(units) && units > 0) {
      if (flowGates.get(id)?.onAck(units)) {
        // send window just reopened — pump the held backlog now (see flushData)
        flushHeldData()
      }
    }
  })
  // the tab's TerminalView subscribed to terminal:data and will ack from now on —
  // only from this point may forwarded chunks count against its send window. Pump
  // any held backlog immediately: a remount mid-flood (renderer setting toggle)
  // disposed the old xterm with its acks, so no ack edge will ever re-arm the
  // flush — and a child that already finished writing produces no new 'data' to.
  ipcMain.on('terminal:attach', (_e, id: string) => {
    flowGateFor(id).attach()
    flushHeldData()
  })
  ipcMain.handle('terminal:flowStats', () =>
    [...flowGates.entries()].map(([id, gate]) => gate.stats(id))
  )
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    ptyMgr.resize(id, cols, rows)
  )
  ipcMain.on('terminal:kill', (_e, id: string) => killTabPty(id))

  ipcMain.handle('sessions:list', () => allSessions())
  // answered from the cached probe (codexSessions.availability) — opening a dialog must
  // never cost a login shell
  ipcMain.handle('sessions:backends', async () => [
    { id: 'claude', available: true },
    (await codexSessions?.availability()) ?? {
      id: 'codex',
      available: false,
      reason: codexStartupError ?? 'Codex is not ready.'
    }
  ])
  ipcMain.handle('attention:list', () => attention.list())
  // the adoption inventory — live ptys a fresh renderer rebuilds as tabs
  // instead of landing cold. KOLOFT_TEST_NO_ADOPT is the e2e seam that answers empty so
  // the orphan-session specs can still produce the adoption-failed fallback state.
  ipcMain.handle('tabs:list', (): TabInventoryReply => {
    // this call IS the renderer saying it is up — before the no-adopt early
    // return, because a test that turns adoption off still has a live document.
    rendererReady = true
    cronRunner?.onRendererReady()
    const active = activeTabBeforeReload
    activeTabBeforeReload = null
    if (process.env.KOLOFT_TEST_NO_ADOPT === '1') return { tabs: [], activeTabBeforeReload: null }
    // the guided-login pty is a hidden non-util shell the renderer must never learn
    // about — adopting it would surface a surprise tab AND fit-resize the deliberately
    // 800-column capture pty into hard-wrapping (truncating) the token mid-login
    const ptys = ptyMgr.list().filter((h) => !loginWatchers.has(h.id))
    const tracked = allSessions()
    const cwdByTab = new Map(tracked.map((s) => [s.tabId, s.cwd]))
    const tabs = adoptableTabs(
      // a remote tab's pty was spawned at this Mac's home; the renderer tells a remote
      // tab by its workspace key, so the inventory must carry the key, not that dir
      ptys.map((h) => {
        const remote = tracker.remoteOf(h.id)
        const cwd = cwdByTab.get(h.id)
        return remote && cwd ? { ...h, cwd: formatRemoteKey(remote.host, cwd) } : h
      }),
      tracked
    )
    // M5 repaint nudge, main half: pre-shrink each adopted claude pty by one row NOW,
    // before any TerminalView exists. The adopting renderer's natural fit then restores
    // the real size — ONE genuine SIGWINCH at a moment when the xterm is already that
    // size, so claude repaints exactly one full frame into a matching buffer. (Manual
    // round F1: renderer-side jiggles either coalesce into a no-change SIGWINCH —
    // blank tab — or make claude draw a frame into a mismatched xterm — statusline
    // ghost.) The shrunken frame claude answers THIS resize with is emitted before
    // any subscriber exists and drops harmlessly.
    for (const t of tabs) {
      if (t.kind === 'shell') continue
      const h = ptyMgr.get(t.id)
      if (h && h.alive && h.proc.rows > 1) ptyMgr.resize(t.id, h.proc.cols, h.proc.rows - 1)
    }
    return { tabs, activeTabBeforeReload: active }
  })
  // Passive active-tab report — fires on ANY activeTabId change, including
  // programmatic promotion (active tab closed → neighbor selected). Only treat it
  // as "the user looked" when the window is actually focused; and give the tab the
  // user just LEFT a chance to resurrect an event suppressed by stale context.
  ipcMain.on('attention:active-tab', (_e, id: string | null) => {
    const prevActive = uiActiveTabId
    uiActiveTabId = typeof id === 'string' && id ? id : null
    if (uiActiveTabId) tracker.noteActivity(uiActiveTabId)
    const ctx = attentionCtx()
    if (uiActiveTabId && ctx.windowFocused) {
      consumeOutletDedupe(uiActiveTabId)
      attention.clear(uiActiveTabId)
    }
    if (prevActive && prevActive !== uiActiveTabId) attention.reconsider(prevActive, ctx)
  })
  // Explicit user visit (a sidebar click) — always consumes the marker,
  // even when the window isn't focused (the click itself is the proof the user is
  // looking). The tab being LEFT gets the same stale-context reconsider as a tab-bar
  // switch: this handler moves uiActiveTabId before the renderer's active-tab report
  // arrives, so that report would see prev === current and never reconsider it.
  ipcMain.on('attention:visit', (_e, id: string) => {
    if (typeof id !== 'string' || !id) return
    const prevActive = uiActiveTabId
    uiActiveTabId = id
    tracker.noteActivity(id)
    consumeOutletDedupe(id)
    attention.clear(id)
    if (prevActive && prevActive !== id) attention.reconsider(prevActive, attentionCtx())
  })

  // ---- scheduled jobs --------------------------------------------------
  // The runner owns every rule, including the ones the form also checks: the store is
  // a plain file a person can edit, so `save` never trusts what arrives here.
  ipcMain.handle(
    'cron:list',
    () => cronRunner?.state() ?? { jobs: [], live: [], folders: {}, notes: {} }
  )
  // the runner is only null before whenReady finishes, where no dialog can exist yet;
  // the message is taken from the shared list rather than invented for that corner
  ipcMain.handle(
    'cron:save',
    (_e, input: CronSaveInput) =>
      cronRunner?.save(input) ?? { ok: false, errors: [CRON_SAVE_MESSAGES.workspace] }
  )
  ipcMain.handle('cron:delete', (_e, jobId: string) => cronRunner?.delete(jobId))
  ipcMain.handle('cron:setEnabled', (_e, arg: { jobId: string; on: boolean }) =>
    cronRunner?.setEnabled(arg.jobId, arg.on)
  )
  // no runner means the app is still booting, which is exactly what `not-ready` says
  ipcMain.handle(
    'cron:runNow',
    (_e, jobId: string) => cronRunner?.runNow(jobId) ?? { ok: false, reason: 'not-ready' }
  )
  // `listSkills` never throws — a missing or unreadable folder is an empty list
  ipcMain.handle('cron:skills', (_e, workspacePath: string) =>
    listSkills(skillFs, workspacePath, os.homedir())
  )
  // the form asks this once per open, to warn that a run here would stall on claude's
  // trust question before it ever starts
  ipcMain.handle('cron:trusted', (_e, workspacePath: string) => claudeTrusts(workspacePath))

  ipcMain.handle('claude:probe', () => probeClaude())

  // Self-update (manual, menu-triggered). The app is unsigned, so this is a DIY
  // download→swap→relaunch rather than Squirrel.Mac — see updater.ts. `download`
  // streams byte progress back to the modal and, on success, quits the app (the
  // detached installer relaunches the new bundle); errors reject so the modal shows them.
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:download', () =>
    downloadAndInstall((p) => sendToRenderer('update:progress', p))
  )
  ipcMain.on('update:restart', () => restartApp())
  ipcMain.handle('update:offer', () => currentOffer())
  // R3: the release page opens INSIDE Koloft now. The url is still the updater's
  // own (never the renderer's), and the click is the user's, so it shows at once.
  ipcMain.on('update:openRelease', () => sendOverlayOpen(releasePageUrl(), 'now'))
  // "What's new": the same release feed, asked for the span the user has not read
  // yet. The whole decision — including what gets remembered — is main's; the renderer
  // only opens a modal when this answers with one. A dev build's version never moves, so
  // it has nothing true to say (the rule updateNotifier.ts checks too).
  ipcMain.handle('update:whatsNew', async (): Promise<WhatsNew | null> => {
    if (!app.isPackaged && !fixturePath()) return null
    const { show, record } = await whatsNewDecision(
      loadSettings().lastSeenVersion,
      app.getVersion(),
      fetchPublishedReleases
    )
    if (record) commitSettings({ lastSeenVersion: record })
    return show
  })

  ipcMain.handle('accounts:list', () => accountViews())
  ipcMain.handle(
    'accounts:add',
    (
      _e,
      name: string,
      kind: AccountKind,
      secret: string,
      endpoint?: { baseUrl: string; model?: string }
    ) => addAccount(name, kind, secret, endpoint)
  )
  ipcMain.handle('accounts:remove', async (_e, name: string, kind: AccountKind) => {
    await keychainDelete(kind, name)
    removeAccountMeta(name, kind)
    usageViews.delete(viewKey(name, kind))
    // the scoring cache is the other copy of this row's usage, and it no longer expires
    picker.forget(kind, name)
    pushAccounts()
  })
  ipcMain.handle('accounts:toggle', (_e, name: string, kind: AccountKind, enabled: boolean) => {
    setAccountEnabled(name, kind, enabled === true)
    pushAccounts()
  })
  ipcMain.handle('accounts:probe', () => probeAllForPanel())
  ipcMain.handle('accounts:start-login', (_e, name: string, reauth?: boolean) => {
    // re-auth targets an account that already exists ON PURPOSE (the expired row's
    // the expired row's "Sign in again"), so the duplicate rule that guards fresh
    // adds must not fire here
    const v = reauth
      ? findAccount(name, 'oauth')
        ? 'ok'
        : 'unknown'
      : validateNewAccount(name, 'oauth')
    if (v !== 'ok') return v
    for (const id of loginWatchers.keys()) cancelGuidedLogin(id) // one at a time
    startGuidedLogin(name)
    return 'ok'
  })
  ipcMain.on('accounts:cancel-login', () => {
    for (const id of [...loginWatchers.keys()]) cancelGuidedLogin(id)
  })

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('settings:set', (_e, patch) => {
    // FR-13: the account registry never rides this channel — accounts persist only
    // via accounts:* (accounts.ts calls saveSettings directly). Without this strip,
    // a renderer patch carrying accounts:[] (the old reset bug) empties the pool.
    return commitSettings(sanitizeSettingsPatch(patch))
  })

  // ---- agent-centric workspace/session surface (Stage C renders this) ----------
  ipcMain.handle('workspace:add', (_e, p: string) => workspaceMgr?.add(p))
  // the workspace's scheduled jobs go with the pin, on both routes. `remove` only
  // unpins when it answers `removed`, so the jobs are only dropped in that case.
  ipcMain.handle('workspace:remove', (_e, p: string) => {
    const r = workspaceMgr?.remove(p)
    if (r?.removed) cronRunner?.removeWorkspace(p)
    return r
  })
  ipcMain.handle('workspace:removeConfirmed', async (_e, p: string) => {
    const codexTabs = new Set(
      (codexSessions?.rows(p) ?? [])
        .filter((r) => r.running || r.pending)
        .map((r) => (r.pending ? r.id : codexSessions?.aliveTabFor(r.id)))
        .filter((id): id is string => !!id)
    )
    await Promise.all([...codexTabs].map((id) => codexSessions?.stop(id)))
    workspaceMgr?.removeConfirmed(p)
    cronRunner?.removeWorkspace(p)
  })
  ipcMain.handle('workspace:rows', async () => {
    // never answer from the pre-scan empty cache (false "No workspace yet", review #3)
    await workspaceMgr?.firstScan
    return workspaceMgr?.rows() ?? []
  })
  ipcMain.handle('workspace:discover', () => workspaceMgr?.discover() ?? [])
  ipcMain.handle('workspace:worktrees', async (_e, p: string) => {
    const trees = (await workspaceMgr?.worktrees(p)) ?? []
    // recovery records match on originalCwd, which a remote key never equals
    if (!parseRemoteKey(p)) {
      for (const resource of codexSessions?.store.listResources() ?? []) {
        if (
          resource.originalCwd !== p ||
          (resource.state === 'ready' && dirExistsSync(resource.worktreePath))
        )
          continue
        const existing = trees.find((t) => t.dir === resource.worktreePath)
        if (existing) existing.recoveryResourceId = resource.id
        else
          trees.push({
            name: resource.worktreeName,
            dir: resource.worktreePath,
            branch: resource.worktreeBranch ?? undefined,
            recoveryResourceId: resource.id
          })
      }
    }
    return trees
  })
  ipcMain.handle('workspace:fetchFreshness', (_e, p: string) => freshness?.fetchNow(p) ?? null)
  ipcMain.handle(
    'workspace:pull',
    (_e, p: string, expect: { branch: string; head: string }) =>
      freshness?.pull(p, expect) ?? { ok: false, reason: 'state changed' }
  )
  // per-session Workbench state (§6/§7). Reads answer with the global default for a
  // session that has no entry yet, so the renderer never re-implements the fallback;
  // writes are debounced in the manager and flushed on quit.
  ipcMain.handle('workbench:get', (_e, sessionId: string) =>
    isCodexSession(sessionId) ? { open: false, tabs: [] } : workspaceMgr?.workbenchState(sessionId)
  )
  // D8: `open` plus the whole tab set, in one channel where v2 had setMode + setBrowser.
  // The renderer submits the whole state on every
  // structural change, main validates it and owns the (debounced) write. The submission
  // is untrusted input in exactly the way a hand-edited layout.json is, so it goes
  // through the ONE sanitizer both paths share (§Edge: per-item repair, never wholesale
  // rejection; truncation per kind to FR-22's cap).
  ipcMain.on('workbench:setState', (_e, sessionId: string, state: SessionWorkbenchState) => {
    if (typeof sessionId !== 'string' || !sessionId) return
    if (isCodexSession(sessionId)) return
    // a payload that isn't the shape at all is a bug on the wire, not a strip the user
    // emptied — drop it rather than let the sanitizer's empty default overwrite disk
    if (!state || typeof state !== 'object' || !Array.isArray(state.tabs)) return
    if (!workspaceMgr) return
    // A write for a session that is no longer in the working set is dropped by
    // `setWorkbenchState` itself (the lifecycle contract D13 — see the reasons there); the check
    // lives with the layout rather than here so no other caller can walk around it.
    workspaceMgr.setWorkbenchState(
      sessionId,
      sanitizeSessionWorkbench(state, workspaceMgr.defaultOpen())
    )
  })
  // FR-04/05 + R5: whether a session is SELECTED, and whether it can host a shell —
  // facts only the renderer holds (main tracks ptys and bindings, not the sidebar's
  // selection). Their consumers are the Focus Mode and New Terminal Tab menu items'
  // enabled flags, which a native accelerator cannot gate on its own. Reported on every
  // change; idempotent, so a duplicate costs nothing.
  ipcMain.on('workbench:available', (_e, available: unknown, terminal: unknown) => {
    setWorkbenchAvailable(available === true, terminal === true)
  })
  // file-edit B-12: whether an editor is on screen — again a renderer-only fact, and
  // again the only consumer is a menu item's enabled flag.
  ipcMain.on('workbench:findAvailable', (_e, available: unknown) => {
    setFindAvailable(available === true)
  })
  // file-edit B-15/B-16: whether anything is unsaved, which gates the Save item.
  ipcMain.on('workbench:saveAvailable', (_e, available: unknown) => {
    setSaveAvailable(available === true)
  })
  ipcMain.on('workbench:dirtyTabs', (_e, ids: unknown) => {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) return
    dirtyTabIds.clear()
    for (const id of ids as string[]) dirtyTabIds.add(id)
  })
  // archive: deregister only — the jsonl stays for a future import.
  // Main re-checks liveness; the renderer's menu gating is cosmetic, not the guard.
  ipcMain.handle('sessions:archive', (_e, id: unknown): boolean => {
    if (typeof id !== 'string' || !id) return false
    return sessionBackends.forSession(id).archive(id)
  })

  // F7: the way out of a row that is running with no tab to open — a renderer reload
  // drops its tabs while main keeps the ptys. The asking renderer has lost the binding
  // by definition, so main resolves the session id itself and kills only what that
  // resolves to: a transcript kept fresh by a claude running outside Koloft binds no tab
  // here, and nothing may be killed for it.
  ipcMain.handle('sessions:forceClose', async (_e, id: unknown): Promise<{ ok: boolean }> => {
    if (typeof id !== 'string' || !id) return { ok: false }
    const tabId = isCodexSession(id) ? codexSessions?.aliveTabFor(id) : tracker.aliveTabFor(id)
    if (!tabId) return { ok: false }
    if (isCodexSession(id)) await codexSessions?.stop(tabId)
    else killTabPty(tabId)
    return { ok: true }
  })

  // the pre-kill gate for ⇧⌘R. The renderer has no filesystem of its own, and
  // `jsonlPath` is a hook-reported PREDICTION — Claude Code creates the file at the first
  // user message — so only main can say whether there is a conversation to resume.
  ipcMain.handle('sessions:transcriptExists', (_e, id: unknown): boolean | Promise<boolean> => {
    if (typeof id !== 'string' || !id) return false
    return sessionBackends.forSession(id).transcriptExists(id)
  })

  // the lifecycle contract D5: "Restore from history" = the workspace's sessions that are not
  // working-set members (main computes the set; the dialog only renders it).
  ipcMain.handle('workspace:historyRows', async (_e, p: string) => {
    const legacy = (workspaceMgr?.historyRows(p) ?? []).filter((r) => !isCodexSession(r.id))
    try {
      const codex =
        parseRemoteKey(p) || !(await codexSessions?.availability())?.available
          ? []
          : ((await codexSessions?.historyRows(p)) ?? [])
      return [...legacy, ...codex].sort((a, b) => b.mtime - a.mtime)
    } catch (error) {
      if (!legacy.length) throw error
      sendToRenderer(
        'cron:toast',
        `Codex history could not be read. Showing Claude history. ${String(error)}`
      )
      return legacy
    }
  })

  // the lifecycle contract §4 (D6/D8/D9): main reads the binding and probes the worktree, the
  // renderer only renders the verdict. The row comes from the UNFILTERED aggregation —
  // a history session has no sidebar row to carry it.
  ipcMain.handle('sessions:resumePlan', (_e, id: unknown): Promise<ResumePlan> => {
    if (typeof id !== 'string' || !id) {
      return Promise.resolve({ action: 'unavailable', reason: 'not-found' })
    }
    // a remote session resumes straight into its recorded directory ON THE MACHINE:
    // every branch of the planner probes this Mac's git and would answer about a
    // stranger's disk, and `--resume` finds the session wherever it is.
    // R13: `row.cwd` here is rowCwd — the directory written on the transcript's
    // first line, the only one a cold row has. This is one of its three allowed homes
    // (the others being the cold-row resume plan and its worktree-deleted gate), and it
    // deliberately stays rowCwd: nothing on this Mac may resolve a path over there.
    const row = remoteKeyOfSession(id) ? workspaceMgr?.findRow(id) : undefined
    if (row) return Promise.resolve({ action: 'direct', cwd: row.cwd })
    return resumePlanFor(id)
  })

  ipcMain.handle('sessions:resume', (_e, req: SessionResumeRequest) => {
    if (typeof req?.sessionId !== 'string') return { ok: false, code: 'invalid-args' }
    return sessionBackends.forSession(req.sessionId).resume(req)
  })

  // synchronous so the renderer has the dev flag on its very first paint (no
  // badge flash). registerIpc() runs before createWindow(), so it's ready.
  ipcMain.on('app:isDev', (e) => {
    e.returnValue = !app.isPackaged
  })

  // file-edit B-26 — the two answers to `app:quit-requested`. "Held" means the renderer
  // has put the question in front of the user: the silence timer has to stop, or it
  // would quit out from under a dialog they are still reading. Cancel then needs no
  // message of its own — the guard is already back at rest, so the next ⌘Q asks afresh.
  ipcMain.on('app:quit-approved', () => {
    clearQuitFallback()
    // whatever was waiting on the answer — the updater's swap, a relaunch — or a plain
    // quit when the question came from ⌘Q
    approveAndRun(() => app.quit())
  })
  ipcMain.on('app:quit-held', () => {
    clearQuitFallback()
    resetQuitGuard()
  })
  // the user said no. It cannot stay silent: an armed installer or relaunch would
  // otherwise still be waiting for the next quit to set it off.
  ipcMain.on('app:quit-declined', () => {
    clearQuitFallback()
    declineQuit()
  })

  // Q2's else-branch: the renderer found another surface in the Workbench, so ⌥⌘I /
  // ⌘0± keep the whole-window meaning their Electron roles used to have. Only the
  // renderer knows which surface is active and only main can drive the host window, so
  // the arbitration happens there and the execution here. `sender` IS that renderer —
  // guests carry no preload and cannot reach this channel. ⌘R has no member in
  // WindowCommand: reloading the app window from a keystroke would kill every pty.
  ipcMain.on('shortcut:window', (e, cmd: WindowCommand) => applyWindowCommand(e.sender, cmd))

  // synchronous for the same reason: the renderer's LRU has to know the cap before it
  // mounts the first guest
  ipcMain.on('browser:guest-limit', (e) => {
    e.returnValue = browserGuestLimit()
  })
  // R1: the renderer naming (and un-naming) an overlay's guest. `sender` IS the app's
  // renderer — guests carry no preload and cannot reach this channel, so a page can
  // never claim to be an overlay and buy itself the popup/dialog treatment.
  ipcMain.on('browser:overlay-guest', (_e, guestId: unknown, on: unknown) => {
    if (typeof guestId !== 'number') return
    if (on) overlayGuests.add(guestId)
    else overlayGuests.delete(guestId)
  })
  // R1: the renderer has its overlay listener attached — anything that arrived while it
  // was still mounting can be handed over now.
  ipcMain.on('browser:overlay-ready', () => {
    overlayListening = true
    flushOverlayOpens()
  })
  // §4.1b: the strip, reported by the only side that has ever known it. The relay
  // keeps the last picture (so Target.getTargets needs no round trip) and turns each
  // push into the lifecycle events a connected client is owed.
  ipcMain.on('browser:strip', (_e, sessionId: unknown, targets: unknown) => {
    if (typeof sessionId !== 'string' || !Array.isArray(targets)) return
    relayStripChanged(sessionId, targets as BrowserStripTarget[])
  })
  ipcMain.on('browser:cdp-op-done', (_e, res: unknown) => {
    const r = res as BrowserCdpOpResult
    if (!r || typeof r.opId !== 'string') return
    const pending = cdpOps.get(r.opId)
    if (!pending) return
    cdpOps.delete(r.opId)
    pending(r)
  })
  // D15's ↗: the user choosing to leave. SEC-4 still applies — the escape hatch is a
  // choice about http(s), never a way to have Koloft launch an arbitrary handler.
  ipcMain.on('browser:open-external', (_e, url: string) => {
    if (typeof url === 'string') openUrlExternally(url)
  })
  // D13: devtools is per tab and detaches into its own window. Opened here rather than
  // through the <webview> element so the window's activation is Koloft's to decide, and so
  // SEC-15 is enforced where the request can be checked: only a live guest of the browser
  // partition is ever inspectable, so a stray id (a page's, an agent's) inspects nothing.
  // The request only ever arrives on a user gesture, so the window comes forward as
  // Chrome's does — behind Koloft it reads as ⌥⌘I doing nothing; R7's no-focus-steal rule is
  // about an automated run, and holds it back there alone.
  ipcMain.on('browser:devtools', (_e, id: unknown) => {
    if (typeof id !== 'number') return
    const guest = webContents.fromId(id)
    if (!guest || guest.getType() !== 'webview') return
    if (guest.session !== session.fromPartition(BROWSER_PARTITION)) return
    if (guest.isDevToolsOpened()) guest.closeDevTools()
    else guest.openDevTools({ mode: 'detach', activate: !BACKGROUND_TEST })
  })
  // browser-extensions D3–D7. Nothing here is trusted from the renderer beyond its own
  // report of which guest is on screen (D4) — the id is resolved against the browser
  // partition on the other side before the platform is told anything.
  // the store path an extension was loaded from is main's own business — what crosses is
  // the declared ExtensionInfo and nothing else
  ipcMain.handle('ext:list', () =>
    listExtensions().map(({ id, name, version, enabled }) => ({ id, name, version, enabled }))
  )
  ipcMain.handle('ext:set-enabled', (_e, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') return
    return setExtensionEnabled(id, enabled)
  })
  ipcMain.handle('ext:uninstall', (_e, id: unknown) => {
    if (typeof id === 'string') uninstallExtension(id)
  })
  ipcMain.on('ext:active-guest', (_e, id: unknown, url: unknown) => {
    if (typeof id === 'number') reportActiveGuest(id, typeof url === 'string' ? url : '')
  })
  // the strip could not take an open at all (no session owns the tab it was addressed
  // to): whoever is waiting on that url is told now instead of timing out
  ipcMain.on('ext:open-dropped', (_e, url: unknown) => {
    if (typeof url === 'string') reportOpenDropped(url)
  })
  ipcMain.handle('ext:popup-anchor', (_e, rect: ExtensionPopupAnchor) => {
    if (!rect) return
    const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
    // setBounds with a NaN in it is an exception, and a rect is measured in the renderer
    if (finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height)) {
      beforeActivate(rect)
    }
  })
  ipcMain.on('ext:dismiss-popup', () => dismissActionPopup())
  ipcMain.on('ext:permission-answer', (_e, id: unknown, granted: unknown) => {
    if (typeof id === 'string') answerPermissionRequest(id, granted === true)
  })

  // B7/B8: the user's word on one page-permission prompt. Remembered per site for the
  // rest of this run, and never written to disk.
  ipcMain.on('browser:permission-answer', (_e, id: unknown, granted: unknown) => {
    if (typeof id !== 'string') return
    answerPermission(id, granted === true)
  })

  // The surface took a bar down without an answer (a session switch). The page must
  // still be told something, or its call hangs forever and every later request for the
  // same thing joins the entry nobody will ever answer.
  ipcMain.on('browser:permission-cancel', (_e, id: unknown) => {
    if (typeof id !== 'string') return
    const pending = pendingPermissions.get(id)
    if (pending) dropPermissions((p) => p === pending)
  })

  // B9: "Cancel" — stop a download that is still writing.
  ipcMain.on('browser:download-cancel', (_e, id: unknown) => {
    if (typeof id !== 'string') return
    liveDownloads.get(id)?.cancel()
  })

  // B9: "Retry" — ask for the same url again. The new download reuses the ROW it was
  // retried from: a fresh row per attempt would leave one file wearing three entries,
  // each with its own "Retry" button.
  ipcMain.on('browser:download-retry', (_e, id: unknown) => {
    if (typeof id !== 'string') return
    const url = downloadSources.get(id)
    if (!url) return
    retryTargets.set(url, id)
    sendToRenderer('browser:download-event', { id, kind: 'retrying' })
    session.fromPartition(BROWSER_PARTITION).downloadURL(url)
  })

  // B12: "Copy current URL". Main owns the clipboard write for the same reason the guest
  // context menu's copy-link does — it is the process that has the clipboard.
  ipcMain.on('browser:copy-text', (_e, text: unknown) => {
    if (typeof text !== 'string' || !text) return
    clipboard.writeText(text.slice(0, 8192))
  })

  // §07 #4: mute or unmute one tab's guest. Memory only — a restart starts unmuted.
  ipcMain.on('browser:set-muted', (_e, guestId: unknown, muted: unknown) => {
    if (typeof guestId !== 'number') return
    const contents = webContents.fromId(guestId)
    if (!contents || contents.session !== session.fromPartition(BROWSER_PARTITION)) return
    contents.setAudioMuted(muted === true)
  })

  // SEC-8: the user walked past the interstitial. Awaited by the renderer before it
  // retries, so the reload is the first request the exception applies to.
  ipcMain.handle('browser:cert-proceed', (_e, url: string) => {
    const host = certHostOf(typeof url === 'string' ? url : '')
    if (!host) return
    trustedCertHosts.add(host)
  })
  // SEC-11/D11: "Clear browsing data" is the whole partition, not its cookie jar. clearData()
  // takes the storage side (cookies, service workers, cache, IndexedDB…); the auth cache
  // and this process's certificate exceptions are separate stores that would otherwise
  // outlive it. The open connections go too: a pooled TLS socket is a handshake that
  // already happened, so a cleared exception would not be asked for again on it.
  ipcMain.handle('browser:clear-data', async () => {
    const ses = session.fromPartition(BROWSER_PARTITION)
    trustedCertHosts.clear()
    await ses.clearData()
    await ses.clearAuthCache()
    await ses.closeAllConnections()
  })
  ipcMain.on('browser:auth-answer', (_e, id: string, answer: BrowserDialogAnswer) => {
    const respond = pendingAuth.get(id)
    if (!respond) return
    pendingAuth.delete(id)
    // SEC-10: nothing is kept — the next challenge from the same origin asks again
    if (answer?.ok && typeof answer.username === 'string') {
      respond(answer.username, answer.password ?? '')
    } else respond()
  })

  // §05D-11: a guest is stopped inside window.alert/confirm/prompt until this reply
  // goes back, so the reply is DEFERRED, never returned from the handler — main renders
  // the modal and keeps running while that one guest's renderer waits. A refusal
  // (unknown kind, unreadable frame, or a modal already up) answers with the cancel the
  // page's call would get from a dismissed dialog, so no page is left blocked forever.
  ipcMain.on(
    'browser:js-dialog',
    (e, request: { kind?: unknown; message?: unknown; defaultValue?: unknown }) => {
      const cancel = { ok: false } satisfies BrowserDialogAnswer
      if (e.sender.session !== session.fromPartition(BROWSER_PARTITION)) {
        e.returnValue = cancel
        return
      }
      const dialog = jsDialogFor(request ?? {}, e.senderFrame?.url ?? '', modalSlotTaken())
      if (!dialog) {
        e.returnValue = cancel
        return
      }
      const id = crypto.randomUUID()
      // the tab can be closed while its page sits blocked: the reply channel dies with
      // the guest, and the one modal slot must not stay taken by a page that is gone
      const gone = (): void => {
        pendingJsDialogs.delete(id)
      }
      pendingJsDialogs.set(id, (answer) => {
        e.sender.removeListener('destroyed', gone)
        e.returnValue = answer
      })
      e.sender.once('destroyed', gone)
      // R1: which guest asked, and whether it is an overlay's — the renderer draws an
      // overlay page's dialog on the overlay, since the pane it would otherwise use
      // belongs to a session and may not be mounted at all (§02).
      const payload: BrowserJsDialog = {
        id,
        ...dialog,
        guestId: e.sender.id,
        overlay: isOverlayGuest(e.sender)
      }
      sendToRenderer('browser:js-dialog', payload)
    }
  )
  ipcMain.on('browser:js-dialog-answer', (_e, id: string, answer: BrowserDialogAnswer) => {
    const respond = pendingJsDialogs.get(id)
    if (!respond) return
    pendingJsDialogs.delete(id)
    // what the page's call evaluates to: the typed text only when the user accepted
    respond(
      answer?.ok
        ? { ok: true, value: typeof answer.value === 'string' ? answer.value : '' }
        : { ok: false }
    )
  })

  // The read cap and the binary sniff now live in fileEdit.ts, where the editor's own
  // reader needs the same two. Tagged errors are mapped to UI states by the caller; the
  // message string survives the IPC boundary.
  ipcMain.handle('preview:readText', async (_e, p: string): Promise<string> => {
    if (typeof p !== 'string' || !p) throw new Error('KOLOFT_READ_FAILED')
    const st = await fs.promises.stat(p).catch(() => {
      throw new Error('KOLOFT_READ_FAILED')
    })
    if (!st.isFile()) throw new Error('KOLOFT_NOT_FILE')
    if (st.size > MAX_READ_BYTES) throw new Error('KOLOFT_TOO_LARGE')
    const buf = await fs.promises.readFile(p).catch(() => {
      throw new Error('KOLOFT_READ_FAILED')
    })
    if (looksBinary(buf)) throw new Error('KOLOFT_BINARY')
    return buf.toString('utf8')
  })
  ipcMain.handle('fs:listDir', (_e, p: string, opts?: { showIgnored?: boolean }) =>
    listDir(p, opts)
  )
  ipcMain.handle('fs:dirExists', (_e, p: string) =>
    typeof p === 'string' && p ? dirExists(p) : false
  )
  ipcMain.handle('fs:search', (_e, p: string, q: string, opts?: { showIgnored?: boolean }) =>
    search(p, q, opts)
  )
  // NFR-02: `base` is resolved once per Changes refresh and handed to the four consumers
  // below, so one refresh spawns ONE `symbolic-ref` + `merge-base` pair rather than four.
  // Anything but `HEAD` / a hex object id — the only two things `fs:diffBase` can have
  // answered — is dropped rather than forwarded: the base sits in an option-parsable slot
  // of git's argv, and a type check alone let `--output=<file>` through (measured; the
  // whitelist and its reasoning live with `sanitizeBase`).
  const baseArg = sanitizeBase
  // `untracked` is a renderer-side claim about its own status map, and only the literal
  // `true` is honoured — anything else takes the full probe path, so a malformed value can
  // at worst cost the spawns it was meant to save.
  const untrackedArg = (u: unknown): boolean => u === true
  ipcMain.handle('fs:diffBase', (_e, root: string) =>
    typeof root === 'string' && root ? diffBase(root) : null
  )
  ipcMain.handle('fs:gitStatus', (_e, root: string, base?: unknown) =>
    typeof root === 'string' && root ? gitStatus(root, baseArg(base)) : {}
  )
  ipcMain.handle('fs:gitNumstat', (_e, root: string, base?: unknown) =>
    typeof root === 'string' && root ? gitNumstat(root, baseArg(base)) : {}
  )
  ipcMain.handle('fs:gitDiff', (_e, root: string, base?: unknown) =>
    typeof root === 'string' && root
      ? gitDiff(root, baseArg(base))
      : { text: '', truncated: false, notRepo: true, toplevel: null }
  )
  ipcMain.handle('fs:gitFileDiff', (_e, p: string, base?: unknown, untracked?: unknown) =>
    typeof p === 'string' && p
      ? gitFileDiff(p, baseArg(base), untrackedArg(untracked))
      : { text: '', truncated: false }
  )
  ipcMain.handle('fs:gitFileDiffFull', (_e, p: string, base?: unknown, untracked?: unknown) =>
    typeof p === 'string' && p
      ? gitFileDiffFull(p, baseArg(base), untrackedArg(untracked))
      : { text: '', truncated: false }
  )
  ipcMain.handle(
    'fs:searchContent',
    (_e, root: string, q: string, opts?: { showIgnored?: boolean }) =>
      typeof root === 'string' && root
        ? searchContent(root, q, opts)
        : { hits: [], truncated: false }
  )
  ipcMain.handle('fs:watchDir', (_e, root: string) =>
    typeof root === 'string' && root
      ? watchDir(root, (r) => sendToRenderer('fs:dir-changed', r))
      : false
  )
  ipcMain.on('fs:unwatchDir', (_e, root: string) => {
    if (typeof root === 'string' && root) unwatchDir(root)
  })
  // per-file watch behind the preview pane's auto-refresh (ref-counted in fileWatch.ts).
  // The fingerprint rides along with the news: an editor holding unsaved changes compares
  // it with its own to tell "someone else wrote this" from the echo of its own save.
  ipcMain.on('fs:watchFile', (_e, p: string) => {
    if (typeof p === 'string' && path.isAbsolute(p))
      watchPreviewFile(p, (fp, st) =>
        sendToRenderer('fs:file-changed', fp, { mtimeMs: st.mtimeMs, size: st.size })
      )
  })
  ipcMain.on('fs:unwatchFile', (_e, p: string) => {
    if (typeof p === 'string' && p) unwatchPreviewFile(p)
  })
  ipcMain.on('fs:reveal', (_e, p: string) => {
    if (typeof p === 'string' && p) void leaveForOS(p, 'reveal')
  })
  // §05: the editor's three channels — the only ones in Koloft that WRITE a user file.
  // Each argument is checked rather than trusted, and everything they can refuse crosses as
  // a `KOLOFT_*` message string; "the file changed under us" is a value, not a throw (see
  // EditWriteResult).
  ipcMain.handle('edit:open', (_e, p: unknown) => openForEdit(p as string))
  ipcMain.handle('edit:write', (_e, p: unknown, text: unknown, expect: unknown, opts: unknown) =>
    writeTextForEdit(
      p as string,
      text as string,
      expect,
      (opts ?? undefined) as { force?: unknown; eol?: unknown } | undefined
    )
  )
  ipcMain.handle('edit:create', (_e, dirPath: unknown, name: unknown) =>
    createFileForEdit(dirPath as string, name as string)
  )
  // hand back the note file for one PINNED workspace, making it if it is not there
  // yet. The renderer's argument is not trusted — anything that is not the path of a
  // workspace the user pinned answers null, and nothing is created for it, so this
  // channel can never write a folder anywhere the user did not ask for.
  ipcMain.handle('notes:path', (_e, ws: unknown) => {
    if (typeof ws !== 'string' || !ws) return null
    const pinned = (workspaceMgr?.pinnedPaths() ?? []).some((w) => w.path === ws)
    if (!pinned) return null
    return ensureNotesFile(notesBaseDir(), ws)
  })
  // the Workbench GitHub button. Two channels: one feeds what the button SAYS, the
  // other answers "this click goes where". The click one is separate because the login
  // detour (D1) is decided from the browser partition's cookies, which only main can read,
  // and must be decided at the moment of the click.
  ipcMain.handle('github:info', async (_e, root: unknown, force: unknown) => {
    if (typeof root !== 'string' || !root) return null
    // the local half is back in milliseconds and the strip draws it now; the pull-request
    // command takes seconds, so its answer is pushed when it lands rather than awaited
    const { now, settled } = await githubLookup.info(root, { force: force === true })
    if (settled)
      void settled.then(
        (info) => sendToRenderer('github:info', root, info),
        () => {}
      )
    return now
  })
  ipcMain.handle('github:target', (_e, root: unknown, what: unknown) => {
    if (typeof root !== 'string' || !root) return null
    if (what !== 'repo' && what !== 'pulls' && what !== 'pr') return null
    return githubLookup.target(root, what)
  })
  ipcMain.handle('preview:openFileDialog', async () => {
    const stub = process.env.KOLOFT_FILE_DIALOG_FILE
    if (stub) return takeQueuedPick(stub)
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // Add Workspace (C1 ⊞ / ⇧⌘O): pick the directory to pin. Normalization /
  // worktree rejection happens in workspace:add, not here.
  ipcMain.handle('workspace:pickFolder', async () => {
    // same test-only seam as preview:openFileDialog above, for the same reason: a
    // background e2e run must never raise a native panel, and's welcome makes the
    // folder pick a step the suite has to walk through (T-OB-03).
    const stub = process.env.KOLOFT_FILE_DIALOG_FILE
    if (stub) return takeQueuedPick(stub)
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  // Last-resort OS open for an intercepted `open` the renderer couldn't surface in-app
  // (no tab to attach the preview to — e.g. its last tab exited racing the open). Keeps the
  // "an intercepted open is never silently swallowed" invariant even in the tabless case.
  ipcMain.on('preview:os-open', (_e, p: string) => {
    if (typeof p === 'string' && p) osOpenFallback(p)
  })

  // synchronous so the renderer has the user's home on first paint (group label "~").
  // realpath'd to match the canonical root projectInfoFor produces (it realpaths cwd),
  // so a symlinked $HOME still compares equal and shows "~".
  ipcMain.on('app:home', (e) => {
    try {
      e.returnValue = fs.realpathSync(os.homedir())
    } catch {
      e.returnValue = os.homedir()
    }
  })
}
