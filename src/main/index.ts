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
import { PtyManager, tabInstancePid } from './ptyManager'
import { adoptableTabs } from './tabInventory'
import { allowCrashReload } from './crashGuard'
import { FlowGate } from './flowControl'
import { SessionTracker } from './sessionTracker'
import type { StatusEdge } from './sessionRuntime'
import { CodexSessions } from './codexSessions'
import { SessionBackends } from './sessionBackends'
import {
  BACKEND_LABEL,
  backendIdOf,
  capabilitiesFor,
  SUPPORTED_PAIRS
} from '@shared/sessionBackend'
import { AttentionTracker, type AttentionContext } from './attention'
import { route, dockBadgeText } from './notifyRouter'
import { setupShim, UTIL_TERMINAL_REFUSES_INTERACTIVE_CLAUDE } from './shim'
import { openDropTarget, type OpenDrop } from './openDrop'
import { openUrlExternally, osOpenFallback } from './osOpen'
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
import { HOOK_SCRIPT, setupHooks, writeTabHookSettings } from './hooks'
import { formatRemoteKey, hostOf } from '@shared/remoteKey'
import {
  defaultControlDir,
  ensureControlDir,
  rsyncPull,
  runSsh,
  runSshBytes,
  sshOptions
} from './remote/ssh'
import { ENSURE_SH, TMUX_CONF, UTIL_SH, utilClaudeGuard } from './remote/install'
import {
  buildMachinePackage,
  POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE,
  tmuxSessionName,
  UTIL_BIN_DIR,
  utilShellLine,
  type MachinePackage
} from './remote/launch'
import { machinePackageBase, mirrorHookDir, mirrorProjectsRoot } from './remote/paths'
import { RemoteSync } from './remote/sync'
import { readJsonDrop, watchJsonDrops, writeWholeBeforeVisible } from './jsonDrops'
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
import { dirExistsSync, gitProbes, type ResumeProbes } from './resumePlan'
import { ClaudeBackend, machineHookSettings, pickMachineAccount } from './backends/claude'
import { codexBackend, trustCodexFolder } from './backends/codex'
import { codexConfigFile } from './codexTrust'
import {
  CodexAccountPicker,
  codexHomeOf,
  codexHomes,
  limitsFrom,
  prepareCodexHome
} from './codexAccounts'
import { shq } from '@shared/shellQuote'
import { CronRunner, type LaunchRequest } from './cronRunner'
import { cronFilePath, loadCron, saveCron } from './cronStore'
import { listSkills, type SkillFs } from './skillList'
import { CRON_SAVE_MESSAGES } from '@shared/cronMessages'
import { GitFreshnessEngine } from './gitFreshness'
import { GithubLookup, parseGithubFixture, type GithubOptions } from './github'
import { restoredWindowGeometry, trackWindowState } from './windowState'
import { fullscreenOption, windowMinWidth } from './windowBounds'
import { closeAllFileWatchers, closeAllDirWatchers } from './fileWatch'
import { sanitizeBase } from './gitStatus'
import { Hosts } from './host/hosts'
import { localGitOut, localHost } from './host/localHost'
import { SshHost } from './host/sshHost'
import { projectInfoFor } from './projectInfo'
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
import {
  canOpenExternally,
  routeFor,
  type RouteDecision,
  type RouteSource
} from '@shared/browserRoute'
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
import { scanLeftovers, stopLeftover } from './leftovers'
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
  ArtifactView,
  BackendId,
  CodexLimits,
  CodexSignInResult,
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
  CronSaveInput,
  ProbeErrorKind,
  LeftoverProcess,
  ResumePlan,
  SessionInfo,
  AttentionEvent,
  AttentionKind,
  SessionResumeRequest,
  SpawnedTab,
  TabInventoryReply,
  OpenRequest,
  UsageSnapshot,
  WindowCommand,
  SessionWorkbenchState,
  Settings,
  HostId,
  TabKind,
  WhatsNew
} from '@shared/types'
import { AgentRequests, BUILTIN_VERBS } from './agentRequests'
import { cronVerb } from './agentCron'
import { workbenchVerbs } from './agentWorkbench'
import { sessionVerb } from './agentSessions'
import { claudePeerName } from './claudeSessionRegistry'
import { writeAgentPlugin } from './agentPlugin'

// PLATFORM§4
if (!app.isPackaged) app.setName('koloft-dev')

const BACKGROUND_TEST = process.env.KOLOFT_TEST_BACKGROUND === '1'
// PLATFORM§4
if (BACKGROUND_TEST && process.platform === 'darwin') {
  app.setActivationPolicy('accessory')
  app.dock?.hide()
}

const ptyMgr = new PtyManager()
const flowGates = new Map<string, FlowGate>()
function flowGateFor(id: string): FlowGate {
  let gate = flowGates.get(id)
  if (!gate) {
    gate = new FlowGate({ onPause: () => ptyMgr.pause(id), onResume: () => ptyMgr.resume(id) })
    flowGates.set(id, gate)
  }
  return gate
}
let resetAllFlow: () => void = () => {}
let flushHeldData: () => void = () => {}
const tracker = new SessionTracker()
let codexSessions: CodexSessions | null = null
let codexStartupError: string | undefined
const sessionBackends = new SessionBackends({
  prompted: consumeOutletDedupe,
  bound: (tabId, key) => cronRunner?.onBound(tabId, key),
  exited: (tabId, title) => attention.onExited(tabId, attentionCtx(), title),
  clearAttention: (tabId) => attention.clear(tabId),
  open: (tabId, target) => {
    if (path.isAbsolute(target) && !fs.existsSync(target)) return
    openInWorkbench(tabId, routeFor(target, 'agent'), 'agent', target)
  }
})
function allSessions(): SessionInfo[] {
  return sessionBackends.list()
}
tracker.pidOf = (tabId) => ptyMgr.pidOf(tabId)
const dirtyTabIds = new Set<string>()
tracker.activeTabId = () => uiActiveTabId
tracker.heldTabs = () => {
  const held = new Set(dirtyTabIds)
  for (const h of ptyMgr.list()) if (h.util && h.alive && h.ownerTabId) held.add(h.ownerTabId)
  return held
}
tracker.needsUser = (id) => attention.list().some((e) => e.tabId === id)
let leftovers: Record<string, LeftoverProcess[]> = {}
tracker.leftBehind = (sessionId) => !!leftovers[sessionId]?.length
const LEFTOVER_SCAN_MS = 30_000
async function refreshLeftovers(): Promise<void> {
  const next = await scanLeftovers()
  const changed = JSON.stringify(next) !== JSON.stringify(leftovers)
  leftovers = next
  if (changed) sendToRenderer('sessions:leftovers', next)
}
if (process.platform !== 'win32') {
  setInterval(() => void refreshLeftovers(), LEFTOVER_SCAN_MS).unref()
  void refreshLeftovers()
}
const attention = new AttentionTracker((pending, event) => {
  updateDockBadge(pending)
  retractStaleOsNotifications(pending)
  if (event && !event.resurrected) routeAttentionEvent(event)
})
let uiActiveTabId: string | null = null
let activeTabBeforeReload: string | null = null
function sessionTitleOf(tabId: string): string | undefined {
  return allSessions().find((s) => s.tabId === tabId)?.title
}
function attentionCtx(): AttentionContext {
  let focused = false
  try {
    focused = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()
  } catch {}
  return { windowFocused: focused, activeTabId: uiActiveTabId }
}

const ATTENTION_REASON: Record<AttentionKind, string> = {
  'turn-done': 'turn done — your move',
  approval: 'waiting for your approval',
  exited: 'session exited unexpectedly'
}

function projectFolderName(tabId: string): string | undefined {
  const root = allSessions().find((s) => s.tabId === tabId)?.treeRoot
  return root ? path.basename(root) : undefined
}

function updateDockBadge(pending: AttentionEvent[]): void {
  if (process.platform !== 'darwin') return
  const text = dockBadgeText(pending.length, loadSettings().dockBadge, BACKGROUND_TEST)
  if (text !== null) app.dock?.setBadge(text)
}

function pointFocusClearingAtTabBeforeFocusingWindow(tabId: string): void {
  uiActiveTabId = tabId
}

function activateTabFromNotification(tabId: string): void {
  const win = mainWindow
  if (win && !win.isDestroyed()) {
    pointFocusClearingAtTabBeforeFocusingWindow(tabId)
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

// PLATFORM§4
const osNotifications = new Map<string, Notification>()
;(globalThis as { __koloftOsNotifCount?: number }).__koloftOsNotifCount = 0

function retractStaleOsNotifications(pending: AttentionEvent[]): void {
  for (const [tabId, n] of osNotifications) {
    if (!pending.some((ev) => ev.tabId === tabId)) {
      try {
        n.close()
      } catch {}
      osNotifications.delete(tabId)
    }
  }
}

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
    } catch {}
  }
  osNotifications.set(event.tabId, n)
  n.show()
}

function notifyPlain(title: string, body: string): void {
  if (BACKGROUND_TEST || !Notification.isSupported()) return
  const g = globalThis as { __koloftOsNotifCount?: number }
  g.__koloftOsNotifCount = (g.__koloftOsNotifCount ?? 0) + 1
  new Notification({ title, body }).show()
}

const OUTLET_FLAP_DEDUPE_MS = 5000
const recentOutlets = new Map<string, number>()

function consumeOutletDedupe(tabId: string): void {
  recentOutlets.delete(`${tabId}:turn-done`)
  recentOutlets.delete(`${tabId}:approval`)
  recentOutlets.delete(`${tabId}:exited`)
}

function routeAttentionEvent(event: AttentionEvent): void {
  const outletKey = `${event.tabId}:${event.kind}`
  const lastAt = recentOutlets.get(outletKey)
  const now = Date.now()
  if (lastAt !== undefined && now - lastAt < OUTLET_FLAP_DEDUPE_MS) return
  recentOutlets.set(outletKey, now)
  const decision = route(
    event,
    { windowFocused: attentionCtx().windowFocused, backgroundTest: BACKGROUND_TEST },
    loadSettings()
  )
  if (decision.os) showOsNotification(event)
  if (decision.sound) shell.beep()
}
let mainWindow: BrowserWindow | null = null

// PLATFORM§5
function sendToRenderer(channel: string, ...args: unknown[]): boolean {
  try {
    const win = mainWindow
    if (!win || win.isDestroyed()) return false
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return false
    wc.send(channel, ...args)
    return true
  } catch {
    return false
  }
}

let webglRepairTimer: NodeJS.Timeout | undefined
const WEBGL_REPAIR_BURST_DEBOUNCE_MS = 500
function requestWebglRepair(): void {
  clearTimeout(webglRepairTimer)
  webglRepairTimer = setTimeout(
    () => sendToRenderer('webgl:repair'),
    WEBGL_REPAIR_BURST_DEBOUNCE_MS
  )
}

let workspaceMgr: WorkspaceManager | null = null

let freshness: GitFreshnessEngine | null = null
let remoteSync: RemoteSync | null = null
let machinePkg: MachinePackage | null = null
const remoteControlDir = defaultControlDir()

function machinePackage(): MachinePackage {
  if (machinePkg) return machinePkg
  const pkgFiles: Record<string, string | Buffer> = {
    'ensure.sh': ENSURE_SH,
    'hook.sh': HOOK_SCRIPT,
    'tmux.conf': TMUX_CONF,
    'util.sh': UTIL_SH,
    [`${UTIL_BIN_DIR}claude`]: utilClaudeGuard(UTIL_TERMINAL_REFUSES_INTERACTIVE_CLAUDE)
  }
  try {
    pkgFiles['statusline/ccstatusline.js'] = fs.readFileSync(bundlePath())
    pkgFiles['statusline/package.json'] = '{"type":"module"}\n'
    pkgFiles['statusline/theme.json'] = JSON.stringify(DEFAULT_THEME, null, 2)
    pkgFiles['statusline/run.sh'] = remoteWrapperScript()
  } catch (err) {
    console.error('[koloft] remote statusline bundle unreadable:', err)
  }
  return (machinePkg = buildMachinePackage(machinePackageBase(app.getPath('userData')), pkgFiles))
}

let cronRunner: CronRunner | null = null

const BOOT_TIME = Date.now()

let rendererReady = false

// CC§7
const usageViews = new Map<
  string,
  { usage?: UsageSnapshot; limits?: CodexLimits; probeError?: ProbeErrorKind }
>()

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
  if (BACKGROUND_TEST || !Notification.isSupported()) return
  new Notification({
    title: 'Claude account expired',
    body: `Account ${name} expired and left the pool — sign in again from Settings to restore it`
  }).show()
}

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
    if (result.usage) picker.cacheUsage(kind, name, result.usage)
  } else {
    const status = recordProbeOutcome(name, kind, result.error === 'expired' ? '401' : 'fail')
    usageViews.set(key, { ...usageViews.get(key), probeError: result.error })
    if (status === 'expired' && prevStatus !== 'expired') notifyExpired(name)
  }
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
  return watchJsonDrops(pickDir, (name) =>
    name.startsWith('req-') ? (obj): void => void handlePickRequest(pickDir, name, obj) : null
  )
}

function agentToolsFor(kind: TabKind, host: HostId): boolean {
  return (
    loadSettings().agentTools &&
    (kind === 'shell' || capabilitiesFor(kind, host).agentTools === true)
  )
}

function workspaceOfTab(tabId: string): string | undefined {
  const claudeSession = claudeBackend.sessionIdOf(tabId)
  return (
    codexSessions?.workspaceOfTab(tabId) ??
    (claudeSession ? workspaceMgr?.workspaceOf(claudeSession) : undefined)
  )
}

function pinnedWorkspaceOfTab(tabId: string): string | undefined {
  const workspace = workspaceOfTab(tabId)
  return workspace && workspaceMgr?.pinnedPaths().some((w) => w.path === workspace)
    ? workspace
    : undefined
}

function backendOfTab(tabId: string): BackendId {
  return backendIdOf(ptyMgr.get(tabId)?.kind) ?? 'claude'
}

const agentRequests = new AgentRequests({
  verbs: {
    ...BUILTIN_VERBS,
    cron: cronVerb({
      runner: () => cronRunner,
      pinnedWorkspaceOf: pinnedWorkspaceOfTab,
      backendOf: backendOfTab,
      sessionName: (tabId) => sessionTitleOf(tabId) ?? 'A session',
      toast: (text) => sendToRenderer('cron:toast', text),
      now: () => new Date()
    }),
    ...workbenchVerbs({
      open: (tabId, target, view) =>
        openInWorkbench(tabId, routeFor(target, 'agent'), 'agent', target, view),
      notesFileOf: (tabId) => {
        const workspace = pinnedWorkspaceOfTab(tabId)
        return workspace ? ensureNotesFile(notesBaseDir(), workspace) : undefined
      }
    }),
    session: sessionVerb({
      backendOf: backendOfTab,
      workspaceOf: workspaceOfTab,
      sessionsIn: (workspace) => allSessions().filter((s) => workspaceOfTab(s.tabId) === workspace),
      peerName: (sessionId) => claudePeerName(sessionId),
      launch: ({ backend, name, ...spec }) =>
        launchQuietTab(
          { kind: backend, name, ...spec, permission: 'default' },
          name ?? BACKEND_LABEL[backend]
        ),
      queue: async (tabId, text) => codexSessions?.queueMessage(tabId, text)
    })
  },
  tab: (tabId) => ptyMgr.get(tabId),
  enabled: (tabId) => {
    const kind = ptyMgr.get(tabId)?.kind
    return (
      kind !== undefined &&
      kind !== 'shell' &&
      agentToolsFor(kind, tracker.remoteOf(tabId) ? 'ssh' : 'local')
    )
  },
  alive: pidAlive
})

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
  try {
    writeWholeBeforeVisible(resPath, JSON.stringify(payload))
  } catch {}
  pushAccounts()
}

// CC§7
interface LoginWatch {
  name: string
  buf: string
  startedAt: number
  sawUrl: boolean
  done: boolean
}
const loginWatchers = new Map<string, LoginWatch>()
const loginPtys = new Set<string>()
const LOGIN_TIMEOUT_MS = 10 * 60_000
const LOGIN_BUF_MAX = 8192
const LOGIN_PTY_COLS_WIDER_THAN_TOKEN = 800
const ACCOUNT_PROBE_TIMEOUT_MS = 10_000
const AUTH_URL_RE = /https?:\/\/[^\s'"`<>]+/
// CC§7
const TOKEN_RE = /sk-ant-[A-Za-z0-9]{2,12}-[A-Za-z0-9_-]{24,}/

function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;?]*[A-Za-z]/g, '').replace(/[()][AB0]/g, '')
}

function sendLoginProgress(p: LoginProgress): void {
  sendToRenderer('accounts:login-progress', p)
}

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

function cancelGuidedLogin(tabId: string): void {
  const w = loginWatchers.get(tabId)
  if (!w) return
  w.done = true
  loginWatchers.delete(tabId)
  try {
    ptyMgr.kill(tabId)
  } catch {}
}

function startGuidedLogin(name: string): string {
  const handle = ptyMgr.create({
    kind: 'shell',
    cwd: os.homedir(),
    // CC§7
    cols: LOGIN_PTY_COLS_WIDER_THAN_TOKEN,
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
  const result = await probeAccount('oauth', token, { timeoutMs: ACCOUNT_PROBE_TIMEOUT_MS })
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
  const prev = findAccount(name, 'oauth')
  upsertAccountMeta({
    name,
    kind: 'oauth',
    enabled: prev ? prev.enabled : true,
    fable: result.ok && result.fable ? result.fable : (prev?.fable ?? 'unknown'),
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
  try {
    ptyMgr.kill(tabId)
  } catch {}
}

let probeAllInFlight: Promise<AccountView[]> | null = null

function probeAllForPanel(): Promise<AccountView[]> {
  if (probeAllInFlight) return probeAllInFlight
  const round = (async (): Promise<AccountView[]> => {
    const enabled = listAccounts().filter((a) => a.enabled)
    await Promise.all(
      enabled.map(async (a) => {
        if (a.kind === 'codex-home') return probeCodexAccount(a.name)
        const secret = await keychainRead(a.kind, a.name)
        if (!secret) return
        const result = await probeAccount(a.kind, secret, {
          timeoutMs: ACCOUNT_PROBE_TIMEOUT_MS,
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
  const baseUrl = endpoint?.baseUrl?.trim()
  const model = endpoint?.model?.trim() || undefined
  if (kind === 'custom' && !isHttpUrl(baseUrl)) return { ok: false, error: 'invalid-endpoint' }
  if (!(await keychainWrite(kind, name, trimmed))) return { ok: false, error: 'unknown' }
  const result = await probeAccount(kind, trimmed, {
    timeoutMs: ACCOUNT_PROBE_TIMEOUT_MS,
    baseUrl,
    model
  })
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
  if (result.ok && result.fable) recordFableCapability(name, kind, result.fable)
  const key = viewKey(name, kind)
  if (result.ok) usageViews.set(key, { usage: result.usage })
  else usageViews.set(key, { probeError: result.error })
  pushAccounts()
  const account = accountViews().find((a) => a.kind === kind && a.name === name)
  return result.ok ? { ok: true, account } : { ok: false, error: result.error, account }
}

const codexPicker = new CodexAccountPicker()
const codexSignInPtys = new Map<string, string>()
const CODEX_LIMITS_STALE_MS = 5 * 60_000

function codexSharedConfig(): string {
  return codexConfigFile(codexSessions?.defaultEnv)
}

// CODEX§15
function pickCodexHome(): { account: string; home: string } | undefined {
  if (!loadSettings().multiAccount) return undefined
  const views = accountViews()
  const picked = codexPicker.pick(views)
  if (!picked) return undefined
  const stale = views.some(
    (a) =>
      a.kind === 'codex-home' &&
      a.enabled &&
      (!a.limits || Date.now() - a.limits.at > CODEX_LIMITS_STALE_MS)
  )
  if (stale) void probeCodexAccounts()
  const home = codexHomeOf(app.getPath('userData'), picked.name)
  prepareCodexHome(home, codexSharedConfig())
  return { account: picked.name, home }
}

async function probeCodexAccount(name: string): Promise<void> {
  const acct = findAccount(name, 'codex-home')
  if (!acct || !codexSessions) return
  const key = viewKey(name, 'codex-home')
  try {
    const r = await codexSessions.readAccount(codexHomeOf(app.getPath('userData'), name))
    const status = r.signedIn ? 'ok' : acct.status === 'ok' ? 'expired' : acct.status
    if (status !== acct.status) upsertAccountMeta({ ...acct, status })
    usageViews.set(key, {
      limits: (r.signedIn && limitsFrom(r.limits, Date.now())) || usageViews.get(key)?.limits
    })
  } catch {
    usageViews.set(key, { ...usageViews.get(key), probeError: 'network' })
  }
  pushAccounts()
}

let codexProbeRound: Promise<void> | null = null

function probeCodexAccounts(): Promise<void> {
  codexProbeRound ??= Promise.all(
    listAccounts()
      .filter((a) => a.kind === 'codex-home' && a.enabled)
      .map((a) => probeCodexAccount(a.name))
  ).then(() => {
    codexProbeRound = null
  })
  return codexProbeRound
}

async function codexSignIn(name: string, again?: boolean): Promise<CodexSignInResult> {
  const v = again
    ? findAccount(name, 'codex-home')
      ? 'ok'
      : 'invalid-name'
    : validateNewAccount(name, 'codex-home')
  if (v !== 'ok') return { ok: false, error: v }
  const binary = (await codexSessions?.availability())?.available && codexSessions?.cliBinary
  if (!binary) return { ok: false, error: 'unavailable' }
  const home = codexHomeOf(app.getPath('userData'), name)
  prepareCodexHome(home, codexSharedConfig())
  const acct = findAccount(name, 'codex-home')
  upsertAccountMeta({
    name,
    kind: 'codex-home',
    enabled: acct?.enabled ?? true,
    fable: 'unknown',
    status: acct?.status ?? 'unverified',
    addedAt: acct?.addedAt ?? Date.now()
  })
  pushAccounts()
  const cwd = os.homedir()
  const handle = ptyMgr.create({
    kind: 'shell',
    cwd,
    cols: 100,
    rows: 30,
    launchCommand: `CODEX_HOME=${shq(home)} ${shq(binary)} login && exit`
  })
  codexSignInPtys.set(handle.id, name)
  return { ok: true, tabId: handle.id, cwd }
}

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
  // PLATFORM§15
  { scheme: 'crx', privileges: { bypassCSP: true } }
])

function takeStubbedDialogPick(queueFile: string): string | null {
  let queued: string[]
  try {
    queued = fs
      .readFileSync(queueFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return null
  }
  const picked = queued.shift()
  if (!picked) return null
  try {
    if (queued.length) fs.writeFileSync(queueFile, queued.join('\n') + '\n')
    else fs.rmSync(queueFile, { force: true })
  } catch {}
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

function hostPreload(): string {
  return path.join(__dirname, '../preload/index.js')
}

// PLATFORM§5
const teardownKilledPtys = new Set<string>()

function rendererTeardown(): void {
  rendererReady = false
  cronRunner?.onRendererTeardown()
  closeAllDirWatchers()
  closeAllFileWatchers()
  resetAllFlow()
  overlayListenerLost()
  if (uiActiveTabId !== null) activeTabBeforeReload = uiActiveTabId
  uiActiveTabId = null
  dirtyTabIds.clear()
  for (const h of ptyMgr.list()) if (h.util) teardownKilledPtys.add(h.id)
  ptyMgr.killUtilOrphans()
  ptyMgr.reapDead()
}

function createWindow(): void {
  const geo = restoredWindowGeometry()
  mainWindow = new BrowserWindow({
    ...geo.bounds,
    minWidth: windowMinWidth(geo.bounds.width),
    minHeight: 560,
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
      // PLATFORM§5
      backgroundThrottling: !BACKGROUND_TEST
    }
  })
  const appUrl = rendererUrl()
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    if (!enforceGuestAttach(webPreferences, params, hostPreload())) e.preventDefault()
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isAppNavigation(url, appUrl)) e.preventDefault()
  })
  // PLATFORM§5
  if (!BACKGROUND_TEST && geo.maximized && !geo.fullScreen) mainWindow.maximize()
  trackWindowState(
    mainWindow,
    BACKGROUND_TEST ? { maximized: geo.maximized, fullScreen: geo.fullScreen } : undefined
  )

  // PLATFORM§5
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    rendererTeardown()
  })
  mainWindow.on('closed', () => {
    rendererTeardown()
    mainWindow = null
  })
  // PLATFORM§5
  const crashReloads: number[] = []
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    if (!allowCrashReload(crashReloads, now)) {
      rendererTeardown()
      return
    }
    crashReloads.push(now)
    if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.reload()
  })
  // PLATFORM§20
  const WEBGL_REPAIR_BLUR_MS = 30_000
  let blurredAt = 0
  mainWindow.on('restore', requestWebglRepair)
  mainWindow.on('focus', () => {
    // PLATFORM§10
    sendToRenderer('window:focus', true)
    if (blurredAt && Date.now() - blurredAt > WEBGL_REPAIR_BLUR_MS) requestWebglRepair()
    blurredAt = 0
    if (uiActiveTabId) {
      consumeOutletDedupe(uiActiveTabId)
      attention.clear(uiActiveTabId)
    }
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

function rendererUrl(): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  return devUrl || pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString()
}

app.whenReady().then(() => {
  protocol.handle('koloft-file', async (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname)
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
  // PLATFORM§15
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
  muteGuestsUnderTest()
  setupGuestGestures()
  setupGuestLinkReports()
  setupPermissionCleanup()
  setupGuestBackgroundOpen()
  setupGuestAudioState()
  setupGuestFullscreen()

  const { shimDir, regDir, openDir, pickDir, agentDir } = setupShim()
  ptyMgr.shimDir = shimDir
  ptyMgr.regDir = regDir
  if (agentRequests.watch(agentDir)) {
    ptyMgr.agentDir = agentDir
    ptyMgr.agentPlugin = writeAgentPlugin(app.getPath('userData'))
    ptyMgr.agentToolsFor = agentToolsFor
  }
  claudeBackend.watchShimRegistrations(regDir)
  if (watchOpenRequests(openDir)) {
    ptyMgr.openDir = openDir
    sweepOpenRequests(openDir)
  }
  if (watchPickRequests(pickDir)) {
    ptyMgr.pickDir = pickDir
    ptyMgr.multiAccountOn = () => loadSettings().multiAccount
  }

  ptyMgr.cdpDir = cdpEnvDir()
  startRelay(relayDeps())
  setRelayEnabled(loadSettings().browserControl, ptyTabIds())

  const hookPaths = setupHooks()
  const statusline = setupStatusline()
  ptyMgr.makeHookSettings = (tabId) =>
    writeTabHookSettings(
      hookPaths,
      tabId,
      loadSettings().statuslineBuiltin ? statusLineSetting(statusline) : undefined,
      loadSettings().agentTools
    )
  claudeBackend.watchLocalHooks(hookPaths.regDir)

  const PTY_OUTPUT_COALESCE_ONE_FRAME_MS = 16
  const pendingData = new Map<string, string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flushData = (): void => {
    flushTimer = null
    for (const [id, data] of pendingData) {
      const gate = flowGateFor(id)
      const utf16Units = data.length
      if (!gate.maySend()) {
        gate.onBacklog(utf16Units)
        continue
      }
      if (!sendToRenderer('terminal:data', { id, data })) {
        gate.reset()
        pendingData.delete(id)
        continue
      }
      gate.onForwarded(utf16Units)
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
    if (!flushTimer) flushTimer = setTimeout(flushData, PTY_OUTPUT_COALESCE_ONE_FRAME_MS)
  })
  ptyMgr.on('process-title', (t: { id: string; name: string }) => {
    sendToRenderer('terminal:processTitle', t)
  })
  ptyMgr.on('cwd', (c: { id: string; cwd: string }) => {
    sendToRenderer('terminal:cwd', c)
  })
  ptyMgr.on('exit', (e) => {
    loginPtys.delete(e.id)
    const codexAccount = codexSignInPtys.get(e.id)
    if (codexAccount) {
      codexSignInPtys.delete(e.id)
      void probeCodexAccount(codexAccount)
    }
    if (teardownKilledPtys.delete(e.id)) {
      flowGates.get(e.id)?.reset()
      flowGates.delete(e.id)
      return
    }
    if (loginWatchers.has(e.id)) failLogin(e.id, 'setup-token exited without printing a token')
    claudeBackend.onPtyExit(e.id)
    attention.clear(e.id)
    flushData()
    // PLATFORM§21
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
    workspaceMgr?.launchEnded(e.id)
    cronRunner?.onPtyExit(e.id)
    sendToRenderer('terminal:exit', e)
  })
  tracker.on('update', (sessions: SessionInfo[]) => {
    sendToRenderer('sessions:update', allSessions())
    workspaceMgr?.onTrackerUpdate()
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
  tracker.on('relocated', (e: { tabId: string; dir: string }) => {
    sendToRenderer('session:relocated', e)
  })
  tracker.on('auto-close', ({ tabId }: { tabId: string }) => {
    sendToRenderer('tab:killedByMain', tabId)
    void killTabPty(tabId)
  })
  tracker.on('status', (t: StatusEdge) => {
    attention.onStatusChange(t.tabId, t.prev, t.next, attentionCtx(), sessionTitleOf(t.tabId))
    // ADR-0022
    cronRunner?.onStatus(t.tabId, t.prev, t.next)
  })

  const userData = app.getPath('userData')
  try {
    codexSessions = new CodexSessions(path.join(userData, 'sessions.json'), {
      pty: ptyMgr,
      runtime: tracker,
      projectInfo: projectInfoFor,
      changed: () => {
        sendToRenderer('sessions:update', allSessions())
        workspaceMgr?.onRemoteChanged()
      },
      events: (tabId, event) => sessionBackends.observe(tabId, event),
      error: (message) => sendToRenderer('cron:toast', message),
      trustFolder: trustCodexFolder,
      pickHome: pickCodexHome,
      homes: () => codexHomes(userData),
      openShimRoot: path.join(userData, 'codex-open'),
      agent: {
        enabled: () => agentToolsFor('codex', 'local'),
        answer: (tabId, dir, name, raw) => void agentRequests.answerFor(tabId, dir, name, raw)
      }
    })
  } catch (error) {
    codexStartupError = `Codex session data could not be loaded; the original file is preserved. ${String(error)}`
  }
  if (codexSessions) {
    sessionBackends.register(codexBackend(codexSessions, resumeProbes))
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
      const m = new Map<string, string>()
      for (const s of allSessions()) if (s.alive && s.sessionId) m.set(s.sessionId, s.tabId)
      for (const [key, tabId] of codexSessions?.runningBindings() ?? []) m.set(key, tabId)
      return m
    },
    killTab: (tabId) => void killTabPty(tabId),
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
    onRescanned: (wsPaths) => {
      void freshness?.refreshLocal(wsPaths)
      claudeBackend.watchRemoteHookMirrors()
    },
    jobCountFor: (wsPath) => cronRunner?.jobCountFor(wsPath) ?? 0,
    remoteProjectsRoot: (host) => mirrorProjectsRoot(userData, host),
    remoteRunning: (host) => remoteSync?.alive(host) ?? new Set(),
    remoteConnected: (host) => remoteSync?.connected(host) ?? false,
    remoteGit: (host, p) => remoteSync?.gitInfo(host, p),
    killRemoteSession: (host, sessionId) =>
      claudeBackend.endRemoteTmux(host, tmuxSessionName(sessionId))
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
    onChange: () => workspaceMgr?.onRemoteChanged(),
    onLeft: (host, ids) => claudeBackend.noticeRemoteExits(host, ids)
  })
  freshness = new GitFreshnessEngine({
    workspaces: () => workspaceMgr?.pinnedPaths() ?? [],
    autoFetch: () => loadSettings().gitAutoFetch,
    onChange: () => workspaceMgr?.restampLive()
  })
  workspaceMgr.start()
  freshness.start()
  ensureControlDir(remoteControlDir)
  remoteSync.start()

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
        const pinned = (workspaceMgr?.pinnedPaths() ?? []).map((w) => w.path)
        return loadCron(cronFs, cronFile, pinned)
      },
      save: (jobs) => saveCron(cronFs, cronFile, jobs)
    },
    isPinned: (p) => (workspaceMgr?.pinnedPaths() ?? []).some((w) => w.path === p),
    dirExists: (p) => hosts.of(p).dirExists(p),
    gitDirExists: (root) => hosts.of(root).dirExists(`${root}/.git`),
    worktreeDirExists: (root, name) => hosts.of(root).dirExists(`${worktreeHomeOf(root)}/${name}`),
    branchExists: (root, branch) =>
      gitProbes((dir, args) => hosts.of(dir).gitOut(dir, args)).branchExists(root, branch),
    countRunFolders,
    accountUsable: (backend) => sessionBackends.get(backend).accountUsable(),
    trusted: (wsPath, backend) => sessionBackends.get(backend).trustsFolder(wsPath),
    ready: () => rendererReady && BrowserWindow.getAllWindows().length > 0,
    launch: launchCronRun,
    killTab: (tabId) => void killTabPty(tabId),
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

  const sendGuestCommand = (cmd: ReturnType<typeof guestShortcut>): void => {
    if (!cmd) return
    if (cmd === 'find') sendToRenderer('shortcut:find')
    else if (cmd === 'cycle-next' || cmd === 'cycle-prev') {
      sendToRenderer('shortcut:workbench', cmd)
    } else sendToRenderer('shortcut:browser', cmd)
  }
  // PLATFORM§12
  const pdfKeepsItsNativeFind = (
    cmd: ReturnType<typeof guestShortcut>,
    contents: WebContents
  ): boolean => cmd === 'find' && contents.getURL().toLowerCase().endsWith('.pdf')
  // PLATFORM§7
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (!(input.meta || input.control)) return
      const cmd = guestShortcut(input)
      if (pdfKeepsItsNativeFind(cmd, contents)) return
      if (cmd) {
        event.preventDefault()
        sendGuestCommand(cmd)
      }
    })
    // PLATFORM§7
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
      if (pdfKeepsItsNativeFind(cmd, contents)) return
      if (cmd) sendGuestCommand(cmd)
    })
  })

  // PLATFORM§20
  powerMonitor.on('resume', requestWebglRepair)
  powerMonitor.on('unlock-screen', requestWebglRepair)
  powerMonitor.on('resume', () => void freshness?.sweep())
  // PLATFORM§3
  powerMonitor.on('resume', () => cronRunner?.onResume())
  screen.on('display-added', requestWebglRepair)
  screen.on('display-removed', requestWebglRepair)
  screen.on('display-metrics-changed', requestWebglRepair)

  createWindow()
  startUpdateNotifier((offer) => sendToRenderer('update:offer', offer))

  const capsuleShownSoLaunchProbeIsNotBilledForNothing = (): boolean =>
    loadSettings().multiAccount && listAccounts().some((a) => a.enabled && a.kind === 'oauth')
  if (capsuleShownSoLaunchProbeIsNotBilledForNothing()) {
    void probeAllForPanel().catch(() => {})
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitFallback: ReturnType<typeof setTimeout> | null = null
function clearQuitFallback(): void {
  if (quitFallback) clearTimeout(quitFallback)
  quitFallback = null
}

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
  const decision = quitDecision(Date.now())
  if (decision === 'wait') {
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
  cronRunner?.quitSweep()
  cronRunner?.stop()
  workspaceMgr?.dispose()
  freshness?.stop()
  remoteSync?.stop()
  closeAllDirWatchers()
  resetQuitGuard()
})

function setupLine(): string | undefined {
  if (!ptyMgr.shimDir) return undefined
  return `export PATH="${ptyMgr.shimDir}:$PATH"; hash -r 2>/dev/null; clear`
}

const processedOpenIds = new Set<string>()

function watchOpenRequests(openDir: string): fs.FSWatcher | null {
  return watchJsonDrops(openDir, () => (obj, full) => handleOpenRequest(obj as OpenDrop, full))
}

const OPEN_REQUEST_STILL_WANTED_MS = 60_000
function sweepOpenRequests(openDir: string): void {
  fs.readdir(openDir, (err, names) => {
    if (err) return
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const full = path.join(openDir, name)
      fs.stat(full, (e, st) => {
        if (e) return
        if (Date.now() - st.mtimeMs <= OPEN_REQUEST_STILL_WANTED_MS) {
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

// ADR-0009
const trustedCertHosts = new Set<string>()

// PLATFORM§12
function setupCertErrors(): void {
  app.on('certificate-error', (event, contents, url, _error, _cert, callback) => {
    if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
    event.preventDefault()
    callback(certTrusted(trustedCertHosts, certHostOf(url)))
  })
}

// ADR-0009
const permissionAnswers = new Map<string, boolean>()

// PLATFORM§5
interface PendingPermission {
  guestId: number
  origin: string
  permission: PermissionName
  answer: (granted: boolean) => void
}
const pendingPermissions = new Map<string, PendingPermission>()

function rememberedPermission(origin: string, permission: PermissionName): boolean | undefined {
  return permissionAnswers.get(permissionKeysFor(origin, permission)[0])
}

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

function answerPermission(id: string, granted: boolean): void {
  const pending = pendingPermissions.get(id)
  if (!pending) return
  pendingPermissions.delete(id)
  for (const key of permissionKeysFor(pending.origin, pending.permission)) {
    permissionAnswers.set(key, granted)
  }
  pending.answer(granted)
}

function dropPermissions(match: (p: PendingPermission) => boolean): void {
  for (const [id, pending] of [...pendingPermissions]) {
    if (!match(pending)) continue
    pendingPermissions.delete(id)
    pending.answer(false)
    sendToRenderer('browser:permission-drop', id)
  }
}

const pendingAuth = new Map<string, (username?: string, password?: string) => void>()

// PLATFORM§12
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

const pendingJsDialogs = new Map<string, (answer: BrowserDialogAnswer) => void>()

function modalSlotTaken(): boolean {
  return pendingAuth.size > 0 || pendingJsDialogs.size > 0
}

// PLATFORM§12
function setupGuestUnload(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('will-prevent-unload', (event) => {
      if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
      event.preventDefault()
    })
  })
}

const guestGestures = new WeakMap<WebContents, number>()
const CHROMIUM_USER_ACTIVATION_INPUTS = new Set(['mouseDown', 'keyDown'])

function setupGuestGestures(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('input-event', (_ev, input) => {
      if (CHROMIUM_USER_ACTIVATION_INPUTS.has(input.type)) {
        guestGestures.set(contents, Date.now())
      }
    })
  })
}

function takeGuestGesture(contents: WebContents): boolean {
  const fresh = gestureFresh(guestGestures.get(contents), Date.now())
  guestGestures.delete(contents)
  return fresh
}

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

// PLATFORM§8
function muteGuestsUnderTest(): void {
  if (!BACKGROUND_TEST) return
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setAudioMuted(true)
  })
}

// PLATFORM§12
function setupGuestLinkReports(): void {
  ipcMain.on('browser:link-blocked', (e, url: unknown) => {
    if (e.sender.session !== session.fromPartition(BROWSER_PARTITION)) return
    if (typeof url !== 'string' || !url) return
    sendToRenderer('browser:blocked-scheme', url.slice(0, 2048))
  })
}

function setupPermissionCleanup(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    // PLATFORM§5
    const guestId = contents.id
    contents.once('destroyed', () => {
      dropPermissions((pending) => pending.guestId === guestId)
    })
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
    if (isOverlayGuest(e.sender)) {
      routeGuestPopup(url.slice(0, 4096), e.sender)
      return
    }
    const tabId = uiActiveTabId
    if (!tabId) return
    const decision = routeFor(url.slice(0, 4096), 'user')
    if (decision.dest !== 'browser') {
      routeGuestPopup(url, e.sender)
      return
    }
    const payload: BrowserOpenRequest = { tabId, url: decision.target, source: 'agent' }
    sendToRenderer('browser:open', payload)
  })
}

function setupGuestFullscreen(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    let pageFullscreen = false
    // PLATFORM§7
    contents.on('input-event', (_event, input) => {
      if (!pageFullscreen || input.type !== 'rawKeyDown') return
      if ((input as { key?: string }).key !== 'Escape') return
      contents.executeJavaScript('document.exitFullscreen?.()').catch(() => {})
    })
    contents.on('enter-html-full-screen', () => {
      if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
      pageFullscreen = true
      sendToRenderer('browser:fullscreen', true)
    })
    contents.on('leave-html-full-screen', () => {
      if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
      pageFullscreen = false
      sendToRenderer('browser:fullscreen', false)
    })
  })
}

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

const overlayGuests = new Set<number>()

function isOverlayGuest(contents: WebContents): boolean {
  return overlayGuests.has(contents.id)
}

// PLATFORM§6
const pendingOverlayOpens: BrowserOverlayOpen[] = []
let overlayListening = false

function sendOverlayOpen(url: string, presentation: 'now' | 'background'): void {
  pendingOverlayOpens.push({ url, presentation })
  flushOverlayOpens()
}

function flushOverlayOpens(): void {
  if (!overlayListening) return
  while (pendingOverlayOpens.length) {
    if (!sendToRenderer('browser:overlay-open', pendingOverlayOpens[0])) return
    pendingOverlayOpens.shift()
  }
}

function overlayListenerLost(): void {
  overlayListening = false
}

const cdpOps = new Map<string, (res: BrowserCdpOpResult) => void>()
const boundSessions = new Map<string, string>()

function ptyTabIds(): string[] {
  return ptyMgr
    .list()
    .filter(
      (p) =>
        !p.util &&
        (p.kind === 'shell' ||
          capabilitiesFor(p.kind, tracker.remoteOf(p.id) ? 'ssh' : 'local').browserControl === true)
    )
    .map((p) => p.id)
}

function cdpOp(
  kind: BrowserCdpOp['kind'],
  sessionId: string,
  extra: { targetId?: string; url?: string } = {}
): Promise<BrowserCdpOpResult> {
  const opId = crypto.randomUUID()
  return new Promise<BrowserCdpOpResult>((resolve) => {
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
    sessionForTab: (tabId) => claudeBackend.sessionIdOf(tabId) ?? null,
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

function routeGuestPopup(url: string, from?: WebContents): void {
  if (from && isOverlayGuest(from)) {
    const decision = routeFor(url, 'user')
    if (decision.dest === 'browser') sendOverlayOpen(decision.target, 'now')
    else if (decision.dest === 'system') openUrlExternally(decision.target)
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
    const payload: OpenRequest = { tabId, path: decision.target, source: 'user' }
    sendToRenderer('preview:open-file', payload)
  } else if (decision.dest === 'system') {
    openUrlExternally(decision.target)
  } else {
    sendToRenderer('browser:blocked-scheme', url)
  }
}

async function openExtensionTab(url: string): Promise<WebContents | null> {
  const tabId = uiActiveTabId
  if (!tabId) return null
  const decision = routeFor(url, 'user')
  const extensionPage = /^chrome-extension:\/\//i.test(url)
  if (!extensionPage && decision.dest !== 'browser') return null
  const target = extensionPage ? url : decision.target
  const payload: BrowserOpenRequest = { tabId, url: target, source: 'user' }
  if (!sendToRenderer('browser:open', payload)) return null
  return awaitGuestFor(target)
}

const DEFAULT_BROWSER_GUEST_LIMIT = 12
function browserGuestLimit(): number {
  const injected = Number(process.env.KOLOFT_BROWSER_GUEST_LIMIT)
  return Number.isInteger(injected) && injected > 0 ? injected : DEFAULT_BROWSER_GUEST_LIMIT
}

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

const liveDownloads = new Map<string, Electron.DownloadItem>()

const downloadSources = new Map<string, string>()

const retryTargets = new Map<string, string>()

// PLATFORM§8
function allowPageFullscreenWithoutTheWindow(callback: (granted: boolean) => void): void {
  const win = mainWindow
  win?.setFullScreenable(false)
  callback(true)
  setImmediate(() => {
    if (win && !win.isDestroyed()) win.setFullScreenable(true)
  })
}

function setupBrowserPartition(): void {
  const ses = session.fromPartition(BROWSER_PARTITION)
  // PLATFORM§11
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const decision = permissionAsk(permission, (details ?? {}) as PermissionDetails)
    if (isOverlayGuest(_wc) && decision.kind === 'ask') {
      callback(false)
      return
    }
    if (decision.kind === 'allow') {
      if (permission === 'fullscreen') allowPageFullscreenWithoutTheWindow(callback)
      else callback(true)
      return
    }
    if (decision.kind === 'refuse') {
      callback(false)
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
    // PLATFORM§11
    callback(false)
    // PLATFORM§11
    if (permission !== 'openExternal') return
    const target = (details as { externalURL?: string }).externalURL ?? ''
    if (canOpenExternally(target) && takeGuestGesture(_wc)) openUrlExternally(target)
    else if (target) sendToRenderer('browser:blocked-scheme', target)
  })
  // PLATFORM§11
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    const decision = permissionAsk(permission, (details ?? {}) as PermissionDetails)
    if (decision.kind === 'allow') return true
    if (decision.kind !== 'ask') return false
    return rememberedPermission(decision.origin, decision.permission) ?? false
  })
  ses.protocol.handle('koloft-file', async () => new Response('Forbidden', { status: 403 }))
  // PLATFORM§12
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
  const guestUA = standardUserAgent(app.userAgentFallback, app.getName())
  ses.setUserAgent(guestUA)
  // PLATFORM§14
  const guestHints = chromeClientHints(guestUA)
  if (guestHints) {
    const managed = new Set(Object.keys(guestHints).map((k) => k.toLowerCase()))
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (!/^https:/i.test(details.url)) return callback({})
      const headers = details.requestHeaders
      for (const name of Object.keys(headers)) {
        if (managed.has(name.toLowerCase())) delete headers[name]
      }
      callback({ requestHeaders: { ...headers, ...guestHints } })
    })
  }
  ses.registerPreloadScript({
    type: 'frame',
    filePath: path.join(__dirname, '../preload/guest.js')
  })
  // PLATFORM§13
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders
    if (!headers || !isAttachmentResponse(headers)) return callback({})
    callback({ responseHeaders: { ...headers, 'x-content-type-options': ['nosniff'] } })
  })
  ses.on('will-download', (_e, item) => {
    const dir = process.env.KOLOFT_DOWNLOAD_DIR || app.getPath('downloads')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
    const name = uniqueDownloadName(
      safeDownloadName(suggestedDownloadName(item.getContentDisposition(), item.getFilename())),
      (candidate) => fs.existsSync(path.join(dir, candidate))
    )
    const savePath = path.join(dir, name)
    item.setSavePath(savePath)

    const url = item.getURL()
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
  const source: RouteSource = tab.util ? 'user' : 'agent'
  const decision = routeFor(p, source)
  if (decision.dest === 'browser' && loginPtys.has(obj.tabId)) {
    openUrlExternally(decision.target)
    return
  }
  if (!openInWorkbench(obj.tabId, decision, source, p) && decision.dest !== 'drop')
    osOpenFallback(p)
}

function openInWorkbench(
  tabId: string,
  decision: RouteDecision,
  source: 'agent' | 'user',
  osFallback?: string,
  view?: ArtifactView
): boolean {
  if (decision.dest === 'browser') {
    const payload: BrowserOpenRequest = { tabId, url: decision.target, source, osFallback }
    sendToRenderer('browser:open', payload)
    return true
  }
  if (decision.dest === 'preview' && fs.existsSync(decision.target)) {
    const payload: OpenRequest = { tabId, path: decision.target, source, view }
    sendToRenderer('preview:open-file', payload)
    return true
  }
  return false
}

function killTabPty(tabId: string): Promise<boolean> {
  const owner = sessionBackends.ownerOfTab(tabId)
  const stopped = owner ? Promise.resolve(owner.stop(tabId)) : Promise.resolve(ptyMgr.kill(tabId))
  attention.clear(tabId)
  relayTabClosed(tabId)
  boundSessions.delete(tabId)
  return stopped.then(
    () => true,
    (error) => {
      sendToRenderer('cron:toast', String(error))
      return false
    }
  )
}

function worktreeHomeOf(root: string): string {
  return `${root}/.claude/worktrees`
}

async function countRunFolders(root: string, slug: string): Promise<number> {
  const entries = await hosts.of(root).listDir(worktreeHomeOf(root), { showIgnored: true })
  return entries.filter((e) => e.isDir && e.name.startsWith(`${slug}-`)).length
}

async function launchQuietTab(
  options: CreateTabOptions & { kind: BackendId },
  title: string,
  jobId?: string
): Promise<string | null> {
  const r = await sessionBackends.create(options)
  if (!r.ok) return null
  const spawned: SpawnedTab = { id: r.id, kind: options.kind, cwd: r.cwd, title, jobId }
  sendToRenderer('terminal:spawned', spawned)
  return r.id
}

async function launchCronRun(
  req: LaunchRequest
): Promise<{ ok: true; tabId: string } | { ok: false }> {
  try {
    const tabId = await launchQuietTab(
      {
        kind: req.backend,
        cwd: req.cwd,
        worktree: req.worktree,
        model: req.model,
        effort: req.effort,
        permission: req.permission,
        firstPrompt: req.firstPrompt,
        name: req.name,
        scheduled: true
      },
      req.name,
      req.jobId
    )
    return tabId ? { ok: true, tabId } : { ok: false }
  } catch (err) {
    console.error('[koloft] a scheduled run could not be launched:', err)
    return { ok: false }
  }
}

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

const CRON_BIND_DEADLINE_MS = 90_000
function cronBindDeadlineMs(): number {
  return (
    (process.env.KOLOFT_TEST_BACKGROUND === '1' &&
      Number(process.env.KOLOFT_CRON_BIND_DEADLINE_MS)) ||
    CRON_BIND_DEADLINE_MS
  )
}

const resumeProbes: ResumeProbes = {
  dirExists: dirExistsSync,
  occupantOf: (dir) => sessionBackends.occupantOf(dir),
  ...gitProbes(localGitOut)
}

function commitSettings(patch: Partial<Settings>): Settings {
  const s = saveSettings(patch)
  sendToRenderer('settings:update', s)
  updateDockBadge(attention.list())
  setRelayEnabled(s.browserControl, ptyTabIds())
  applyKeepAwake(s.keepAwake)
  setKeepAwakeChecked(s.keepAwake)
  return s
}

const githubOptions: GithubOptions = {
  fixture: parseGithubFixture(process.env.KOLOFT_GITHUB_FIXTURE),
  signedIn: async () => {
    try {
      const jar = await session.fromPartition(BROWSER_PARTITION).cookies.get({
        domain: 'github.com'
      })
      // PLATFORM§32
      return jar.some(
        (c) => (c.name === 'logged_in' && c.value === 'yes') || c.name === 'user_session'
      )
    } catch {
      return false
    }
  }
}

const hosts = new Hosts(
  localHost(new GithubLookup(githubOptions)),
  (machine) =>
    new SshHost(machine, {
      run: (cmd, opts) => runSshBytes(machine, cmd, { controlDir: remoteControlDir, ...opts }),
      shell: (dir) => {
        ensureControlDir(remoteControlDir)
        return {
          spawnCwd: os.homedir(),
          shell: POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE,
          launchCommand: (tabId) =>
            utilShellLine({
              host: machine,
              sshOptions: sshOptions(remoteControlDir, false),
              machine: machinePackage(),
              tabId,
              dir
            })
        }
      },
      github: githubOptions,
      claude: {
        userData: app.getPath('userData'),
        controlDir: remoteControlDir,
        machinePackage,
        alive: () => remoteSync?.alive(machine) ?? new Set(),
        realPath: (p) => workspaceMgr?.realRemotePath({ host: machine, path: p }) ?? p,
        settings: loadSettings,
        pickAccount: () => pickMachineAccount(pickForLaunch),
        hookSettings: (tabId, dir) =>
          machineHookSettings(tabId, dir, loadSettings().statuslineBuiltin)
      }
    })
)

const claudeBackend = new ClaudeBackend({
  pty: ptyMgr,
  tracker,
  hosts,
  workspaces: () => workspaceMgr,
  remoteSync: () => remoteSync,
  userData: () => app.getPath('userData'),
  setupLine,
  ptysChanged: () => writeRelayEnv(ptyTabIds()),
  resumeProbes,
  events: (tabId, event) => sessionBackends.observe(tabId, event)
})
sessionBackends.register(claudeBackend)

// ADR-0007
function shrinkAdoptedClaudePtysOneRowSoFitRepaints(tabs: TabInventoryReply['tabs']): void {
  for (const t of tabs) {
    if (t.kind === 'shell') continue
    const h = ptyMgr.get(t.id)
    if (h && h.alive && h.proc.rows > 1) ptyMgr.resize(t.id, h.proc.cols, h.proc.rows - 1)
  }
}

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
      const requested = typeof opts.cwd === 'string' ? opts.cwd : ''
      const launch = hosts.of(requested).shell(requested)
      const handle = ptyMgr.create({
        kind: 'shell',
        cwd: launch.spawnCwd,
        cols: opts.cols,
        rows: opts.rows,
        setupCommand: setupLine(),
        launchCommand: launch.launchCommand,
        shell: launch.shell,
        util: opts.util === true,
        ownerTabId: typeof opts.ownerTabId === 'string' ? opts.ownerTabId : undefined
      })
      writeRelayEnv(ptyTabIds())
      return { ok: true, id: handle.id, cwd: launch.cwd }
    }
  )

  ipcMain.on('terminal:write', (_e, id: string, data: string) => ptyMgr.write(id, data))
  // PLATFORM§21
  ipcMain.on('sessions:activity', (_e, id: unknown) => {
    if (typeof id === 'string' && id) tracker.noteActivity(id)
  })
  ipcMain.on('terminal:ack', (_e, id: string, ackedUtf16Units: number) => {
    if (
      typeof ackedUtf16Units === 'number' &&
      Number.isFinite(ackedUtf16Units) &&
      ackedUtf16Units > 0
    ) {
      if (flowGates.get(id)?.onAck(ackedUtf16Units)) {
        flushHeldData()
      }
    }
  })
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
  ipcMain.on('terminal:kill', (_e, id: string) => void killTabPty(id))

  ipcMain.handle('sessions:list', () => allSessions())
  ipcMain.handle('sessions:backends', () =>
    sessionBackends.availability((id) => ({
      id,
      available: false,
      reason: codexStartupError ?? `${BACKEND_LABEL[id]} is not ready.`
    }))
  )
  ipcMain.handle('attention:list', () => attention.list())
  ipcMain.handle('tabs:list', (): TabInventoryReply => {
    rendererReady = true
    cronRunner?.onRendererReady()
    const active = activeTabBeforeReload
    activeTabBeforeReload = null
    if (process.env.KOLOFT_TEST_NO_ADOPT === '1') return { tabs: [], activeTabBeforeReload: null }
    // CC§7
    const ptys = ptyMgr.list().filter((h) => !loginWatchers.has(h.id))
    const tracked = allSessions()
    const cwdByTab = new Map(tracked.map((s) => [s.tabId, s.cwd]))
    const tabs = adoptableTabs(
      ptys.map((h) => {
        const remote = tracker.remoteOf(h.id)
        const cwd = cwdByTab.get(h.id)
        return remote && cwd ? { ...h, cwd: formatRemoteKey(remote.host, cwd) } : h
      }),
      tracked
    )
    // ADR-0007
    shrinkAdoptedClaudePtysOneRowSoFitRepaints(tabs)
    return { tabs, activeTabBeforeReload: active }
  })
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
  ipcMain.on('attention:visit', (_e, id: string) => {
    if (typeof id !== 'string' || !id) return
    const prevActive = uiActiveTabId
    uiActiveTabId = id
    tracker.noteActivity(id)
    consumeOutletDedupe(id)
    attention.clear(id)
    if (prevActive && prevActive !== id) attention.reconsider(prevActive, attentionCtx())
  })

  ipcMain.handle(
    'cron:list',
    () => cronRunner?.state() ?? { jobs: [], live: [], folders: {}, notes: {} }
  )
  ipcMain.handle(
    'cron:save',
    (_e, input: CronSaveInput) =>
      cronRunner?.save(input) ?? { ok: false, errors: [CRON_SAVE_MESSAGES.workspace] }
  )
  ipcMain.handle('cron:delete', (_e, jobId: string) => cronRunner?.delete(jobId))
  ipcMain.handle('cron:setEnabled', (_e, arg: { jobId: string; on: boolean }) =>
    cronRunner?.setEnabled(arg.jobId, arg.on)
  )
  ipcMain.handle(
    'cron:runNow',
    (_e, jobId: string) => cronRunner?.runNow(jobId) ?? { ok: false, reason: 'not-ready' }
  )
  ipcMain.handle('cron:skills', (_e, workspacePath: string) =>
    listSkills(skillFs, workspacePath, os.homedir())
  )
  ipcMain.handle('cron:trusted', (_e, workspacePath: string, backend: BackendId) =>
    sessionBackends.get(backend).trustsFolder(workspacePath)
  )

  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:download', () =>
    downloadAndInstall((p) => sendToRenderer('update:progress', p))
  )
  ipcMain.on('update:restart', () => restartApp())
  ipcMain.handle('update:offer', () => currentOffer())
  ipcMain.on('update:openRelease', () => sendOverlayOpen(releasePageUrl(), 'now'))
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
    // CODEX§15
    if (kind !== 'codex-home') await keychainDelete(kind, name)
    removeAccountMeta(name, kind)
    usageViews.delete(viewKey(name, kind))
    picker.forget(kind, name)
    pushAccounts()
  })
  ipcMain.handle('accounts:toggle', (_e, name: string, kind: AccountKind, enabled: boolean) => {
    setAccountEnabled(name, kind, enabled === true)
    pushAccounts()
  })
  ipcMain.handle('accounts:probe', () => probeAllForPanel())
  ipcMain.handle('accounts:start-login', (_e, name: string, reauth?: boolean) => {
    const v = reauth
      ? findAccount(name, 'oauth')
        ? 'ok'
        : 'unknown'
      : validateNewAccount(name, 'oauth')
    if (v !== 'ok') return v
    for (const id of loginWatchers.keys()) cancelGuidedLogin(id)
    startGuidedLogin(name)
    return 'ok'
  })
  ipcMain.handle('accounts:codex-sign-in', (_e, name: string, again?: boolean) =>
    codexSignIn(name, again === true)
  )
  ipcMain.on('accounts:cancel-login', () => {
    for (const id of [...loginWatchers.keys()]) cancelGuidedLogin(id)
  })

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('settings:set', (_e, patch) => {
    return commitSettings(sanitizeSettingsPatch(patch))
  })

  ipcMain.handle('workspace:add', (_e, p: string) => workspaceMgr?.add(p))
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
    await workspaceMgr?.firstScan
    return workspaceMgr?.rows() ?? []
  })
  ipcMain.handle('workspace:discover', () => workspaceMgr?.discover() ?? [])
  ipcMain.handle('workspace:worktrees', async (_e, p: string) => {
    const trees = (await workspaceMgr?.worktrees(p)) ?? []
    if (SUPPORTED_PAIRS.codex[hostOf(p)]) {
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
  ipcMain.handle('workbench:get', (_e, sessionId: string) =>
    workspaceMgr?.workbenchState(sessionId)
  )
  ipcMain.on('workbench:setState', (_e, sessionId: string, state: SessionWorkbenchState) => {
    if (typeof sessionId !== 'string' || !sessionId) return
    if (!state || typeof state !== 'object' || !Array.isArray(state.tabs)) return
    if (!workspaceMgr) return
    workspaceMgr.setWorkbenchState(
      sessionId,
      sanitizeSessionWorkbench(state, workspaceMgr.defaultOpen())
    )
  })
  ipcMain.on('workbench:available', (_e, available: unknown, terminal: unknown) => {
    setWorkbenchAvailable(available === true, terminal === true)
  })
  ipcMain.on('workbench:findAvailable', (_e, available: unknown) => {
    setFindAvailable(available === true)
  })
  ipcMain.on('workbench:saveAvailable', (_e, available: unknown) => {
    setSaveAvailable(available === true)
  })
  ipcMain.on('workbench:dirtyTabs', (_e, ids: unknown) => {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) return
    dirtyTabIds.clear()
    for (const id of ids as string[]) dirtyTabIds.add(id)
  })
  ipcMain.handle('sessions:archive', (_e, id: unknown): boolean => {
    if (typeof id !== 'string' || !id) return false
    return sessionBackends.forSession(id).archive(id)
  })

  ipcMain.handle('sessions:forceClose', async (_e, id: unknown): Promise<{ ok: boolean }> => {
    if (typeof id !== 'string' || !id) return { ok: false }
    const tabId = sessionBackends.forSession(id).aliveTabFor(id)
    if (!tabId) return { ok: false }
    return { ok: await killTabPty(tabId) }
  })

  // CC§2
  ipcMain.handle('sessions:transcriptExists', (_e, id: unknown): boolean | Promise<boolean> => {
    if (typeof id !== 'string' || !id) return false
    return sessionBackends.forSession(id).transcriptExists(id)
  })

  ipcMain.handle('workspace:historyRows', (_e, p: string) =>
    sessionBackends.historyRows(p, (id, error) =>
      sendToRenderer(
        'cron:toast',
        `${BACKEND_LABEL[id]} history could not be read. Showing the rest. ${String(error)}`
      )
    )
  )

  ipcMain.handle('sessions:leftovers', () => leftovers)
  ipcMain.handle('sessions:stopLeftover', async (_e, sessionId: unknown, pid: unknown) => {
    if (typeof sessionId !== 'string' || typeof pid !== 'number') return false
    const stopped = await stopLeftover(sessionId, pid)
    await refreshLeftovers()
    return stopped
  })

  ipcMain.handle('sessions:resumePlan', (_e, id: unknown): Promise<ResumePlan> => {
    if (typeof id !== 'string' || !id) {
      return Promise.resolve({ action: 'unavailable', reason: 'not-found' })
    }
    return sessionBackends.forSession(id).resumePlan(id)
  })

  ipcMain.handle('sessions:resume', (_e, req: SessionResumeRequest) => {
    if (typeof req?.sessionId !== 'string') return { ok: false, code: 'invalid-args' }
    return sessionBackends.forSession(req.sessionId).resume(req)
  })

  ipcMain.on('app:isDev', (e) => {
    e.returnValue = !app.isPackaged
  })

  ipcMain.on('app:quit-approved', () => {
    clearQuitFallback()
    approveAndRun(() => app.quit())
  })
  ipcMain.on('app:quit-held', () => {
    clearQuitFallback()
    resetQuitGuard()
  })
  ipcMain.on('app:quit-declined', () => {
    clearQuitFallback()
    declineQuit()
  })

  ipcMain.on('shortcut:window', (e, cmd: WindowCommand) => applyWindowCommand(e.sender, cmd))

  ipcMain.on('browser:guest-limit', (e) => {
    e.returnValue = browserGuestLimit()
  })
  ipcMain.on('browser:overlay-guest', (_e, guestId: unknown, on: unknown) => {
    if (typeof guestId !== 'number') return
    if (on) overlayGuests.add(guestId)
    else overlayGuests.delete(guestId)
  })
  ipcMain.on('browser:overlay-ready', () => {
    overlayListening = true
    flushOverlayOpens()
  })
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
  ipcMain.on('browser:open-external', (_e, url: string) => {
    if (typeof url === 'string') openUrlExternally(url)
  })
  ipcMain.on('browser:devtools', (_e, id: unknown) => {
    if (typeof id !== 'number') return
    const guest = webContents.fromId(id)
    if (!guest || guest.getType() !== 'webview') return
    if (guest.session !== session.fromPartition(BROWSER_PARTITION)) return
    if (guest.isDevToolsOpened()) guest.closeDevTools()
    else guest.openDevTools({ mode: 'detach', activate: !BACKGROUND_TEST })
  })
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
  ipcMain.on('ext:open-dropped', (_e, url: unknown) => {
    if (typeof url === 'string') reportOpenDropped(url)
  })
  ipcMain.handle('ext:popup-anchor', (_e, rect: ExtensionPopupAnchor) => {
    if (!rect) return
    const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
    // PLATFORM§5
    if (finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height)) {
      beforeActivate(rect)
    }
  })
  ipcMain.on('ext:dismiss-popup', () => dismissActionPopup())
  ipcMain.on('ext:permission-answer', (_e, id: unknown, granted: unknown) => {
    if (typeof id === 'string') answerPermissionRequest(id, granted === true)
  })

  ipcMain.on('browser:permission-answer', (_e, id: unknown, granted: unknown) => {
    if (typeof id !== 'string') return
    answerPermission(id, granted === true)
  })

  ipcMain.on('browser:permission-cancel', (_e, id: unknown) => {
    if (typeof id !== 'string') return
    const pending = pendingPermissions.get(id)
    if (pending) dropPermissions((p) => p === pending)
  })

  ipcMain.on('browser:download-cancel', (_e, id: unknown) => {
    if (typeof id !== 'string') return
    liveDownloads.get(id)?.cancel()
  })

  ipcMain.on('browser:download-retry', (_e, id: unknown) => {
    if (typeof id !== 'string') return
    const url = downloadSources.get(id)
    if (!url) return
    retryTargets.set(url, id)
    sendToRenderer('browser:download-event', { id, kind: 'retrying' })
    session.fromPartition(BROWSER_PARTITION).downloadURL(url)
  })

  ipcMain.on('browser:copy-text', (_e, text: unknown) => {
    if (typeof text !== 'string' || !text) return
    clipboard.writeText(text.slice(0, 8192))
  })

  ipcMain.on('browser:set-muted', (_e, guestId: unknown, muted: unknown) => {
    if (typeof guestId !== 'number') return
    const contents = webContents.fromId(guestId)
    if (!contents || contents.session !== session.fromPartition(BROWSER_PARTITION)) return
    contents.setAudioMuted(muted === true)
  })

  ipcMain.handle('browser:cert-proceed', (_e, url: string) => {
    const host = certHostOf(typeof url === 'string' ? url : '')
    if (!host) return
    trustedCertHosts.add(host)
  })
  // PLATFORM§12
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
    if (answer?.ok && typeof answer.username === 'string') {
      respond(answer.username, answer.password ?? '')
    } else respond()
  })

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
      const gone = (): void => {
        pendingJsDialogs.delete(id)
      }
      pendingJsDialogs.set(id, (answer) => {
        e.sender.removeListener('destroyed', gone)
        e.returnValue = answer
      })
      e.sender.once('destroyed', gone)
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
    respond(
      answer?.ok
        ? { ok: true, value: typeof answer.value === 'string' ? answer.value : '' }
        : { ok: false }
    )
  })

  ipcMain.handle('preview:readText', async (_e, p: string): Promise<string> => {
    if (typeof p !== 'string' || !p) throw new Error('KOLOFT_READ_FAILED')
    return hosts.of(p).readText(p)
  })
  ipcMain.handle('fs:listDir', (_e, p: string, opts?: { showIgnored?: boolean }) =>
    hosts.of(p).listDir(p, opts)
  )
  ipcMain.handle('fs:dirExists', (_e, p: string) =>
    typeof p === 'string' && p ? hosts.of(p).dirExists(p) : false
  )
  ipcMain.handle('fs:search', (_e, p: string, q: string, opts?: { showIgnored?: boolean }) =>
    hosts.of(p).search(p, q, opts)
  )
  const baseArg = sanitizeBase
  const untrackedArg = (u: unknown): boolean => u === true
  ipcMain.handle('fs:diffBase', (_e, root: string) =>
    typeof root === 'string' && root ? hosts.of(root).diffBase(root) : null
  )
  ipcMain.handle('fs:gitStatus', (_e, root: string, base?: unknown) =>
    typeof root === 'string' && root ? hosts.of(root).gitStatus(root, baseArg(base)) : {}
  )
  ipcMain.handle('fs:gitNumstat', (_e, root: string, base?: unknown) =>
    typeof root === 'string' && root ? hosts.of(root).gitNumstat(root, baseArg(base)) : {}
  )
  ipcMain.handle('fs:gitDiff', (_e, root: string, base?: unknown) =>
    typeof root === 'string' && root
      ? hosts.of(root).gitDiff(root, baseArg(base))
      : { text: '', truncated: false, notRepo: true, toplevel: null }
  )
  ipcMain.handle('fs:gitFileDiff', (_e, p: string, base?: unknown, untracked?: unknown) =>
    typeof p === 'string' && p
      ? hosts.of(p).gitFileDiff(p, baseArg(base), untrackedArg(untracked))
      : { text: '', truncated: false }
  )
  ipcMain.handle('fs:gitFileDiffFull', (_e, p: string, base?: unknown, untracked?: unknown) =>
    typeof p === 'string' && p
      ? hosts.of(p).gitFileDiffFull(p, baseArg(base), untrackedArg(untracked))
      : { text: '', truncated: false }
  )
  ipcMain.handle(
    'fs:searchContent',
    (_e, root: string, q: string, opts?: { showIgnored?: boolean }) =>
      typeof root === 'string' && root
        ? hosts.of(root).searchContent(root, q, opts)
        : { hits: [], truncated: false }
  )
  ipcMain.handle('fs:watchDir', (_e, root: string) =>
    typeof root === 'string' && root
      ? hosts.of(root).watchDir(root, (r) => sendToRenderer('fs:dir-changed', r))
      : false
  )
  ipcMain.on('fs:unwatchDir', (_e, root: string) => {
    if (typeof root === 'string' && root) hosts.of(root).unwatchDir(root)
  })
  ipcMain.on('fs:watchFile', (_e, p: string) => {
    if (typeof p === 'string' && path.isAbsolute(p))
      hosts.of(p).watchFile(p, (fp, st) => sendToRenderer('fs:file-changed', fp, st))
  })
  ipcMain.on('fs:unwatchFile', (_e, p: string) => {
    if (typeof p === 'string' && p) hosts.of(p).unwatchFile(p)
  })
  ipcMain.on('fs:reveal', (_e, p: string) => {
    if (typeof p === 'string' && p) hosts.of(p).reveal(p)
  })
  ipcMain.handle('edit:open', (_e, p: unknown) => hosts.of(p as string).openForEdit(p as string))
  ipcMain.handle('edit:write', (_e, p: unknown, text: unknown, expect: unknown, opts: unknown) =>
    hosts
      .of(p as string)
      .writeText(
        p as string,
        text as string,
        expect,
        (opts ?? undefined) as { force?: unknown; eol?: unknown } | undefined
      )
  )
  ipcMain.handle('edit:create', (_e, dirPath: unknown, name: unknown) =>
    hosts.of(dirPath as string).createFile(dirPath as string, name as string)
  )
  ipcMain.handle('notes:path', (_e, ws: unknown) => {
    if (typeof ws !== 'string' || !ws) return null
    const pinned = (workspaceMgr?.pinnedPaths() ?? []).some((w) => w.path === ws)
    if (!pinned) return null
    return ensureNotesFile(notesBaseDir(), ws)
  })
  ipcMain.handle('github:info', async (_e, root: unknown, force: unknown) => {
    if (typeof root !== 'string' || !root) return null
    const { now, settled } = await hosts.of(root).github.info(root, { force: force === true })
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
    return hosts.of(root).github.target(root, what)
  })
  ipcMain.handle('preview:openFileDialog', async () => {
    const stub = process.env.KOLOFT_FILE_DIALOG_FILE
    if (stub) return takeStubbedDialogPick(stub)
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('workspace:pickFolder', async () => {
    const stub = process.env.KOLOFT_FILE_DIALOG_FILE
    if (stub) return takeStubbedDialogPick(stub)
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.on('preview:os-open', (_e, p: string) => {
    if (typeof p === 'string' && p) hosts.of(p).osOpen(p)
  })

  ipcMain.on('app:home', (e) => {
    try {
      e.returnValue = fs.realpathSync(os.homedir())
    } catch {
      e.returnValue = os.homedir()
    }
  })
}
