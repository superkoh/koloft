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
import { anotherLiveInstanceOwns, PtyManager } from './ptyManager'
import { adoptableTabs } from './tabInventory'
import { allowCrashReload } from './crashGuard'
import { FlowGate } from './flowControl'
import { SessionTracker, type ToolCall } from './sessionTracker'
import type { CommandOutput } from './claudeCommandOutput'
import type { StatusEdge, TurnOverEdge } from './sessionRuntime'
import { CodexSessions } from './codexSessions'
import { MuseSessions, museShowsItsInputBox, type MuseRemoteDeps } from './museSessions'
import { MUSE_HOOK_FILE, MUSE_WRAP_FILE, MUSE_WRAP_PY, REMOTE_MUSE_HOOK_SH } from './museRemote'
import type { TreeIo } from './sessionWorktrees'
import { museServersAmong } from './taskProcs'
import { sharedProcessTable } from './processTable'
import { AgySessions } from './agySessions'
import {
  agyAccountEnv,
  agyHomeOf,
  agySignedIn,
  oneShotAgyHome,
  prepareAgyHome,
  readAgyQuota,
  setAgyApiKeyRoute
} from './agyAccounts'
import { AGY_APP_DIR, AGY_LIST_JS, ownersGeminiDir } from './agyStore'
import { AGY_HOOK_SCRIPT, AGY_TITLE_SCRIPT } from './agyHooks'
import {
  AGY_BRAIN_FLAGS,
  AGY_HOOK_FILE,
  AGY_LIST_FILE,
  AGY_REMOTE_BRAIN,
  AGY_STATUSLINE_FILE,
  AGY_TITLE_FILE,
  agyStatuslineScript
} from './remote/agyTab'
import { agyBackend } from './backends/agy'
import { museAccountEnv, museHomeOf, prepareMuseHome } from './museAccounts'
import { museConfigHome } from './museSessionLog'
import { museSignIn, storeMuseKey } from './museServe'
import { readMuseQuota } from './museQuota'
import type { SessionsWithStore } from './storedSessions'
import type { SessionEvent } from '@shared/sessionEvent'
import type { WorktreeResource } from './sessionStore'
import {
  OpenTabsFile,
  openTabsNow,
  readOpenTabs,
  restorePlan,
  type OpenTab,
  type OpenTabs
} from './openTabs'
import { SessionAccounts } from './sessionAccounts'
import { SessionBackends } from './sessionBackends'
import {
  BACKEND_LABEL,
  backendIdOf,
  capabilitiesFor,
  identityOf,
  backendsFrom,
  messagingOf,
  PEER_TRAITS,
  reachedBySendMessage,
  preferredAssistBackend,
  statusUnavailable
} from '@shared/sessionBackend'
import type { Turn } from '@shared/turns'
import { AttentionTracker, type AttentionContext } from './attention'
import { flushAttention, loadLastRunAttention, saveAttention } from './attentionFile'
import { route, dockBadgeText } from './notifyRouter'
import { setupShim, utilTerminalGuard } from './shim'
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
import { stripTerminalCodes } from './terminalCodes'
import {
  CODEX_REPLY_LANGUAGE_SCRIPT,
  HOOK_SCRIPT,
  forgetAssistMarkers,
  markAnswerable,
  pruneStale,
  quotedPrompt,
  saidFile,
  seedOwnerWords,
  setupHooks,
  writeAllowFile,
  writeTabHookSettings
} from './hooks'
import {
  formatRemoteKey,
  hostOf,
  isAbsoluteOnHost,
  isRemoteKey,
  parseRemoteKey
} from '@shared/remoteKey'
import {
  defaultControlDir,
  ensureControlDir,
  rsyncPull,
  backgroundOptions,
  runSsh,
  runSshBytes,
  sshOptions
} from './remote/ssh'
import { ENSURE_CODEX_SH, ENSURE_SH, TMUX_CONF, UTIL_SH, remoteShCommand } from './remote/install'
import { codexMachineInstance, ENSURE_CODEX_FILE, replyLanguageFiles } from './remote/codexMachine'
import { machineGhWrapperScript } from './gitCredentialScripts'
import {
  AGENT_PLUGIN_DIR,
  buildMachinePackage,
  POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE,
  SESSION_BIN_DIR,
  tmuxSessionName,
  UTIL_BIN_DIR,
  utilShellLine,
  CLAUDE_AUTH_ENV_VARS,
  type MachinePackage
} from './remote/launch'
import {
  machinePackageBase,
  mirrorAgyGemini,
  mirrorHookDir,
  mirrorProjectsRoot,
  tabPackageDir
} from './remote/paths'
import { RemoteSync } from './remote/sync'
import { OWNER_TYPES_A_SECRET_WITHIN_MS, REMOTE_AGENT_SHIM } from './agentShim'
import { SECRET_VERB, SUDO_SHIM_FILES } from './sudoShim'
import { readLoginShell, sshEnvFromLogin } from './loginShell'
import {
  oncePerName,
  readJsonDrop,
  watchAndSweepJsonDrops,
  watchJsonDrops,
  writeWholeBeforeVisible
} from './jsonDrops'
import {
  AGY_STATUSLINE_JS,
  bundlePath,
  DEFAULT_THEME,
  remoteWrapperScript,
  setupStatusline,
  setupAgyStatusline,
  statusLineSetting
} from './statusline'
import { setupPlaywrightCli } from './playwrightCli'
import { bundledGcm, bundledGhDir, linkOrUnlink, setupBundledGit } from './bundledTools'
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
import {
  AccountPicker,
  PROBE_TIMEOUT_MS,
  codexAllLimitedNotice,
  type PickResponse
} from './accountPicker'
import { flushLayout, loadLayout, saveLayout } from './layout'
import { ensureNotesFile, notesBaseDir } from './notes'
import { WorkspaceManager, type LiveSession } from './workspaces'
import { sanitizeSessionWorkbench } from '@shared/workbenchState'
import {
  dirExistsSync,
  gitProbes,
  worktreeHomeRoot,
  worktreeNameAround,
  type GitOut,
  type ResumeProbes
} from './resumePlan'
import { ClaudeBackend, machineHookSettings, pickMachineAccount } from './backends/claude'
import { codexBackend, trustCodexFolder } from './backends/codex'
import { museBackend } from './backends/muse'
import { codexConfigFile } from './codexTrust'
import {
  HomeAccountPicker,
  codexHomeOf,
  codexHomes,
  limitsFrom,
  prepareCodexHome
} from './codexAccounts'
import { shq } from '@shared/shellQuote'
import { CronRunner, type LaunchRequest, type LeftTab, type RunLeftovers } from './cronRunner'
import { isRunFolderOf, worktreeHomeOf } from '@shared/cronNames'
import { cronFilePath, loadCron, saveCron } from './cronStore'
import { CRON_SAVE_MESSAGES } from '@shared/cronMessages'
import { GitFreshnessEngine } from './gitFreshness'
import { COMMON_GIT_DIR, GitRepoKeys } from './gitRepoKey'
import { SessionSync, type SyncSession } from './sessionSync'
import {
  GithubLookup,
  ghOpenCounts,
  ghRead,
  openCountsArgs,
  parseOpenCounts,
  parseGithubFixture,
  type GithubOptions
} from './github'
import { GithubCountsSweep } from './githubCounts'
import { runGh } from './prChecks'
import { GitAccountService, newGitRequestDir, sweepStaleGitRequestDirs } from './gitAccountService'
import { removeStaleLoginDirs } from './githubLogin'
import { addPrWorktree, commitAll, GIT_REF_RE, pushBranch } from './gitSteps'
import { restoredWindowGeometry, trackWindowState } from './windowState'
import { fullscreenOption, windowMinWidth } from './windowBounds'
import { closeAllFileWatchers, closeAllDirWatchers } from './fileWatch'
import { sanitizeBase } from './gitStatus'
import { Hosts } from './host/hosts'
import { localGitOut, localHost } from './host/localHost'
import { SshHost } from './host/sshHost'
import { projectInfoFor, realpathSafe } from './projectInfo'
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
import { busyInCheckout } from '@shared/freshnessOps'
import {
  canOpenExternally,
  webPageReachesDiscordDesktopApp,
  routeFor,
  schemeOf,
  type RouteDecision,
  type RouteSource
} from '@shared/browserRoute'
import {
  cdpEnvDir,
  relayClientEvicted,
  relayEndpoint,
  relayStripChanged,
  relayTabClosed,
  relayTabRebound,
  sessionDrivingGuest,
  setRelayEnabled,
  startRelay,
  writeRelayEnv,
  relayAttached,
  type RelayDeps
} from './cdpRelay'
import { safeDownloadName, suggestedDownloadName, uniqueDownloadName } from '@shared/downloadName'
import {
  permissionAsk,
  permissionKeysFor,
  permissionQueryAsk,
  type PermissionDetails,
  type PermissionName
} from './browserPermission'
import { sanitizeSettingsPatch } from '@shared/settingsOps'
import { CDP_OP_BUDGET_MS } from '@shared/cdpBudget'
import { pidAlive, scanLeftovers, stopLeftover } from './leftovers'
import { mapAtMost } from './mapAtMost'
import { SessionSearch } from './sessionSearch'
import createTranscriptSearchWorker from './transcriptSearchWorker?nodeWorker'
import { applyWindowCommand, guestShortcut } from '@shared/shortcutDispatch'
import {
  ATTENTION_REASON,
  BROWSER_PARTITION,
  DISCORD_OFF,
  PLACEHOLDER_SESSION_TITLE,
  PLACEHOLDER_TITLES,
  exitedAbnormally,
  GIT_PLATFORMS,
  isHttpUrl,
  keychainNamespace,
  SIGN_IN_FOLDER_KINDS,
  isSignInFolderKind,
  type SignInFolderKind,
  type GitPlatform,
  type GitTokenAdd
} from '@shared/types'
import { ACCOUNT_KINDS_OF, AUTO_PROBE_MS } from '@shared/accountUsage'
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
  QuotaBucket,
  AccountMeta,
  AccountView,
  ArtifactView,
  BackendId,
  CodexLimits,
  CodexResetOutcome,
  SignInResult,
  BrowserAuthChallenge,
  BrowserDialogAnswer,
  BrowserDownload,
  BrowserJsDialog,
  BrowserCdpAttached,
  BrowserCdpOp,
  BrowserCdpOpResult,
  ScreenAnswer,
  ScreenRequest,
  BrowserOpenRequest,
  BrowserOverlayOpen,
  BrowserStripTarget,
  ExtensionPopupAnchor,
  LoginProgress,
  CreateTabOptions,
  CreateTabResult,
  CronSaveInput,
  ConductorOpenResult,
  ConductorSaveInput,
  NewChannelInput,
  ConductorSaveResult,
  ConductorBinding,
  ProbeErrorKind,
  LeftoverProcess,
  ResumePlan,
  ProjectInfo,
  SessionInfo,
  SessionMethods,
  AttentionEvent,
  OsOutletsSeenByTests,
  AttentionSubject,
  SessionResumeRequest,
  SessionRow,
  SearchSnippet,
  SpawnedTab,
  AdoptableTab,
  TabInventoryReply,
  OpenRequest,
  UsageSnapshot,
  WindowCommand,
  SessionWorkbenchState,
  Settings,
  HostId,
  WhatsNew,
  GitStepResult,
  PrChecks,
  PrWorktreeResult,
  WorkspaceAddResult
} from '@shared/types'
import { copyWorktreeIncludes } from './sessionWorktrees'
import { AgentRequests, BUILTIN_VERBS, errorText, refused, type AgentVerb } from './agentRequests'
import {
  conductorFolder,
  Conductors,
  type AssistBackendChoice,
  type AssistTask
} from './discord/conductors'
import { firstLineName } from './sessionTitle'
import { discordApiUrl, DiscordLink } from './discord/link'
import { reloadDiscordPage, saveTokenFromPage, type GuestPage } from './discord/tokenFromPage'
import { DISCORD_SETUP_TASK, DISCORD_SETUP_TASK_NAME, setupStatusText } from './discord/setupTask'
import { releaseLock, takeLock } from './discord/instanceLock'
import { DiscordRelay, type Destination } from './discord/relay'
import { Notices, type NoticeSubject } from './discord/notices'
import { SECRET_ID_PREFIX, SecretAsks } from './discord/secretAsks'
import { secretVerb } from './agentSecret'
import { SessionThreads } from './discord/threads'
import { LiveStatus } from './discord/liveStatus'
import { AskButtons } from './discord/buttons'
import { SlashCommands, type SlashTarget } from './discord/slash'
import { TabLifecycle, subscribeTabSubsystems, type TabExit } from './tabLifecycle'
import { Interactions, SLASH_COMMANDS } from './discord/interactions'
import { bracketedPaste, typedPieces, typeKeys, withoutMouseAndFocusReports } from './typeKeys'
import { MYSELF } from '@shared/slashCommands'
import {
  codexDialog,
  type CodexApproval,
  type CodexQuestion,
  type DialogView
} from './discord/dialog'
import { sleep } from './codexTransport'
import { discordVerb } from './agentDiscord'
import { githubVerb, repoFlagOf } from './agentGithub'
import { claudeShowsAPanel, whenMessagingSocket } from './claudeSessionRegistry'
import {
  asPeerName,
  conductorName,
  GLOBAL_SCOPE,
  inviteLink,
  isAssistScope,
  isDiscordId,
  scopeName
} from '@shared/conductors'
import { cronVerb } from './agentCron'
import { workbenchVerbs } from './agentWorkbench'
import {
  resolveWorkspace,
  sessionChoices,
  sessionVerb,
  targetIn,
  workspaceVerb,
  type ClosableSession,
  type SessionScreen,
  type SessionVerbDeps,
  type Target
} from './agentSessions'
import { crossSessionLine, writeLineInTurn } from './crossSessionMessage'
import { StartedSessions } from './startedSessions'
import { ReaderDocs } from './readerDocs'
import { koloftAssist, type AssistTarget } from './assist'
import { createProject } from './newProject'
import { routeSession } from './sessionRouter'
import {
  closingTree,
  machineUnreachable,
  removeTree,
  tidyTree,
  whatIsLeft,
  type TidyResult
} from './sessionClose'
import { finishAfterKoloftQuits, WorktreeRemovalWatch } from './claudeWorktreeExit'
import { discordTokenRead, discordTokenWrite } from './accounts'
import { agentPluginFiles, writeAgentPlugin } from './agentPlugin'
import { installThen, pathWithDirFirst, pathWithDirLast, pathWithInstallDir } from './toolInstall'

// PLATFORM§4
if (!app.isPackaged) app.setName('koloft-dev')

const BACKGROUND_TEST = process.env.KOLOFT_TEST_BACKGROUND === '1'
const OFF_SCREEN_TEST = BACKGROUND_TEST && process.env.KOLOFT_TEST_REAL_WINDOW !== '1'
// PLATFORM§4
if (OFF_SCREEN_TEST && process.platform === 'darwin') {
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
let museSessions: MuseSessions | null = null
let agySessions: AgySessions | null = null
const startupErrors: Partial<Record<BackendId, string>> = {}

function storedSessions(): SessionsWithStore[] {
  return [codexSessions, museSessions, agySessions].filter(
    (s): s is CodexSessions | MuseSessions | AgySessions => !!s
  )
}
function storedOwnerOf(tabId: string): SessionsWithStore | undefined {
  return storedSessions().find((s) => s.hasTab(tabId))
}
const startedSessions = new StartedSessions(() =>
  path.join(app.getPath('userData'), 'started-sessions.json')
)
const readerDocs = new ReaderDocs({
  file: () => path.join(app.getPath('userData'), 'doc-verdicts.json'),
  assist: (job) => assist(job),
  session: sessionOfTab,
  remoteFileExists: (host, keyed) => hosts.machine(host).fileExists(keyed),
  changed: () => sendToRenderer('sessions:update', onSessionsChanged())
})
const sessionBackends = new SessionBackends({
  turnEnded: (tabId, turn) => {
    void readerDocs.turnEnded(tabId, turn)
    slash.turnEnded(tabId, turn)
    discordRelay?.turnEnded(tabId, turn)
    discordNotices?.turnEnded(tabId, turn.reply)
    sessionCommand.turnEnded(tabId, turn)
  },
  prompted: consumeOutletDedupe,
  bound: (tabId, key) => {
    attention.bound(tabId, key, attentionCtx())
    cronRunner?.onBound(tabId, key)
    conductors?.onBound(tabId, key)
    discordThreads?.bound(tabId, key)
    startedSessions.bound(tabId, key)
    slash.bound(tabId, key)
    ptyMgr.wakeReady(tabId)
  },
  exited: (tabId, subject) => attention.onExited(tabId, attentionCtx(), subject),
  asked: (tabId, ask) => discordRelay?.onAsk(tabId, ask),
  clearAttention: (tabId) => attention.clear(tabId),
  open: (tabId, target) => {
    if (path.isAbsolute(target) && !fs.existsSync(target)) return
    openInWorkbench(tabId, routeFor(target, 'agent'), 'agent', target)
  }
})
sessionBackends.conductorOf = (id) => conductors?.conductorOf(id)
sessionBackends.conductorWorkspaceOf = (tabId) => conductors?.workspaceOfTab(tabId)
sessionBackends.assistTaskOf = (tabId) => conductors?.taskNameOf(tabId)
sessionBackends.turnOver = (tabId) => tracker.turnOver(tabId)
sessionBackends.docVerdictsOf = (sessionId) => readerDocs.of(sessionId)
function allSessions(): SessionInfo[] {
  return sessionBackends.list()
}

// CC§14
function asksTheOwner(tabId: string): boolean {
  return tracker.statusOf(tabId) === 'approval' || !!discordRelay?.dialogOpen(tabId)
}

const panelOpenOn: Record<
  BackendId,
  (tabId: string, sessionId: string, screen?: string[]) => Promise<boolean | undefined>
> = {
  claude: async (_tabId, sessionId) => (sessionId ? claudeShowsAPanel(sessionId) : undefined),
  codex: async () => undefined,
  muse: async (tabId, _sessionId, screen) => {
    const lines = screen ?? (await screenLines(tabId))
    return lines && !museShowsItsInputBox(lines)
  },
  agy: async () => undefined
}

const slash = new SlashCommands({
  backendOf: (tabId) => backendIdOf(ptyMgr.get(tabId)?.kind),
  keyOf: (tabId) => sessionOfTab(tabId)?.sessionId || undefined,
  turnOver: (tabId) => tracker.turnOver(tabId),
  asking: asksTheOwner,
  takesTyping: (tabId) => !!discordRelay?.takesCommand(tabId),
  panelOpen: async (tabId, screen) => {
    const s = sessionOfTab(tabId)
    if (!s || capabilitiesFor(s.backendId, s.host).panelSeen !== true) return undefined
    return panelOpenOn[s.backendId](tabId, s.sessionId, screen)
  },
  screen: screenLines,
  nextMirrorPull: (tabId) => {
    const host = remoteHostOfTab(tabId)
    return host ? remoteSync?.nextPullDone(host) : undefined
  },
  ready: (tabId, ready, ms) => ptyMgr.whenReady(tabId, ready, ms),
  exclusive: (tabId, typing) => ptyMgr.exclusive(tabId, typing),
  typeNow: (tabId, keys) => typeKeys((data) => ptyMgr.write(tabId, data), keys),
  // AGY§23
  outputOnlyOnScreen: (tabId) =>
    backendIdOf(ptyMgr.get(tabId)?.kind) === 'agy'
      ? screenOf(tabId).then((s) => ('lines' in s ? s.lines.join('\n').trim() : '') || undefined)
      : undefined,
  post: (channelId, text) => discordRelay?.say(channelId, text),
  card: (channelId, card) => discordRelay?.card(channelId, card)
})
tracker.on('turn-ended', ({ tabId, turn }: { tabId: string; turn: Turn }) =>
  sessionBackends.observe(tabId, { type: 'turn-ended', turn })
)
tracker.pidOf = (tabId) => ptyMgr.pidOf(tabId)
const dirtyTabIds = new Set<string>()
tracker.activeTabId = () => uiActiveTabId
tracker.heldTabs = () => {
  const held = new Set(dirtyTabIds)
  for (const h of ptyMgr.list()) if (h.util && h.alive && h.ownerTabId) held.add(h.ownerTabId)
  for (const s of allSessions())
    if (conductors?.heldResident(s.tabId) || workspaceMgr?.isResident(s.sessionId))
      held.add(s.tabId)
  return held
}
tracker.needsUser = (id) => attention.list().some((e) => e.tabId === id)
let leftovers: Record<string, LeftoverProcess[]> = {}
tracker.leftBehind = (sessionId) => !!leftovers[sessionId]?.length
const LEFTOVER_SCAN_MS = 30_000
async function refreshLeftovers(): Promise<void> {
  const next = await scanLeftovers(await sharedProcessTable.eachRound(LEFTOVER_SCAN_MS))
  const changed = JSON.stringify(next) !== JSON.stringify(leftovers)
  leftovers = next
  if (changed) sendToRenderer('sessions:leftovers', next)
}
if (process.platform !== 'win32') {
  setInterval(() => void refreshLeftovers(), LEFTOVER_SCAN_MS).unref()
  void refreshLeftovers()
}
let quitCommitted = false

interface ClaudeTabExit {
  watch: WorktreeRemovalWatch
  leaving?: { sessionId?: string; claudePid?: number; treeRoot?: string }
}
const claudeTabExits = new Map<string, ClaudeTabExit>()
const sessionsLeavingTheirWorktree = new Set<string>()
const closedTabs = new Map<string, LeftTab | null>()

function watchForWorktreeRemoval(tabId: string, data: string): void {
  let exit = claudeTabExits.get(tabId)
  if (!exit) {
    const backend = backendIdOf(ptyMgr.get(tabId)?.kind)
    if (!backend || capabilitiesFor(backend, hostOfTab(tabId)).worktreeRemovalFollowed !== true)
      return
    claudeTabExits.set(tabId, (exit = { watch: new WorktreeRemovalWatch() }))
  }
  if (!exit.watch.started(data)) return
  const session = tracker.infoOf(tabId)
  exit.leaving = {
    sessionId: session?.sessionId,
    claudePid: ptyMgr.pidOf(tabId),
    treeRoot: session?.treeRoot
  }
  if (session?.sessionId) sessionsLeavingTheirWorktree.add(session.sessionId)
  sendToRenderer('tab:killedByMain', tabId)
  workspaceMgr?.refresh()
}

const attention = new AttentionTracker((pending, event) => {
  if (!quitCommitted) saveAttention(pending)
  updateDockBadge(pending)
  sendToRenderer('attention:changed', pending)
  retractStaleOsNotifications(pending)
  if (event && !event.resurrected) routeAttentionEvent(event)
}, loadLastRunAttention())
let uiActiveTabId: string | null = null
let activeTabBeforeReload: string | null = null
function sessionOfTab(tabId: string): SessionInfo | undefined {
  return allSessions().find((s) => s.tabId === tabId)
}
function sidebarTitle(s: SessionInfo): string | undefined {
  const placeholder = Object.values(PLACEHOLDER_TITLES).includes(s.title)
  return s.title && !placeholder ? s.title : undefined
}

const tabLifecycle = new TabLifecycle()
const sleepers = new Map<string, OpenTab>()
const typedWhileAsleep = new Map<string, string>()
const wokenAs = new Map<string, string>()
let sleeperSeq = 0
let openTabsRestoreStarted = false
let openTabsFile: OpenTabsFile | undefined
let sessionAccounts: SessionAccounts | undefined
let savedOpenTabs: OpenTabs = { tabs: [] }
let openTabsRestored = false
const RESUMED_TAB_READY_MS = 30_000

function openTabOf(s: SessionInfo): OpenTab {
  return {
    sessionId: s.sessionId,
    kind: s.backendId,
    title: sidebarTitle(s) ?? s.title,
    cwd: s.remote ? formatRemoteKey(s.remote.host, s.cwd) : s.cwd
  }
}

function rememberOpenTabs(all = allSessions()): void {
  if (!openTabsFile || !openTabsRestored || quitCommitted) return
  const live = all.filter((s) => s.alive && s.sessionId).map(openTabOf)
  for (const h of ptyMgr.list()) {
    const kind = backendIdOf(h.kind)
    if (!h.alive || !h.resumeSessionId || !kind) continue
    live.push({
      sessionId: h.resumeSessionId,
      kind,
      title: '',
      cwd: h.remoteHost ? formatRemoteKey(h.remoteHost, h.cwd) : h.cwd
    })
  }
  const activeTab = uiActiveTabId ?? activeTabBeforeReload
  const active = activeTab
    ? all.find((s) => s.tabId === activeTab)?.sessionId ||
      ptyMgr.get(activeTab)?.resumeSessionId ||
      sleepers.get(activeTab)?.sessionId
    : undefined
  openTabsFile.write(openTabsNow(live, [...sleepers.values()], active))
}

function onSessionsChanged(): SessionInfo[] {
  const all = allSessions()
  settleWokenSleepers(all)
  rememberOpenTabs(all)
  sessionAccounts?.note(all)
  syncRelayBindings(all)
  void sessionSync.observe(syncSessionsOf(all))
  return all
}

function syncRelayBindings(all: SessionInfo[]): void {
  const seen = new Set<string>()
  for (const s of all) {
    seen.add(s.tabId)
    const before = boundSessions.get(s.tabId)
    if (before === s.sessionId) continue
    boundSessions.set(s.tabId, s.sessionId)
    // CODEX§26
    if (before && s.backendId === 'codex')
      relayClientEvicted(s.tabId, 'a new session took over this tab')
    relayTabRebound(s.tabId, s.sessionId || null)
  }
  for (const tabId of [...boundSessions.keys()]) {
    if (seen.has(tabId)) continue
    boundSessions.delete(tabId)
    relayTabRebound(tabId, null)
  }
}

function addSleeper(tabId: string, t: OpenTab): void {
  sleepers.set(tabId, t)
  typedWhileAsleep.set(tabId, '')
}

function sleepTab(tabId: string): void {
  const s = sessionOfTab(tabId)
  if (!s?.sessionId) return killTabFromMain(tabId)
  addSleeper(tabId, openTabOf(s))
  sendToRenderer('tab:slept', tabId)
  void stopTabProcess(tabId)
  tabLifecycle.emit('slept')
  rememberOpenTabs()
}

function sleepingTabOf(sessionId: string): string | undefined {
  for (const [tabId, t] of sleepers) if (t.sessionId === sessionId) return tabId
  return undefined
}

function forgetSleeper(tabId: string): void {
  sleepers.delete(tabId)
  typedWhileAsleep.delete(tabId)
  sendToRenderer('tab:killedByMain', tabId)
  tabLifecycle.emit('forgotten', tabId)
  rememberOpenTabs()
}

function settleWokenSleepers(all: SessionInfo[]): void {
  if (!sleepers.size) return
  const tabOfSession = new Map<string, string>()
  for (const s of all) if (s.alive && s.sessionId) tabOfSession.set(s.sessionId, s.tabId)
  let woke = false
  for (const [oldId, t] of sleepers) {
    const newId = tabOfSession.get(t.sessionId)
    if (!newId || newId === oldId) continue
    sleepers.delete(oldId)
    wokenAs.set(oldId, newId)
    woke = true
    void handOverTyping(oldId, newId)
  }
  if (woke) tabLifecycle.emit('woken')
}

const PASTE_OR_ENTER = /(\x1b\[200~[\s\S]*?\x1b\[201~|\r)/

// CC§12 CC§18
async function handOverTyping(oldId: string, newId: string): Promise<void> {
  const ready = await tabReady(newId, RESUMED_TAB_READY_MS, false)
  const typed = typedWhileAsleep.get(oldId) ?? ''
  typedWhileAsleep.delete(oldId)
  if (!ready || !typed) return
  const keys = typed
    .split(PASTE_OR_ENTER)
    .flatMap((part) => (PASTE_OR_ENTER.test(part) ? [part] : typedPieces(part)))
  void ptyMgr.type(newId, keys)
}

function writeToTab(id: string, data: string): void {
  const typed = typedWhileAsleep.get(id)
  if (typed !== undefined) typedWhileAsleep.set(id, typed + withoutMouseAndFocusReports(data))
  else ptyMgr.write(wokenAs.get(id) ?? id, data)
}
async function discordShownName(s: SessionInfo | undefined): Promise<string | null> {
  const title = s && sidebarTitle(s)
  if (title) return title
  return s?.sessionId ? sessionBackends.peerNames()(s) : null
}
function retitleDiscordThreads(sessions: SessionInfo[]): void {
  if (!discordThreads) return
  for (const s of sessions) {
    const title = sidebarTitle(s)
    if (title) discordThreads.retitle(s.tabId, title, sessionBackends.workspaceOfTab(s.tabId))
    discordLive?.sessionChanged(s.tabId, title, statusUnavailable(s))
  }
}
function markedSessionsOf(wsPath: string): string[] {
  return attention
    .list()
    .flatMap((e) =>
      e.sessionId && workspaceMgr?.workspaceOf(e.sessionId) === wsPath ? [e.sessionId] : []
    )
}
function attentionSubjectOf(tabId: string): AttentionSubject {
  const s = sessionOfTab(tabId)
  return { title: s?.title, sessionId: s?.sessionId }
}
function attentionCtx(): AttentionContext {
  let focused = false
  try {
    focused = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()
  } catch {}
  return { windowFocused: focused, activeTabId: uiActiveTabId }
}

function projectFolderName(event: AttentionEvent): string | undefined {
  const root =
    sessionOfTab(event.tabId)?.treeRoot ??
    (event.sessionId ? workspaceMgr?.workspaceOf(event.sessionId) : undefined)
  return root ? path.basename(root) : undefined
}

const osOutletsSeenByTests: OsOutletsSeenByTests = { notifications: [], dockBadge: '' }
;(globalThis as { __koloftOsOutlets?: OsOutletsSeenByTests }).__koloftOsOutlets =
  osOutletsSeenByTests

function updateDockBadge(pending: AttentionEvent[]): void {
  if (process.platform !== 'darwin') return
  const text = dockBadgeText(pending.length, loadSettings().dockBadge)
  if (OFF_SCREEN_TEST) osOutletsSeenByTests.dockBadge = text
  else app.dock?.setBadge(text)
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

function osNotificationText(event: AttentionEvent): { title: string; body: string } {
  const reason = ATTENTION_REASON[event.kind]
  const folder = projectFolderName(event)
  return {
    title: event.title || PLACEHOLDER_SESSION_TITLE,
    body: folder ? `${reason} · ${folder}` : reason
  }
}

function osNotification(text: { title: string; body: string }): Notification | null {
  if (OFF_SCREEN_TEST) {
    osOutletsSeenByTests.notifications.push(text)
    return null
  }
  return Notification.isSupported() ? new Notification(text) : null
}

function showOsNotification(event: AttentionEvent): void {
  const n = osNotification(osNotificationText(event))
  if (!n) return
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
  osNotification({ title, body })?.show()
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
  const decision = route(event, attentionCtx().windowFocused, loadSettings())
  if (decision.os) showOsNotification(event)
  if (decision.sound && !BACKGROUND_TEST) shell.beep()
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
let githubCounts: GithubCountsSweep | null = null
let gitAccounts: GitAccountService | null = null
let remoteSync: RemoteSync | null = null
tracker.machineTmp = (host) => remoteSync?.machineTmp(host)
let machinePkg: MachinePackage | null = null
const remoteControlDir = defaultControlDir()
let loginEnv: Promise<void> | null = null
process.env.PATH = pathWithInstallDir(process.env.PATH, os.homedir())

// PLATFORM§1
function loginEnvReady(): Promise<void> {
  return (loginEnv ??= readLoginShell({ env: process.env })
    .then(({ env }) => {
      Object.assign(process.env, sshEnvFromLogin(process.env, env))
      if (fallbackBin) process.env.PATH = pathWithDirLast(process.env.PATH, fallbackBin)
    })
    .catch(() => undefined))
}

function machinePackage(): MachinePackage {
  if (machinePkg) return machinePkg
  const pkgFiles: Record<string, string | Buffer> = {
    'ensure.sh': ENSURE_SH,
    [ENSURE_CODEX_FILE]: ENSURE_CODEX_SH,
    ...replyLanguageFiles(CODEX_REPLY_LANGUAGE_SCRIPT),
    'hook.sh': HOOK_SCRIPT,
    'tmux.conf': TMUX_CONF,
    'util.sh': UTIL_SH,
    [`${UTIL_BIN_DIR}claude`]: utilTerminalGuard('claude'),
    [`${UTIL_BIN_DIR}codex`]: utilTerminalGuard('codex'),
    [`${UTIL_BIN_DIR}muse`]: utilTerminalGuard('muse'),
    [`${UTIL_BIN_DIR}agy`]: utilTerminalGuard('agy'),
    [`${SESSION_BIN_DIR}koloft`]: REMOTE_AGENT_SHIM,
    [`${SESSION_BIN_DIR}gh`]: machineGhWrapperScript(),
    [`${UTIL_BIN_DIR}gh`]: machineGhWrapperScript(),
    [MUSE_WRAP_FILE]: MUSE_WRAP_PY,
    [MUSE_HOOK_FILE]: REMOTE_MUSE_HOOK_SH,
    [AGY_HOOK_FILE]: AGY_HOOK_SCRIPT,
    [AGY_TITLE_FILE]: AGY_TITLE_SCRIPT,
    [AGY_LIST_FILE]: AGY_LIST_JS
  }
  for (const [name, text] of Object.entries(SUDO_SHIM_FILES))
    pkgFiles[`${SESSION_BIN_DIR}${name}`] = text
  for (const [rel, text] of Object.entries(agentPluginFiles()))
    pkgFiles[`${AGENT_PLUGIN_DIR}${rel}`] = text
  try {
    pkgFiles['statusline/ccstatusline.js'] = fs.readFileSync(bundlePath())
    pkgFiles['statusline/package.json'] = '{"type":"module"}\n'
    pkgFiles['statusline/theme.json'] = JSON.stringify(DEFAULT_THEME, null, 2)
    pkgFiles['statusline/run.sh'] = remoteWrapperScript()
    pkgFiles['statusline/agy.cjs'] = AGY_STATUSLINE_JS
    pkgFiles[AGY_STATUSLINE_FILE] = agyStatuslineScript()
  } catch (err) {
    console.error('[koloft] remote statusline bundle unreadable:', err)
  }
  return (machinePkg = buildMachinePackage(machinePackageBase(app.getPath('userData')), pkgFiles))
}

let playwrightCliBin: string | undefined
let fallbackBin: string | undefined
let gitFirstBin: string | undefined
let cronRunner: CronRunner | null = null
let conductors: Conductors | null = null
let discordLink: DiscordLink | null = null
let discordRelay: DiscordRelay | null = null
let discordNotices: Notices | null = null
let discordThreads: SessionThreads | null = null
let discordLive: LiveStatus | null = null
let askButtons: AskButtons | null = null
let secretAsks: SecretAsks | null = null
const answerable = new Set<string>()
let hookRegDir: string | undefined
let writeHookSettings:
  ((tabId: string, allowKoloft: boolean, conductor: boolean) => string) | undefined
const PLAIN_KOLOFT_SHIM = {
  hookSettings: (tabId: string): string | undefined => writeHookSettings?.(tabId, false, false)
}
let claudeAgentPlugin: string | undefined
let discordConnected = false

const CODEX_REQUEST_TRAILS_ITS_STATUS_POLLS = 8
const CODEX_REQUEST_POLL_MS = 250
const ATTACHMENTS_KEPT_MS = 7 * 24 * 60 * 60 * 1000
const ATTACHMENTS_PRUNED_EVERY_MS = 24 * 60 * 60 * 1000

// CODEX§3 CODEX§20 MUSE§5
async function pendingAskOf(tabId: string): Promise<CodexApproval | CodexQuestion | undefined> {
  for (let polls = CODEX_REQUEST_TRAILS_ITS_STATUS_POLLS; ; polls--) {
    const owner = storedOwnerOf(tabId)
    const ask = owner?.openApproval(tabId) ?? owner?.openQuestion(tabId)
    if (ask || !polls || !owner) return ask
    if (tracker.statusOf(tabId) !== 'approval' && !tracker.awaitsInput(tabId)) return undefined
    await sleep(CODEX_REQUEST_POLL_MS)
  }
}

function watchedByDiscord(all: Conductors, s: { tabId: string; conductor?: string }): boolean {
  if (s.conductor) return all.heldResident(s.tabId)
  return all.covers(sessionBackends.workspaceOfTab(s.tabId))
}

function syncAnswerable(): void {
  if (!hookRegDir || !conductors) return
  for (const s of allSessions()) {
    if (!s.alive || capabilitiesFor(s.backendId, s.host).askHookWaitsForDiscord !== true) continue
    const on = discordConnected && watchedByDiscord(conductors, s)
    if (on === answerable.has(s.tabId)) continue
    if (on) answerable.add(s.tabId)
    else answerable.delete(s.tabId)
    markAnswerable(hookRegDir, s.tabId, on)
  }
}

const BOOT_TIME = Date.now()

let rendererReady = false

// CC§7
const usageViews = new Map<
  string,
  {
    usage?: UsageSnapshot
    limits?: CodexLimits
    quota?: QuotaBucket[]
    probeError?: ProbeErrorKind
  }
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

function notifyExpired(name: string, label = 'Claude'): void {
  notifyPlain(
    `${label} account expired`,
    `Account ${name} expired and left the pool — sign in again from Settings to restore it`
  )
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
  fablePriority: () => loadSettings().fablePriority,
  readSecret: (kind, name) => keychainRead(kind, name),
  probe: (a, secret) =>
    probeAccount(a.kind, secret, {
      timeoutMs: PROBE_TIMEOUT_MS,
      skipFable: shouldSkipFable(a, Date.now())
    }),
  onProbeOutcome: foldProbeResult,
  launchedSessions: () => tracker.launchedSessions(),
  recordPick: (tabId, account) => tracker.setPickedAccount(tabId, account),
  now: () => Date.now()
})

function watchPickRequests(pickDir: string): fs.FSWatcher | null {
  return watchAndSweepJsonDrops(
    pickDir,
    oncePerName((name) =>
      name.startsWith('req-') ? (obj): void => void handlePickRequest(pickDir, name, obj) : null
    )
  )
}

function machineOfTab(tabId: string): string | undefined {
  return remoteHostOfTab(tabId) ?? codexSessions?.machineOfTab(tabId)
}

function hostOfTab(tabId: string): HostId {
  return machineOfTab(tabId) ? 'ssh' : 'local'
}

function agentToolsFor(backend: BackendId, host: HostId): boolean {
  return loadSettings().agentTools && capabilitiesFor(backend, host).agentTools === true
}

// CC§2
function pinnedKeyOn(host: string, onMachine: string): string {
  for (const pinned of workspaceMgr?.remoteTargets().find((t) => t.host === host)?.paths ?? []) {
    const real = workspaceMgr?.realRemotePath({ host, path: pinned }) ?? pinned
    if (onMachine === real || onMachine.startsWith(real + '/'))
      return formatRemoteKey(host, pinned + onMachine.slice(real.length))
  }
  return formatRemoteKey(host, onMachine)
}

// ADR-0025 CC§3
function projectInfoOnHost(cwd: string): ProjectInfo {
  const key = parseRemoteKey(cwd)
  if (!key) return projectInfoFor(cwd)
  const worktreeName = worktreeNameAround(key.path)
  let tree = key.path
  while (worktreeName && !worktreeHomeRoot(tree)) tree = path.posix.dirname(tree)
  const top = (worktreeName && worktreeHomeRoot(tree)) || key.path
  const pinned = (workspaceMgr?.remoteTargets().find((t) => t.host === key.host)?.paths ?? [])
    .filter((p) => top === p || top.startsWith(p + '/'))
    .sort((a, b) => b.length - a.length)[0]
  return {
    root: formatRemoteKey(key.host, pinned ?? top),
    treeRoot: formatRemoteKey(key.host, tree),
    ...(worktreeName && { worktreeName })
  }
}

function machineTreeIo(cwd: string): TreeIo {
  const host = parseRemoteKey(cwd)!.host
  const machine = hosts.machine(host)
  return {
    git: async (dir, args) => {
      const r = await machine.gitRun(dir, args)
      if (r.code === 0) return r.stdout.trimEnd()
      throw Object.assign(new Error(r.stderr || 'git failed'), { code: r.code ?? undefined })
    },
    exists: (p) => machine.dirExists(p),
    real: (p) => p,
    keyed: (listed) => pinnedKeyOn(host, listed),
    onThisMac: false
  }
}

const museOnMachines: MuseRemoteDeps = {
  machine: (host) => hosts.machine(host),
  hosts: () => workspaceMgr?.remoteTargets().map((t) => t.host) ?? [],
  keyed: pinnedKeyOn,
  mirrorDir: (host) => mirrorHookDir(app.getPath('userData'), host),
  gone: (host, sessionId) =>
    !!remoteSync?.connected(host) && !remoteSync.alive(host).has(sessionId),
  connected: (host) => !!remoteSync?.connected(host),
  poke: (host) => remoteSync?.pokeNow(host),
  setupLine: () => setupLine(playwrightCliBin),
  hookSettings: PLAIN_KOLOFT_SHIM.hookSettings
}

function machineProbes(cwd: string): ResumeProbes {
  const host = hosts.of(cwd)
  return {
    dirExists: (p) => host.dirExists(host.keyed(p)),
    occupantOf: (dir) => sessionBackends.occupantOf(dir),
    ...gitProbes(hostGitOut)
  }
}

function remoteHostOfTab(tabId: string): string | undefined {
  return ptyMgr.get(tabId)?.remoteHost
}

function pinnedWorkspaceOfTab(tabId: string): string | undefined {
  const workspace = sessionBackends.workspaceOfTab(tabId)
  return workspace && workspaceMgr?.isPinned(workspace) ? workspace : undefined
}

function notesFileOfScope(scope: string): string | undefined {
  return isAssistScope(scope, (s) => !!workspaceMgr?.isPinned(s))
    ? ensureNotesFile(notesBaseDir(), scope)
    : undefined
}

function unlessWorkspacelessConductor(verb: AgentVerb): AgentVerb {
  return (args, caller) => {
    const reason = conductors?.noWorkspaceReason(caller.tabId)
    return reason ? refused(`koloft: ${reason}`) : verb(args, caller)
  }
}

const notesAndWorkbenchVerbs = workbenchVerbs({
  open: (tabId, target, view) => {
    const machine = machineOfTab(tabId)
    return machine && !schemeOf(target)
      ? openOnMachine(tabId, machine, target, view)
      : openInWorkbench(tabId, routeFor(target, 'agent'), 'agent', target, view)
  },
  notesFileOf: (tabId) => {
    const scope = conductors?.scopeOfTab(tabId) ?? sessionBackends.workspaceOfTab(tabId)
    return scope ? notesFileOfScope(scope) : undefined
  }
})

const assistTargets: Record<BackendId, () => Promise<AssistTarget | null>> = {
  claude: async () => {
    const env = await pickedAccountEnv()
    if (!env) return null
    return { binary: ptyMgr.shimDir ? path.join(ptyMgr.shimDir, 'claude') : 'claude', env }
  },
  codex: async () => {
    const picked = pickCodexHome()
    if (!picked || !codexSessions || !(await codexSessions.availability()).available) return null
    const binary = codexSessions.cliBinary
    if (!binary) return null
    return { binary, env: { ...codexSessions.defaultEnv, CODEX_HOME: picked.home } }
  },
  muse: async () => {
    const picked = musePicker.pick(accountViews())
    return picked ? ((await museServeFor(picked.name)) ?? null) : null
  },
  agy: () => agyOneShotTarget()
}
const assist = koloftAssist({
  setting: () => loadSettings().assist,
  enabled: (backend) => loadSettings().sessionMethods.enabled[backend],
  target: (backend) => assistTargets[backend]()
})
const assistRuns = new Map<number, AbortController>()

async function whyAssistCannotRunOn(
  backend: BackendId,
  enabled: SessionMethods['enabled']
): Promise<string | undefined> {
  if (!enabled[backend]) return `${BACKEND_LABEL[backend]} is turned off in Settings ▸ Sessions`
  return whyAssistCannotRun[backend]()
}

const whyAssistCannotRun: Record<BackendId, () => Promise<string | undefined>> = {
  claude: async () => {
    const { res } = await pickForLaunch()
    if (res.account !== null) return undefined
    return res.reason === 'no-accounts'
      ? 'there is no Claude account'
      : 'every Claude account is at its limit'
  },
  codex: async () => {
    if (!codexSessions || !(await codexSessions.availability()).available)
      return 'Codex is not available on this Mac'
    return codexPicker.pick(accountViews()) ? undefined : 'every Codex account is at its limit'
  },
  muse: async () => {
    if (!museSessions || !(await museSessions.availability()).available)
      return 'Muse is not available on this Mac'
    return musePicker.pick(accountViews()) ? undefined : 'there is no usable Muse account'
  },
  agy: async () => {
    if (!agySessions || !(await agySessions.availability()).available)
      return 'Antigravity is not available on this Mac'
    return agyPicker.pick(accountViews()) ? undefined : 'there is no usable Antigravity account'
  }
}

async function assistBackendChoice(avoid?: BackendId): Promise<AssistBackendChoice> {
  const settings = loadSettings()
  const [preferred, ...others] = backendsFrom(preferredAssistBackend(settings))
  const { enabled } = settings.sessionMethods
  const whyNot = (backend: BackendId): Promise<string | undefined> =>
    avoid === backend
      ? Promise.resolve(`${BACKEND_LABEL[backend]} could not start`)
      : whyAssistCannotRunOn(backend, enabled)
  const why = await whyNot(preferred)
  if (!why) return { backend: preferred }
  const whys = [why]
  for (const other of others) {
    const otherWhy = await whyNot(other)
    if (!otherWhy)
      return {
        backend: other,
        because: `Assist runs on ${BACKEND_LABEL[other]} this time: ${why}.`
      }
    whys.push(otherWhy)
  }
  return {
    error: `Assist cannot start: ${whys.join(', and ')}. Check Settings ▸ Accounts.`
  }
}
const COMMAND_NEEDS_DISCORD =
  'koloft session command posts what the command printed in Discord, so it needs an Assist bound to a Discord channel.'

// CC§13
async function sendPeerLine(tabId: string, line: string, ms: number): Promise<void> {
  const sessionId = sessionOfTab(tabId)?.sessionId
  const socket = sessionId ? await whenMessagingSocket(sessionId, ms) : null
  if (!socket) throw new Error('Koloft could not find where that session takes messages.')
  await writeLineInTurn(socket, line)
}

async function queueCodexMessage(tabId: string, text: string, clientId: string): Promise<void> {
  if (!codexSessions) throw new Error(startupErrors.codex ?? 'Codex is not available.')
  await codexSessions.queueMessage(tabId, text, clientId)
}

const syncRepoKeys = new GitRepoKeys(undefined, (machine, paths) =>
  Promise.all(
    paths.map(async (onMachine) => {
      const dir = formatRemoteKey(machine, onMachine)
      const common = (await hosts.of(dir).gitOut(dir, COMMON_GIT_DIR))?.trim()
      return common ? formatRemoteKey(machine, common) : null
    })
  )
)

function syncSessionsOf(all: SessionInfo[]): SyncSession[] {
  return all.flatMap((s) =>
    s.alive && !s.conductor && s.sessionId && (s.backendId === 'claude' || s.backendId === 'codex')
      ? [
          {
            tabId: s.tabId,
            sessionId: s.sessionId,
            backendId: s.backendId,
            title: s.title,
            treeRoot: s.treeRoot,
            files: s.files,
            liveWrites: s.liveWrites
          }
        ]
      : []
  )
}

const sessionSync = new SessionSync({
  idle: (tabId) =>
    tracker.turnOver(tabId) && !asksTheOwner(tabId) && (codexSessions?.queueDrained(tabId) ?? true),
  modeOf: (tabId) => sessionBackends.permissionClass(tabId),
  repoOf: (dir) => syncRepoKeys.resolve(dir),
  gitOut: (dir, args) => hosts.of(dir).gitOut(dir, args),
  queue: queueCodexMessage,
  sendLine: sendPeerLine,
  type: (tabId, keys) => ptyMgr.type(tabId, keys)
})

const sessionDeps: SessionVerbDeps = {
  workspaceOf: (tabId) => sessionBackends.workspaceOfTab(tabId),
  allSessions: () => allSessions().filter((s) => !s.conductor),
  pinnedWorkspaces: () => workspaceMgr?.pinnedPaths() ?? [],
  peerNames: () => sessionBackends.peerNames(),
  launch: (options) => launchQuietTab(options, options.name ?? BACKEND_LABEL[options.kind]),
  assist,
  queue: async (tabId, text, clientId) => codexSessions?.queueMessage(tabId, text, clientId),
  startedSessions,
  closable: closableSessions,
  whatIsLeft: whatClosingWouldLose,
  closeSoon: (target) =>
    setTimeout(() => void closeSessionFully(target), CLOSE_AFTER_THE_CALLER_READS_ITS_REPLY_MS),
  conductorScope: (tabId) => conductors?.scopeOfTab(tabId),
  sidebar: () => workspaceMgr?.rows() ?? [],
  worktrees: async (wsPath) => (await workspaceMgr?.worktrees(wsPath).catch(() => [])) ?? [],
  readTurns: (key, n) => sessionBackends.turns(key, n),
  quotedPrompt: (tabId) => {
    const host = tracker.remoteOf(tabId)?.host
    const dir = host ? mirrorHookDir(app.getPath('userData'), host) : hookRegDir
    return dir ? quotedPrompt(dir, tabId) : undefined
  },
  touch: (tabId, key) => conductors?.touch(tabId, key),
  conductorOf: conductorTarget,
  resume: async (row) => {
    const resumed = await resumeRow(row, { rebuildGoneWorktree: true })
    if (!resumed.ok) throw new Error(resumed.error)
    return resumed.tabId
  },
  ready: tabReady,
  asking: asksTheOwner,
  sendLine: sendPeerLine,
  press: (tabId, keys) => ptyMgr.type(tabId, keys),
  deliver: async (tabId, text) => {
    return storedOwnerOf(tabId)?.deliver?.(tabId, text) ?? false
  },
  modeOf: (tabId) => sessionBackends.permissionClass(tabId),
  stop: killTabFromMain,
  answer: async (tabId, reply) => {
    if (!discordRelay) return STILL_STARTING
    return discordRelay.answerSession(tabId, reply)
  },
  undelivered: (callerTab, target, why) => {
    const caller = conductors?.bindingOfTab(callerTab)
    const b =
      caller ?? (target.assistScope ? conductors?.bindingOfScope(target.assistScope) : undefined)
    const text = `Could not deliver to ${target.name}: ${why}`
    if (!b) return void sendToRenderer('cron:toast', text)
    discordRelay?.say(b.channel.channelId, `⚠ ${text}`)
    if (caller) discordRelay?.tell(conductorDestination(caller), `[Koloft] ${text}`)
  },
  started: (conductorTab, tabId, name, workspace, backend) => {
    const b = conductors?.bindingOfTab(conductorTab)
    if (!b) return
    conductors?.touchWhenBound(conductorTab, tabId)
    void discordThreads?.place(b, { tabId, name, workspace, backend }, true)
  },
  command: async (callerTab, target, text) => {
    if (!conductors) throw new Error(STILL_STARTING)
    const b = conductors.bindingOfTab(callerTab)
    if (!b) throw new Error(COMMAND_NEEDS_DISCORD)
    return target.assistScope === b.scope
      ? commandIntoConductor(b, text)
      : commandInto(b, target, text)
  },
  screen: screenOf
}
const sessionCommand = sessionVerb(sessionDeps)

const agentRequests = new AgentRequests({
  verbs: {
    ...BUILTIN_VERBS,
    cron: unlessWorkspacelessConductor(
      cronVerb({
        runner: () => cronRunner,
        pinnedWorkspaceOf: pinnedWorkspaceOfTab,
        toast: (text) => sendToRenderer('cron:toast', text),
        now: () => new Date()
      })
    ),
    ...notesAndWorkbenchVerbs,
    session: sessionCommand.verb,
    workspace: workspaceVerb({
      conductorScope: (tabId) => conductors?.scopeOfTab(tabId),
      sidebar: () => workspaceMgr?.rows() ?? []
    }),
    discord: discordVerb({
      channelOf: (tabId) => conductors?.bindingOfTab(tabId)?.channel.channelId,
      send: async (channelId, files, text) => {
        if (!discordRelay) throw new Error(STILL_STARTING)
        await discordRelay.send(channelId, files, text)
      },
      isSetupTask: (tabId) => conductors?.taskNameOf(tabId) === DISCORD_SETUP_TASK_NAME,
      status: () =>
        setupStatusText(
          discordLink?.status() ?? DISCORD_OFF,
          conductors?.discordSettings() ?? { bindings: [] }
        ),
      tokenFromPage: (tabId) =>
        saveTokenFromPage(guestPagesOf(tabId), relayAttached(tabId), saveDiscordToken),
      reload: (tabId) => reloadDiscordPage(guestPagesOf(tabId), relayAttached(tabId)),
      invite: () => {
        const appId = discordLink?.status().applicationId
        return appId ? inviteLink(appId) : null
      },
      bindNewChannel: async (ref) => {
        if (ref === GLOBAL_SCOPE) return bindWithNewChannel({ scope: ref })
        const found = resolveWorkspace(ref, workspaceMgr?.pinnedPaths() ?? [])
        return found.ok
          ? bindWithNewChannel({ scope: found.value.path })
          : { ok: false, error: found.error }
      }
    }),
    [SECRET_VERB]: secretVerb({
      ask: (a) =>
        secretAsks ? secretAsks.ask(a, OWNER_TYPES_A_SECRET_WITHIN_MS) : Promise.resolve(null),
      machine: (tabId) => tracker.remoteOf(tabId)?.host,
      pages: guestPagesOf,
      open: openOnTabMachine,
      sleep
    }),
    gh: githubVerb({
      scopeOf: (tabId) => conductors?.scopeOfTab(tabId),
      folderOf: (scope) => conductorFolder(app.getPath('userData'), scope),
      repoOf: async (scope) =>
        scope === GLOBAL_SCOPE ? null : hosts.of(scope).github.ownerSlashName(scope),
      // PLATFORM§1
      run: async (args, scope) => {
        await loginEnvReady()
        const env =
          scope === GLOBAL_SCOPE
            ? await gitAccounts?.ghEnvForRepo(
                repoFlagOf(args),
                (workspaceMgr?.pinnedPaths() ?? []).map((w) => w.path)
              )
            : await gitAccounts?.ghEnv(scope)
        return ghRead(args, env)
      }
    })
  },
  tab: (tabId) => ptyMgr.get(tabId),
  session: sessionOfTab,
  enabled: (tabId) => {
    const backend = backendIdOf(ptyMgr.get(tabId)?.kind)
    return !!backend && agentToolsFor(backend, hostOfTab(tabId))
  },
  alive: pidAlive
})

async function pickForLaunch(
  tabId?: string,
  resumeSessionId?: string
): Promise<{
  res: PickResponse
  endpoint?: { baseUrl?: string; model?: string }
}> {
  let res: PickResponse
  try {
    res = await picker.pick(tabId, sessionAccounts?.of('claude', resumeSessionId))
  } catch {
    res = { account: null, reason: 'no-usable' }
  }
  if (!res.account || res.kind !== 'custom') return { res }
  const meta = findAccount(res.account, 'custom')
  return { res, endpoint: { baseUrl: meta?.baseUrl, model: meta?.model } }
}

async function pickedAccountEnv(): Promise<NodeJS.ProcessEnv | null> {
  await loginEnvReady()
  const picked = await pickMachineAccount(() => pickForLaunch())
  if (!picked) return null
  const env = { ...process.env }
  for (const k of CLAUDE_AUTH_ENV_VARS) delete env[k]
  // ADR-0030
  return { ...env, ...picked.env, KOLOFT_ACCOUNT_PICKED: '1' }
}

async function handlePickRequest(pickDir: string, reqName: string, raw: unknown): Promise<void> {
  const obj = raw as { tabId?: string; ts?: number }
  const tab = obj.tabId ? ptyMgr.get(obj.tabId) : undefined
  if (!obj.tabId || !tab) return
  const id = reqName.slice('req-'.length).replace(/\.json$/, '')
  if (!/^[A-Za-z0-9-]+$/.test(id)) return
  const { res, endpoint } = await pickForLaunch(obj.tabId, tab.resumeSessionId)
  const payload: Record<string, unknown> = { ...res }
  if (res.account && loadSettings().skipPermissions) payload.skipFlag = true
  claudeBackend.picked(obj.tabId, payload.skipFlag === true)
  if (endpoint?.baseUrl) payload.baseUrl = endpoint.baseUrl
  if (endpoint?.model) payload.model = endpoint.model
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
  w.buf = (w.buf + stripTerminalCodes(data)).slice(-LOGIN_BUF_MAX)
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
    koloftShim: PLAIN_KOLOFT_SHIM,
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
let probeOnceTheRendererIsUp = false

function probeAllForPanel(): Promise<AccountView[]> {
  if (probeAllInFlight) return probeAllInFlight
  const round = (async (): Promise<AccountView[]> => {
    const claude = listAccounts().filter(
      (a) => a.enabled && ACCOUNT_KINDS_OF.claude.includes(a.kind)
    )
    await Promise.all([
      probeCodexAccounts(),
      probeMuseAccounts(),
      probeAgyAccounts(),
      ...claude.map(async (a) => {
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
    ])
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
  if (kind === 'muse-home') return addMuseKey(name, typeof secret === 'string' ? secret : '')
  if (kind === 'agy-home') return addAgyKey(name, typeof secret === 'string' ? secret : '')
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

const codexPicker = new HomeAccountPicker('codex-home')
const MUSE_QUOTA_FOLDER = 'muse-quota'
const museProbedAt = new Map<string, number>()

function codexSharedConfig(): string {
  return codexConfigFile(codexSessions?.defaultEnv)
}

// CODEX§15
function pickCodexHome(
  resumeSessionId?: string
): { account: string; home: string; notice?: string } | undefined {
  const views = accountViews()
  const picked = codexPicker.pick(views, sessionAccounts?.of('codex', resumeSessionId))
  if (!picked) return undefined
  const stale = (a: AccountView): boolean => !a.limits || Date.now() - a.limits.at > AUTO_PROBE_MS
  if (views.some((a) => a.kind === 'codex-home' && a.enabled && stale(a))) void probeCodexAccounts()
  const home = codexHomeOf(app.getPath('userData'), picked.name)
  prepareCodexHome(home, codexSharedConfig())
  return { account: picked.name, home, notice: codexAllLimitedNotice(picked) }
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

async function codexUseReset(name: string): Promise<CodexResetOutcome> {
  if (!findAccount(name, 'codex-home') || !codexSessions) return 'failed'
  const outcome = await codexSessions
    .useResetCredit(codexHomeOf(app.getPath('userData'), name))
    .catch((): CodexResetOutcome => 'failed')
  await probeCodexAccount(name)
  return outcome
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

type HomeKind = SignInFolderKind
const signInPtys = new Map<string, { kind: HomeKind; name: string }>()

function noteHomeAccount(name: string, kind: HomeKind): void {
  const acct = findAccount(name, kind)
  upsertAccountMeta({
    name,
    kind,
    enabled: acct?.enabled ?? true,
    fable: 'unknown',
    status: acct?.status ?? 'unverified',
    addedAt: acct?.addedAt ?? Date.now()
  })
  pushAccounts()
}

const HOME_BACKEND: Record<HomeKind, BackendId> = {
  'codex-home': 'codex',
  'muse-home': 'muse',
  'agy-home': 'agy'
}

const homeLogin: Record<
  HomeKind,
  (name: string) => Promise<{ binary?: string; env: Record<string, string>; args?: string[] }>
> = {
  // CODEX§15
  'codex-home': async (name) => {
    const available = (await codexSessions?.availability())?.available
    const home = codexHomeOf(app.getPath('userData'), name)
    prepareCodexHome(home, codexSharedConfig())
    return { binary: available ? codexSessions?.cliBinary : undefined, env: { CODEX_HOME: home } }
  },
  // MUSE§13
  'muse-home': async (name) => ({
    binary: (await museServeFor(name))?.binary,
    env: museAccountEnv(museHomeFor(name))
  }),
  // AGY§5 AGY§7
  'agy-home': async (name) => {
    const binary = await agyBinary()
    const home = agyHomeFor(name)
    const apiKey = await agyApiKeyOf(name)
    setAgyApiKeyRoute(home, !!apiKey)
    return { binary, env: agyAccountEnv(apiKey), args: [`--gemini_dir=${home}`] }
  }
}

const probeHomeAccount: Record<HomeKind, (name: string) => Promise<void>> = {
  'codex-home': async (name) => {
    await codexSessions?.rereadSignIn(codexHomeOf(app.getPath('userData'), name))
    await probeCodexAccount(name)
  },
  'muse-home': (name) => probeMuseAccount(name),
  'agy-home': (name) => probeAgyAccount(name)
}

async function signInToHome(kind: HomeKind, name: string, again: boolean): Promise<SignInResult> {
  const v = again
    ? findAccount(name, kind)
      ? 'ok'
      : 'invalid-name'
    : validateNewAccount(name, kind)
  if (v !== 'ok') return { ok: false, error: v }
  const login = await homeLogin[kind](name)
  noteHomeAccount(name, kind)
  const assignments = Object.entries(login.env).map(([k, val]) => `${k}=${shq(val)}`)
  const args = (login.args ?? ['login']).map(shq).join(' ')
  const signIn = (quotedBinary: string): string =>
    `${assignments.join(' ')} ${quotedBinary} ${args} && exit`
  const tab = homeShellTab(
    login.binary
      ? signIn(shq(login.binary))
      : installThen(HOME_BACKEND[kind], signIn, process.env.KOLOFT_TEST_TOOL_INSTALLER)
  )
  signInPtys.set(tab.tabId, { kind, name })
  if (!login.binary) toolInstallPtys.add(tab.tabId)
  return { ok: true, ...tab }
}

const musePicker = new HomeAccountPicker('muse-home')
const preparedMuseHomes = new Set<string>()

// MUSE§2 MUSE§13
function museHomeFor(name: string): string {
  const home = museHomeOf(app.getPath('userData'), name)
  if (preparedMuseHomes.has(home)) return home
  const env = museSessions?.defaultEnv ?? process.env
  prepareMuseHome(home, museConfigHome(env))
  preparedMuseHomes.add(home)
  return home
}

// ADR-0030 MUSE§13
function pickMuseHome(
  resumeSessionId?: string
): { account: string; env: Record<string, string> } | undefined {
  const views = accountViews()
  const picked = musePicker.pick(views, sessionAccounts?.of('muse', resumeSessionId))
  const stale = (a: AccountView): boolean =>
    Date.now() - (museProbedAt.get(a.name) ?? 0) > AUTO_PROBE_MS
  if (views.some((a) => a.kind === 'muse-home' && a.enabled && stale(a))) void probeMuseAccounts()
  return picked && { account: picked.name, env: museAccountEnv(museHomeFor(picked.name)) }
}

async function museServeFor(
  name: string
): Promise<{ binary: string; env: NodeJS.ProcessEnv } | undefined> {
  const binary = (await museSessions?.availability())?.available && museSessions?.cliBinary
  if (!binary) return undefined
  return { binary, env: { ...museSessions?.defaultEnv, ...museAccountEnv(museHomeFor(name)) } }
}

// MUSE§13
async function probeMuseAccount(name: string): Promise<void> {
  const acct = findAccount(name, 'muse-home')
  const serve = acct && (await museServeFor(name))
  if (!acct || !serve) return
  const key = viewKey(name, 'muse-home')
  museProbedAt.set(name, Date.now())
  try {
    const signIn = await museSignIn(serve)
    const status = signIn !== 'none' ? 'ok' : acct.status === 'ok' ? 'expired' : acct.status
    if (status !== acct.status) upsertAccountMeta({ ...acct, status })
    if (status === 'expired' && acct.status !== 'expired') notifyExpired(name, 'Muse')
    if (signIn !== 'subscription') usageViews.delete(key)
    else {
      const dir = path.join(app.getPath('userData'), MUSE_QUOTA_FOLDER)
      fs.mkdirSync(dir, { recursive: true })
      const limits = await readMuseQuota(serve.binary, serve.env, dir)
      usageViews.set(key, { limits: limits ?? usageViews.get(key)?.limits })
    }
  } catch {
    usageViews.set(key, { ...usageViews.get(key), probeError: 'network' })
  }
  pushAccounts()
}

let museProbeRound: Promise<void> | null = null

function probeMuseAccounts(): Promise<void> {
  museProbeRound ??= Promise.all(
    listAccounts()
      .filter((a) => a.kind === 'muse-home' && a.enabled)
      .map((a) => probeMuseAccount(a.name))
  ).then(() => {
    museProbeRound = null
  })
  return museProbeRound
}

// MUSE§13
async function addMuseKey(name: string, key: string): Promise<AccountAddResult> {
  const v = validateNewAccount(name, 'muse-home')
  if (v !== 'ok') return { ok: false, error: v }
  const trimmed = key.trim()
  const serve = trimmed ? await museServeFor(name) : undefined
  if (!serve) return { ok: false, error: 'unknown' }
  noteHomeAccount(name, 'muse-home')
  await storeMuseKey(serve, trimmed).catch(() => undefined)
  await probeMuseAccount(name)
  const account = accountViews().find((a) => a.kind === 'muse-home' && a.name === name)
  return { ok: account?.status === 'ok', account }
}

const agyPicker = new HomeAccountPicker('agy-home')
const preparedAgyHomes = new Set<string>()

function ownersGemini(): string {
  return ownersGeminiDir(agySessions?.defaultEnv ?? process.env)
}

// AGY§4
function agyHomeFor(name: string): string {
  const home = agyHomeOf(app.getPath('userData'), name)
  if (preparedAgyHomes.has(home)) return home
  prepareAgyHome(home, ownersGemini())
  preparedAgyHomes.add(home)
  return home
}

async function agyApiKeyOf(name: string): Promise<string | undefined> {
  return (await keychainRead('agy-home', name)) ?? undefined
}

// ADR-0030
function pickAgyHome(resumeSessionId?: string): { account: string; home: string } | undefined {
  const picked = agyPicker.pick(accountViews(), sessionAccounts?.of('agy', resumeSessionId))
  return picked && { account: picked.name, home: agyHomeFor(picked.name) }
}

// AGY§5 AGY§6
async function probeAgyAccount(name: string): Promise<void> {
  const acct = findAccount(name, 'agy-home')
  if (!acct) return
  const home = agyHomeFor(name)
  const apiKey = await agyApiKeyOf(name)
  const signedIn = agySignedIn(home, !!apiKey)
  const status = signedIn ? 'ok' : acct.status === 'ok' ? 'expired' : acct.status
  if (status !== acct.status) upsertAccountMeta({ ...acct, status })
  const key = viewKey(name, 'agy-home')
  if (signedIn && !apiKey) {
    const quota = await agyUsage(home)
    usageViews.set(key, quota ? { quota } : { ...usageViews.get(key), probeError: 'network' })
  }
  pushAccounts()
}

async function agyBinary(): Promise<string | undefined> {
  return ((await agySessions?.availability())?.available && agySessions?.cliBinary) || undefined
}

async function agyUsage(home: string): Promise<QuotaBucket[] | undefined> {
  const binary = await agyBinary()
  if (!binary) return undefined
  return readAgyQuota(binary, { ...agySessions?.defaultEnv, ...agyAccountEnv() }, home)
}

function probeAgyAccounts(): Promise<void> {
  return Promise.all(
    listAccounts()
      .filter((a) => a.kind === 'agy-home' && a.enabled)
      .map((a) => probeAgyAccount(a.name))
  ).then(() => undefined)
}

// AGY§6
async function addAgyKey(name: string, key: string): Promise<AccountAddResult> {
  const v = validateNewAccount(name, 'agy-home')
  if (v !== 'ok') return { ok: false, error: v }
  const trimmed = key.trim()
  if (!trimmed || !(await keychainWrite('agy-home', name, trimmed)))
    return { ok: false, error: 'unknown' }
  setAgyApiKeyRoute(agyHomeFor(name), true)
  noteHomeAccount(name, 'agy-home')
  await probeAgyAccount(name)
  const account = accountViews().find((a) => a.kind === 'agy-home' && a.name === name)
  return { ok: account?.status === 'ok', account }
}

// AGY§6 AGY§20
async function agyOneShotTarget(): Promise<AssistTarget | null> {
  const picked = agyPicker.pick(accountViews())
  const binary = await agyBinary()
  if (!picked || !binary) return null
  const apiKey = await agyApiKeyOf(picked.name)
  const shot = oneShotAgyHome(
    agyHomeFor(picked.name),
    path.join(app.getPath('userData'), 'agy-one-shots'),
    !!apiKey
  )
  return {
    binary,
    env: { ...agySessions?.defaultEnv, ...agyAccountEnv(apiKey) },
    args: [`--gemini_dir=${shot.dir}`],
    done: shot.done
  }
}

function homeShellTab(launchCommand: string): { tabId: string; cwd: string } {
  const cwd = os.homedir()
  const handle = ptyMgr.create({
    kind: 'shell',
    koloftShim: PLAIN_KOLOFT_SHIM,
    cwd,
    cols: 100,
    rows: 30,
    launchCommand
  })
  return { tabId: handle.id, cwd }
}

const toolInstallPtys = new Set<string>()

function installTool(backend: BackendId): { tabId: string; cwd: string } {
  const tab = homeShellTab(
    installThen(backend, () => 'exit', process.env.KOLOFT_TEST_TOOL_INSTALLER)
  )
  toolInstallPtys.add(tab.tabId)
  return tab
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
  remoteSync?.unwatchAll()
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
  windowOpenedAt = Date.now()
  mainWindow = new BrowserWindow({
    ...geo.bounds,
    minWidth: windowMinWidth(geo.bounds.width),
    minHeight: 560,
    ...fullscreenOption(geo.fullScreen && !OFF_SCREEN_TEST),
    show: !OFF_SCREEN_TEST,
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
  // PLATFORM§10
  let pressedInHost = false
  mainWindow.webContents.on('before-mouse-event', (e, mouse) => {
    if (mouse.type === 'mouseDown') pressedInHost = true
    if (mouse.type !== 'mouseUp') return
    const releaseWithoutHostPress = !pressedInHost
    pressedInHost = false
    if (releaseWithoutHostPress) e.preventDefault()
  })
  // PLATFORM§5
  if (!OFF_SCREEN_TEST && geo.maximized && !geo.fullScreen) mainWindow.maximize()
  trackWindowState(
    mainWindow,
    OFF_SCREEN_TEST ? { maximized: geo.maximized, fullScreen: geo.fullScreen } : undefined
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
  mainWindow.on('enter-full-screen', () => sendToRenderer('window:fullscreen', true))
  mainWindow.on('leave-full-screen', () => sendToRenderer('window:fullscreen', false))
  mainWindow.on('focus', () => {
    // PLATFORM§10
    sendToRenderer('window:focus', true)
    if (blurredAt && Date.now() - blurredAt > WEBGL_REPAIR_BLUR_MS) requestWebglRepair()
    blurredAt = 0
    if (uiActiveTabId) {
      consumeOutletDedupe(uiActiveTabId)
      attention.clear(uiActiveTabId)
    }
    void freshness?.sweep({ host: null })
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
  updateDockBadge(attention.list())
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
  setupGuestPermissionQuery()
  setupPermissionCleanup()
  setupGuestBackgroundOpen()
  setupGuestAudioState()
  setupGuestFullscreen()

  sweepStaleGitRequestDirs(pidAlive)
  const gitRequestDir = newGitRequestDir()
  const { shimDir, regDir, openDir, pickDir, agentDir, gitHelper, ghWrapper } =
    setupShim(gitRequestDir)
  ptyMgr.shimDir = shimDir
  ptyMgr.regDir = regDir
  if (agentRequests.watch(agentDir)) {
    ptyMgr.agentDir = agentDir
    claudeAgentPlugin = writeAgentPlugin(app.getPath('userData'))
  }
  claudeBackend.agentReply = (tabId, raw) => agentRequests.replyFor(tabId, raw)
  claudeBackend.watchShimRegistrations(regDir)
  if (watchOpenRequests(openDir)) {
    ptyMgr.openDir = openDir
    sweepOpenRequests(openDir)
  }
  if (watchPickRequests(pickDir)) ptyMgr.pickDir = pickDir

  ptyMgr.cdpDir = cdpEnvDir()
  startRelay(relayDeps())
  setRelayEnabled(loadSettings().browserControl, ptyTabIds())

  const hookPaths = setupHooks((tabId) => anotherLiveInstanceOwns(tabId, pidAlive))
  const statusline = setupStatusline()
  const agyStatusline = setupAgyStatusline(statusline)
  const playwrightBin = setupPlaywrightCli()
  playwrightCliBin = playwrightBin
  fallbackBin = bundledGhDir()
  if (fallbackBin) process.env.PATH = pathWithDirLast(process.env.PATH, fallbackBin)
  gitFirstBin = setupBundledGit(path.dirname(playwrightBin), process.env.PATH)
  if (gitFirstBin) process.env.PATH = pathWithDirFirst(process.env.PATH, gitFirstBin)
  // PLATFORM§2
  linkOrUnlink(path.join(shimDir, 'git'), gitFirstBin && path.join(gitFirstBin, 'git'))
  removeStaleLoginDirs(app.getPath('userData'))
  gitAccounts = new GitAccountService({
    userData: app.getPath('userData'),
    requestDir: gitRequestDir,
    gitHelper,
    ghBin: fallbackBin && path.join(fallbackBin, 'gh'),
    gcmBin: bundledGcm(),
    gcmNamespacePrefix: `${keychainNamespace(app.getName())}-git`,
    baseEnv: () => loginEnvReady().then(() => ({ ...process.env })),
    repoOf: async (wsPath) => {
      const slug = await hosts.of(wsPath).github.ownerSlashName(wsPath)
      const [owner, name] = slug?.split('/') ?? []
      return owner && name ? { owner, name } : null
    },
    openInBrowser: (url) => void leaveForOS(url, 'url'),
    progress: (p) => sendToRenderer('gitAccounts:login-progress', p),
    accountsChanged: (views) => sendToRenderer('gitAccounts:update', views),
    picksChanged: () => {
      void githubCounts?.sweep()
      workspaceMgr?.restampLive()
    },
    runOnMachine: async (machine, script, args = [], opts = {}) => {
      await loginEnvReady()
      return runSsh(machine, remoteShCommand(script, args), {
        controlDir: remoteControlDir,
        timeoutMs: opts.timeoutMs,
        ...(opts.input !== undefined && { input: Buffer.from(opts.input) })
      })
    }
  })
  // ADR-0033
  Object.assign(process.env, gitAccounts.configEnv(process.env))
  gitAccounts.start()
  writeHookSettings = (tabId, allowKoloft, conductor) =>
    writeTabHookSettings(
      hookPaths,
      tabId,
      loadSettings().statuslineBuiltin ? statusLineSetting(statusline) : undefined,
      allowKoloft,
      conductor
    )
  hookRegDir = hookPaths.regDir
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
    // CC§12
    if (sleepers.has(d.id)) return
    if (loginWatchers.size) feedLoginWatcher(d.id, d.data)
    watchForWorktreeRemoval(d.id, d.data)
    pendingData.set(d.id, (pendingData.get(d.id) ?? '') + d.data)
    if (!flushTimer) flushTimer = setTimeout(flushData, PTY_OUTPUT_COALESCE_ONE_FRAME_MS)
  })
  ptyMgr.on('process-title', (t: { id: string; name: string }) => {
    sendToRenderer('terminal:processTitle', t)
  })
  ptyMgr.on('cwd', (c: { id: string; cwd: string }) => {
    sendToRenderer('terminal:cwd', c)
  })
  subscribeTabSubsystems(tabLifecycle, {
    slash,
    attention,
    claude: claudeBackend,
    tracker,
    storedOwnerOf,
    toast: (message) => sendToRenderer('cron:toast', message),
    notices: () => discordNotices,
    live: () => discordLive,
    relay: () => discordRelay,
    threads: () => discordThreads,
    buttons: () => askButtons,
    secrets: () => secretAsks,
    workspaces: () => workspaceMgr,
    cron: () => cronRunner,
    conductors: () => conductors
  })
  ptyMgr.on('exit', (e) => {
    const left = closedTabs.has(e.id) ? closedTabs.get(e.id) : leftTabOf(sessionOfTab(e.id))
    closedTabs.delete(e.id)
    const exit: TabExit = {
      tabId: e.id,
      exitCode: e.exitCode,
      signal: e.signal,
      asleep: sleepers.has(e.id),
      crashed: !quitCommitted && exitedAbnormally(e),
      left: left ?? undefined
    }
    for (const [oldId, newId] of wokenAs) if (newId === e.id) wokenAs.delete(oldId)
    const wakeThatDied = ptyMgr.get(e.id)?.resumeSessionId
    for (const [id, t] of sleepers)
      if (id !== e.id && t.sessionId === wakeThatDied) forgetSleeper(id)
    tabLifecycle.emit('exit', exit)
    if (answerable.delete(e.id) && hookRegDir) markAnswerable(hookRegDir, e.id, false)
    if (hookRegDir) forgetAssistMarkers(hookRegDir, e.id)
    loginPtys.delete(e.id)
    if (toolInstallPtys.delete(e.id)) {
      sessionBackends.forgetAvailability()
      sendToRenderer('sessions:toolsChanged')
    }
    const signedIn = signInPtys.get(e.id)
    if (signedIn) {
      signInPtys.delete(e.id)
      void probeHomeAccount[signedIn.kind](signedIn.name)
    }
    if (teardownKilledPtys.delete(e.id)) {
      flowGates.get(e.id)?.reset()
      flowGates.delete(e.id)
      return
    }
    if (loginWatchers.has(e.id)) failLogin(e.id, 'setup-token exited without printing a token')
    const claudeExit = claudeTabExits.get(e.id)
    claudeTabExits.delete(e.id)
    if (claudeExit?.leaving) {
      const { sessionId } = claudeExit.leaving
      if (sessionId) sessionsLeavingTheirWorktree.delete(sessionId)
      const claudeSaid = claudeExit.watch.failure()
      if (claudeSaid)
        sendToRenderer('cron:toast', `Claude Code did not remove the worktree: ${claudeSaid}`)
      workspaceMgr?.refresh()
    }
    flushData()
    // PLATFORM§21
    const held = pendingData.get(e.id)
    if (held !== undefined) {
      pendingData.delete(e.id)
      if (!sleepers.has(e.id)) sendToRenderer('terminal:data', { id: e.id, data: held })
    }
    flowGates.get(e.id)?.reset()
    flowGates.delete(e.id)
    tabLifecycle.emit('teardown', exit)
    sendToRenderer('terminal:exit', e)
  })
  tracker.on('update', () => {
    const all = onSessionsChanged()
    sendToRenderer('sessions:update', all)
    workspaceMgr?.onTrackerUpdate()
    syncAnswerable()
    retitleDiscordThreads(all)
  })
  tracker.on('relocated', (e: { tabId: string; dir: string }) => {
    sendToRenderer('session:relocated', e)
  })
  tracker.on('auto-close', ({ tabId }: { tabId: string }) => sleepTab(tabId))
  tracker.on('tool-done', ({ tabId, ...call }: ToolCall & { tabId: string }) =>
    discordRelay?.toolDone(tabId, call)
  )
  tracker.on('command-output', ({ tabId, ...output }: CommandOutput & { tabId: string }) =>
    slash.output(tabId, output)
  )
  tracker.on('turn-over', ({ tabId, over }: TurnOverEdge) => {
    ptyMgr.wakeReady(tabId)
    slash.turnOver(tabId, over)
    void discordLive?.refresh(tabId)
    if (!over) return
    sessionSync.flush(tabId)
    const workspace = pinnedWorkspaceOfTab(tabId)
    if (workspace) freshness?.fetchSoon(workspace)
  })
  tracker.on('status', (t: StatusEdge) => {
    ptyMgr.wakeReady(t.tabId)
    sessionSync.flush(t.tabId)
    const conductor = !!conductors?.heldResident(t.tabId)
    if (conductor && (t.next === 'approval' || t.next === 'waiting'))
      void pendingAskOf(t.tabId).then((a) => a && discordRelay?.codexAsked(t.tabId, a))
    discordNotices?.onStatus(t.tabId, t.prev, t.next)
    void discordLive?.refresh(t.tabId)
    if (!(conductor && t.next === 'waiting'))
      attention.onStatusChange(t.tabId, t.prev, t.next, attentionCtx(), attentionSubjectOf(t.tabId))
    // ADR-0022
    cronRunner?.onStatus(t.tabId, t.prev, t.next)
  })

  const userData = app.getPath('userData')
  const openTabsPath = path.join(userData, 'open-tabs.json')
  savedOpenTabs = readOpenTabs(openTabsPath)
  openTabsFile = new OpenTabsFile(openTabsPath, savedOpenTabs)
  sessionAccounts = new SessionAccounts(path.join(userData, 'session-accounts.json'))
  const storedDeps = {
    pty: ptyMgr,
    runtime: tracker,
    projectInfo: projectInfoOnHost,
    remoteDirExists: (dir: string) => hosts.of(dir).dirExistsOrThrow(dir),
    remoteTreeIo: machineTreeIo,
    changed: () => {
      const all = onSessionsChanged()
      sendToRenderer('sessions:update', all)
      workspaceMgr?.onAdditionalSessionsChanged()
      retitleDiscordThreads(all)
    },
    replaced: (oldKey: string, newKey: string) => workspaceMgr?.moveResident(oldKey, newKey),
    memberRemoved: (key: string) => discordThreads?.left(key),
    events: (tabId: string, event: SessionEvent) => sessionBackends.observe(tabId, event),
    error: (message: string) => sendToRenderer('cron:toast', message)
  }
  try {
    codexSessions = new CodexSessions(path.join(userData, 'sessions.json'), {
      ...storedDeps,
      machine: {
        instance: codexMachineInstance(userData),
        ready: loginEnvReady,
        run: (host, cmd) =>
          loginEnvReady().then(() => runSsh(host, cmd, { controlDir: remoteControlDir })),
        sshArgs: (machine, background) => {
          ensureControlDir(remoteControlDir)
          return background
            ? backgroundOptions(machine, remoteControlDir)
            : sshOptions(remoteControlDir, false)
        },
        machinePackage,
        tabDir: (tabId) => tabPackageDir(userData, tabId),
        fileExists: (file) => hosts.machine(parseRemoteKey(file)!.host).fileExists(file),
        keyed: pinnedKeyOn
      },
      leftWorktree: (resource) => removeUntouchedWorktree(codexSessions, resource),
      trustFolder: trustCodexFolder,
      pickHome: pickCodexHome,
      assistOf: (cwd, resumeKey) => conductors?.identityOfLaunch(cwd, resumeKey),
      conductorGate: {
        script: hookPaths.codexGate,
        writeAllow: (tabId, allow) => writeAllowFile(hookPaths.regDir, tabId, allow)
      },
      replyLanguageScript: hookPaths.codexReplyLanguage,
      browserEndpoint: relayEndpoint,
      openShimRoot: path.join(userData, 'codex-open'),
      playwrightBin,
      fallbackBin,
      gitBin: gitFirstBin,
      agent: {
        enabled: (host) => agentToolsFor('codex', host),
        answer: (tabId, dir, name, raw) => void agentRequests.answerFor(tabId, dir, name, raw)
      },
      gitAccounts: {
        configEnv: (env) => gitAccounts!.configEnv(env),
        picked: (cwd) => gitAccounts!.pickedAt(cwd),
        ghWrapper
      }
    })
  } catch (error) {
    startupErrors.codex = `Codex session data could not be loaded; the original file is preserved. ${String(error)}`
  }
  try {
    museSessions = new MuseSessions(path.join(userData, 'muse-sessions.json'), {
      ...storedDeps,
      remote: museOnMachines,
      leftWorktree: (resource) => removeUntouchedWorktree(museSessions, resource),
      openShimRoot: path.join(userData, 'muse-open'),
      pickHome: pickMuseHome,
      assistOf: (cwd, resumeKey) => conductors?.identityOfLaunch(cwd, resumeKey),
      conductorGate: {
        script: hookPaths.museGateScript,
        writeAllow: (tabId, allow) => writeAllowFile(hookPaths.regDir, tabId, allow)
      },
      skipPermissions: () => loadSettings().skipPermissions,
      serversAmong: async (pid, commands) =>
        museServersAmong(await sharedProcessTable.fresh(), pid, commands),
      browserEndpoint: relayEndpoint,
      playwrightBin,
      fallbackBin,
      gitBin: gitFirstBin,
      agent: {
        enabled: (remote) => agentToolsFor('muse', remote ? 'ssh' : 'local'),
        answer: (tabId, dir, name, raw) => void agentRequests.answerFor(tabId, dir, name, raw)
      },
      gitAccounts: {
        configEnv: (env) => gitAccounts!.configEnv(env),
        ghWrapper
      }
    })
  } catch (error) {
    startupErrors.muse = `Muse session data could not be loaded; the original file is preserved. ${String(error)}`
  }
  try {
    agySessions = new AgySessions(path.join(userData, 'agy-sessions.json'), {
      ...storedDeps,
      projectInfo: projectInfoOnHost,
      remoteDirExists: (dir) => hosts.of(dir).dirExistsOrThrow(dir),
      remoteTreeIo: machineTreeIo,
      remote: {
        ...museOnMachines,
        machine: (host) => hosts.machine(host),
        mirrorGemini: (host) => mirrorAgyGemini(userData, host),
        nextPull: (host) => {
          if (!remoteSync) return Promise.resolve()
          const pulled = remoteSync.nextPullDone(host)
          remoteSync.pokeNow(host)
          return pulled
        },
        machineName: () => machinePackage().name
      },
      leftWorktree: (resource) => removeUntouchedWorktree(agySessions, resource),
      openShimRoot: path.join(userData, 'agy-open'),
      scriptsDir: path.join(userData, 'agy-scripts'),
      ownersGemini,
      pickHome: pickAgyHome,
      apiKeyOf: agyApiKeyOf,
      builtInStatusLine: () => (loadSettings().statuslineBuiltin ? agyStatusline : undefined),
      skipPermissions: () => loadSettings().skipPermissions,
      assistOf: (cwd, resumeKey) => conductors?.identityOfLaunch(cwd, resumeKey),
      conductorGate: {
        script: hookPaths.agyGateScript,
        writeAllow: (tabId, allow) => writeAllowFile(hookPaths.regDir, tabId, allow)
      },
      browserEndpoint: relayEndpoint,
      playwrightBin,
      fallbackBin,
      gitBin: gitFirstBin,
      agent: {
        enabled: (remote) => agentToolsFor('agy', remote ? 'ssh' : 'local'),
        answer: (tabId, dir, name, raw) => void agentRequests.answerFor(tabId, dir, name, raw)
      },
      gitAccounts: {
        configEnv: (env) => gitAccounts!.configEnv(env),
        ghWrapper
      }
    })
  } catch (error) {
    startupErrors.agy = `Antigravity session data could not be loaded; the original file is preserved. ${String(error)}`
  }
  if (agySessions) {
    sessionBackends.register(agyBackend(agySessions, resumeProbes, machineProbes))
    void agySessions
      .availability()
      .then((agy) => (agy.available ? agySessions!.refreshHistory() : undefined))
      .catch((error) => sendToRenderer('cron:toast', String(error)))
  }
  if (museSessions) {
    sessionBackends.register(museBackend(museSessions, resumeProbes, machineProbes))
    void museSessions
      .availability()
      .then((muse) => (muse.available ? museSessions!.refreshHistory() : undefined))
      .catch((error) => sendToRenderer('cron:toast', String(error)))
  }
  if (codexSessions) {
    sessionBackends.register(codexBackend(codexSessions, resumeProbes, machineProbes))
    void codexSessions
      .availability()
      .then((codex) => {
        if (!codex.available) return
        // CODEX§15
        for (const home of codexHomes(userData)) prepareCodexHome(home, codexSharedConfig())
        return codexSessions!.refreshHistory()
      })
      .catch((error) => sendToRenderer('cron:toast', String(error)))
  }
  workspaceMgr = new WorkspaceManager({
    additionalRows: (wsPath) =>
      storedSessions().flatMap((stored) =>
        stored.rows(wsPath).map((r) => ({ ...r, backendId: stored.id }))
      ),
    additionalMembers: () => new Set(storedSessions().flatMap((stored) => [...stored.members()])),
    projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
    loadLayout,
    saveLayout,
    projectInfo: projectInfoFor,
    runningBindings: () => {
      const m = new Map<string, string>()
      for (const s of allSessions()) if (s.alive && s.sessionId) m.set(s.sessionId, s.tabId)
      for (const stored of storedSessions())
        for (const [key, tabId] of stored.runningBindings()) m.set(key, tabId)
      for (const [tabId, t] of sleepers) if (!m.has(t.sessionId)) m.set(t.sessionId, tabId)
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
    pushRows: (payload) => {
      sendToRenderer('workspace:rows', payload)
      syncAnswerable()
    },
    freshness: (wsPath) => freshness?.get(wsPath),
    github: (wsPath) => githubCounts?.get(wsPath),
    gitAccount: (wsPath) => gitAccounts?.workspaceAccount(wsPath),
    gitPickable: (wsPath) => !!gitAccounts?.pickableOnMachine(wsPath),
    onRescanned: (wsPaths) => {
      void freshness?.refreshLocal(wsPaths)
      void gitAccounts?.refreshRepoKeys(wsPaths).then(() => workspaceMgr?.restampLive())
      void githubCounts?.sweep()
      claudeBackend.watchRemoteHookMirrors()
    },
    jobCountFor: (wsPath) => cronRunner?.jobCountFor(wsPath) ?? 0,
    remoteProjectsRoot: (host) => mirrorProjectsRoot(userData, host),
    remoteRunning: (host) => remoteSync?.alive(host) ?? new Set(),
    remoteConnected: (host) => remoteSync?.connected(host) ?? false,
    remoteProblem: (host) => remoteSync?.problem(host),
    remoteGit: (host, p) => remoteSync?.gitInfo(host, p),
    killRemoteSession: (host, sessionId) =>
      claudeBackend.endRemoteTmux(host, tmuxSessionName(sessionId)),
    hiddenRow: (id) => !!conductors?.conductorOf(id) || sessionsLeavingTheirWorktree.has(id),
    parentOf: (rowId) => startedSessions.parentOfRow(rowId),
    conductorsRoot: path.join(userData, 'conductors'),
    sessionsOnDiskOrRunning: (ids) =>
      conductors?.forgetGone(
        (key) =>
          ids.has(key) ||
          (identityOf(key).backendId !== 'claude' &&
            !storedSessions().some((s) => s.id === identityOf(key).backendId && s.threadGone(key)))
      ),
    memberDropped: (sessionId, why) => {
      discordThreads?.left(sessionId)
      try {
        fs.appendFileSync(
          path.join(app.getPath('userData'), 'dropped-sessions.log'),
          `${new Date().toISOString()} ${sessionId} ${why}\n`
        )
      } catch {}
    }
  })
  conductors = new Conductors({
    userData,
    load: () => loadSettings().discord,
    loadRecords: () => loadSettings().assistSessions,
    save: (discord) => {
      void commitSettings({ discord })
      syncAnswerable()
    },
    saveQuietly: (discord) => void saveSettings({ discord }),
    saveRecords: (assistSessions) => void commitSettings({ assistSessions }),
    isPinned: (scope) => workspaceMgr?.isPinned(scope) ?? false,
    backend: assistBackendChoice,
    tabAlive: (tabId) => !!ptyMgr.get(tabId)?.alive,
    liveTabFor: (backend, key) => sessionBackends.get(backend).aliveTabFor(key),
    runningElsewhere: (backend, key) => sessionBackends.runningElsewhere(backend, key),
    transcriptExists: async (backend, key) => sessionBackends.get(backend).transcriptExists(key),
    start: (l) =>
      launchQuietTab(
        {
          kind: l.backend,
          cwd: l.cwd,
          role: l.role,
          allow: l.allow,
          conductor: true,
          trustFolder: true,
          firstPrompt: l.firstPrompt,
          name: !PEER_TRAITS[l.backend].namedAtLaunch
            ? undefined
            : reachedBySendMessage(l.backend)
              ? asPeerName(l.title)
              : l.title
        },
        l.title
      ),
    resume: async (l) => {
      const res = await sessionBackends.get(l.backend).resume({
        sessionId: l.key,
        cwd: l.cwd,
        mode: 'direct',
        role: l.role,
        conductor: true,
        trustFolder: true
      })
      if (!res.ok) throw new Error(res.code === 'backend' ? res.message : couldNotStart(l.title))
      const spawned: SpawnedTab = {
        id: res.id,
        kind: l.backend,
        cwd: res.cwd,
        title: l.title,
        sessionId: l.key
      }
      sendToRenderer('terminal:spawned', spawned)
      return res.id
    },
    kill: killTabFromMain,
    say: (channelId, text) => discordRelay?.say(channelId, text),
    rowsChanged: () => workspaceMgr?.refresh(),
    tasksChanged: () => sendToRenderer('conductors:tasks', conductors?.taskRows() ?? []),
    toast: (text) => sendToRenderer('cron:toast', text),
    bindDeadlineMs: cronBindDeadlineMs()
  })
  conductors.keepPinned(workspaceMgr.pinnedPaths().map((w) => w.path))
  conductors.followBackend(preferredAssistBackend(loadSettings()))
  const discordLockFile = path.join(userData, 'discord.lock')
  const link = new DiscordLink({
    apiUrl: discordApiUrl(),
    readToken: discordTokenRead,
    takeLock: () => takeLock(discordLockFile, pidAlive),
    releaseLock: () => releaseLock(discordLockFile),
    owner: () => conductors?.owner(),
    foundAppOwner: (owner) => conductors?.setOwner(owner),
    push: (status) => {
      sendToRenderer('discord:status', status)
      discordConnected = status.phase === 'connected'
      syncAnswerable()
    },
    onMessage: (m) => discordRelay?.onMessage(m),
    onInteraction: (i) => void interactions.handle(i),
    onReady: () => {
      for (const b of conductors?.bindings() ?? []) void conductors?.open(b.scope)
      void discordRelay?.catchUp()
      registerSlashCommands()
    },
    postFailed: (channelId, error) => {
      const name = conductors?.bindingOfChannel(channelId)?.channel.name ?? channelId
      const text = `Koloft could not post to #${name} in Discord: ${error}`
      sendToRenderer('cron:toast', text)
      const { failing } = link.status()
      const other = conductors
        ?.bindings()
        .find((b) => b.channel.channelId !== channelId && !failing[b.channel.channelId])
      if (other) void link.post(other.channel.channelId, text).catch(() => undefined)
    },
    channelGone: (channelId) => {
      if (conductors?.threadOfChannel(channelId)) discordThreads?.threadGone(channelId)
    }
  })
  discordLink = link
  const conductorsNow = conductors
  const threads = new SessionThreads({
    link,
    conductors: conductorsNow,
    deleteFailed: (threadName, error) =>
      sendToRenderer(
        'cron:toast',
        `Koloft could not delete the Discord thread "${threadName}", so it only archived it: ${errorText(error)}`
      ),
    opened: (tabId) => void discordLive?.refresh(tabId)
  })
  discordThreads = threads
  const conductorChannelOf = (tabId: string): string | undefined =>
    conductorsNow.bindingOfTab(tabId)?.channel.channelId
  discordLive = new LiveStatus({
    link,
    openerOf: (tabId) => threads.openerOf(tabId),
    conductorChannelOf,
    subject: async (tabId) => {
      const s = sessionOfTab(tabId)
      if (!s) return undefined
      const name = (await discordShownName(s)) ?? s.title
      return { name, backend: s.backendId, workspace: sessionBackends.workspaceOfTab(tabId) }
    },
    status: (tabId) => tracker.statusOf(tabId),
    turnOver: (tabId) => tracker.turnOver(tabId),
    unknown: (tabId) => statusUnavailable(sessionOfTab(tabId)),
    alive: (tabId) => !!ptyMgr.get(tabId)?.alive
  })
  const dialogOf = async (tabId: string): Promise<DialogView | undefined> => {
    const ask = await pendingAskOf(tabId)
    return ask ? codexDialog(ask) : discordRelay?.dialog(tabId)
  }
  const buttons = new AskButtons({
    owner: () => conductorsNow.owner(),
    dialogText: async (tabId) => (await dialogOf(tabId))?.text,
    answer: async (tabId, reply) => {
      if (!discordRelay) return STILL_STARTING
      return discordRelay.answerSession(tabId, reply)
    },
    respond: (i, body) => link.respond(i, body)
  })
  askButtons = buttons
  const secrets = new SecretAsks({
    owner: () => conductorsNow.owner(),
    place: async (tabId, card) => discordNotices?.placeCard(tabId, card),
    edit: (placed, card) => link.editCard(placed.channelId, placed.messageId, card),
    respond: (i, body) => link.respond(i, body)
  })
  secretAsks = secrets
  const interactions = new Interactions({
    owner: () => conductorsNow.owner(),
    routeOf: (channelId) => conductorsNow.routeOf(channelId),
    choices: (b) => [
      { name: `This channel’s Assist (${scopeName(b.scope)})`, value: MYSELF },
      ...sessionChoices(sessionDeps, b.scope)
    ],
    run: async (b, session, text) => {
      if (session === MYSELF) return commandIntoConductor(b, text)
      const found = await targetIn(sessionDeps, b.scope, session)
      if (!found.ok) throw new Error(found.error)
      return commandInto(b, found.value, text)
    },
    press: (i) => (i.customId?.startsWith(SECRET_ID_PREFIX) ? secrets.press(i) : buttons.press(i)),
    submit: (i) => secrets.submit(i),
    respond: (i, body) => link.respond(i, body)
  })
  const sessionDestination = (b: ConductorBinding, threadId: string, key: string): Destination => {
    const backend = identityOf(key).backendId
    const liveTab = (): string | undefined => sessionBackends.get(backend).aliveTabFor(key)
    const live = liveTab()
    const shown = live && sessionOfTab(live)
    const name =
      (shown && sidebarTitle(shown)) ||
      conductorsNow.threadOfChannel(threadId)?.thread.name ||
      'The session'
    return {
      id: `thread:${threadId}`,
      name,
      conductor: false,
      liveTab,
      open: async () => {
        const open = liveTab()
        if (open) return open
        const found = await targetIn(sessionDeps, b.scope, key)
        if (!found.ok)
          throw new Error(
            `${name} is no longer in the session list (it was closed for good), so it cannot be woken.`
          )
        return found.value.tabId ?? found.value.open()
      },
      typeCommand: (tab, command) =>
        slash.typeWhenIdle({ name, tabId: tab, conductor: false }, command, threadId),
      seen: (id) => conductorsNow.setThreadLastMessage(threadId, id)
    }
  }
  const attachmentsDir = path.join(userData, 'discord-attachments')
  discordRelay = new DiscordRelay({
    link,
    download: async (url) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Discord answered ${res.status} to an attachment download.`)
      return Buffer.from(await res.arrayBuffer())
    },
    owner: () => conductorsNow.owner(),
    destinationOf: (channelId) => {
      const route = conductorsNow.routeOf(channelId)
      if (!route) return undefined
      return route.sessionKey
        ? sessionDestination(route.binding, channelId, route.sessionKey)
        : conductorDestination(route.binding)
    },
    channels: () =>
      conductorsNow.bindings().flatMap((b) => [
        {
          channelId: b.channel.channelId,
          lastMessageId: b.lastMessageId,
          seen: (id: string) => conductorsNow.setLastMessage(b.id, id)
        },
        ...(b.threads ?? []).map((t) => ({
          channelId: t.threadId,
          lastMessageId: t.lastMessageId,
          seen: (id: string) => conductorsNow.setThreadLastMessage(t.threadId, id)
        }))
      ]),
    conductorChannelOf,
    withButtons: (tabId, view, card) => buttons.attach(tabId, view, card),
    remote: (tabId) => !!remoteHostOfTab(tabId),
    backendOf: (tabId) => backendIdOf(ptyMgr.get(tabId)?.kind),
    boundKey: (tabId) => sessionOfTab(tabId)?.sessionId || undefined,
    status: (tabId) => tracker.statusOf(tabId),
    awaitsInput: (tabId) => tracker.awaitsInput(tabId),
    turnOver: (tabId) => tracker.turnOver(tabId),
    waiting: (tabId) => {
      discordNotices?.waiting(tabId)
      void discordLive?.refresh(tabId)
    },
    alive: (tabId) => !!ptyMgr.get(tabId)?.alive,
    ready: (tabId, ready, ms) => ptyMgr.whenReady(tabId, ready, ms),
    asksChanged: (tabId) => ptyMgr.wakeReady(tabId),
    type: (tabId, keys) => ptyMgr.type(tabId, keys),
    queueDrained: (tabId) => codexSessions?.queueDrained(tabId) ?? true,
    queue: queueCodexMessage,
    sendLine: sendPeerLine,
    modeOf: (tabId) => sessionBackends.permissionClass(tabId),
    pendingApproval: (tabId) => storedOwnerOf(tabId)?.openApproval(tabId),
    pendingQuestion: (tabId) => storedOwnerOf(tabId)?.openQuestion(tabId),
    answerable: async (tabId) => {
      await storedOwnerOf(tabId)?.answerable?.(tabId)
    },
    answerInPlace: async (tabId, reply) => {
      return storedOwnerOf(tabId)?.answer?.(tabId, reply) ?? false
    },
    regDir: hookPaths.regDir,
    attachmentsDir
  })
  discordRelay.watchAsks()
  const pruneAttachments = (): void => pruneStale(attachmentsDir, ATTACHMENTS_KEPT_MS, true)
  pruneAttachments()
  setInterval(pruneAttachments, ATTACHMENTS_PRUNED_EVERY_MS).unref()
  discordNotices = new Notices({
    bindings: () => conductorsNow.bindings(),
    place: (b, subject) => threads.place(b, subject),
    threadOf: (key) => threads.threadOf(key),
    card: async (channelId, card) => discordRelay?.card(channelId, card),
    post: async (channelId, card) => (await link.card(channelId, card)).at(-1),
    archive: (threadId) => threads.archive(threadId),
    withButtons: (tabId, view, card) => buttons.attach(tabId, view, card),
    subject: noticeSubjectOf,
    shownName: (tabId) => discordShownName(sessionOfTab(tabId)),
    commandRunning: (tabId) => slash.running(tabId),
    dialog: dialogOf
  })
  tracker.dialogsWatched = (tabId) =>
    watchedByDiscord(conductorsNow, { tabId, conductor: conductorsNow.conductorOf(tabId) })
  void link.connect()
  remoteSync = new RemoteSync({
    run: (host, cmd) =>
      loginEnvReady().then(() => runSsh(host, cmd, { controlDir: remoteControlDir })),
    rsync: (host, r, l, extra) =>
      loginEnvReady().then(() => rsyncPull(host, r, l, extra, { controlDir: remoteControlDir })),
    targets: () => {
      const live = new Set([
        ...ptyMgr.list().flatMap((h) => (h.alive && h.remoteHost ? [h.remoteHost] : [])),
        ...(codexSessions?.machinesWithTabs() ?? [])
      ])
      const busy = new Set(
        allSessions().flatMap((s) => {
          const host = s.alive && machineOfTab(s.tabId)
          return host && (s.status === 'working' || s.status === 'approval') ? [host] : []
        })
      )
      return (workspaceMgr?.remoteTargets() ?? []).map((t) => ({
        host: t.host,
        mirrorProjectsRoot: mirrorProjectsRoot(userData, t.host),
        mirrorHookDir: mirrorHookDir(userData, t.host),
        ...(agySessions?.usesHost(t.host)
          ? {
              extraPulls: [
                {
                  from: AGY_REMOTE_BRAIN,
                  to: path.join(mirrorAgyGemini(userData, t.host), AGY_APP_DIR, 'brain'),
                  flags: AGY_BRAIN_FLAGS
                }
              ]
            }
          : {}),
        paths: t.paths,
        hasTabs: live.has(t.host),
        busy: busy.has(t.host)
      }))
    },
    onChange: (host) => {
      tracker.fillMachineScratchpads(host)
      workspaceMgr?.onRemoteChanged()
    },
    onLeft: (host, ids) => {
      claudeBackend.noticeRemoteExits(host, ids)
      for (const s of storedSessions()) s.noticeRemoteExits?.(host, ids)
    },
    onHooksPulled: (host) => {
      for (const s of storedSessions()) s.followMirrors?.(host)
    },
    onConnected: (host) => void freshness?.machineUp(host)
  })
  ptyMgr.on('typed', (tabId: string) => {
    const host = machineOfTab(tabId)
    if (host) remoteSync?.typedInto(host)
  })
  freshness = new GitFreshnessEngine({
    workspaces: () => workspaceMgr?.pinnedPaths() ?? [],
    autoFetch: () => loadSettings().gitAutoFetch,
    autoPull: () => loadSettings().gitAutoPull,
    busy: (wsPath) => busyInCheckout(allSessions(), wsPath) > 0,
    toast: (text) => sendToRenderer('cron:toast', text),
    onChange: () => workspaceMgr?.restampLive(),
    onDefaultMoved: (move) => void sessionSync.defaultMoved(move, syncSessionsOf(allSessions())),
    runner: (wsPath) => {
      const key = parseRemoteKey(wsPath)
      return key && !remoteSync?.connected(key.host) ? null : hosts.of(wsPath).freshness
    },
    fetchFailed: (wsPath, stderr) => gitAccounts?.fetchFailed(wsPath, stderr)
  })
  githubCounts = new GithubCountsSweep({
    workspaces: () => workspaceMgr?.pinnedPaths() ?? [],
    openCounts: (wsPath) => hosts.of(wsPath).github.openCounts(wsPath),
    onChange: () => workspaceMgr?.restampLive()
  })
  workspaceMgr.start()
  freshness.start()
  githubCounts.start()
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
    isPinned: (p) => workspaceMgr?.isPinned(p) ?? false,
    dirExists: (p) => hosts.of(p).dirExists(p),
    gitDirExists: (root) => hosts.of(root).dirExists(`${root}/.git`),
    worktreeDirExists: (root, name) => hosts.of(root).dirExists(`${worktreeHomeOf(root)}/${name}`),
    worktreeRecorded: (root, name) =>
      storedSessions().some((s) =>
        s.worktrees.recorded(`${worktreeHomeOf(realpathSafe(root))}/${name}`)
      ),
    branchExists: (root, branch) => gitProbes(hostGitOut).branchExists(root, branch),
    listRunFolders,
    runLeftovers,
    tidyRun,
    foldersInUse,
    quitting: () => quitCommitted,
    accountUsable: (backend) => sessionBackends.get(backend).accountUsable(),
    trusted: (wsPath, backend) => sessionBackends.get(backend).trustsFolder(wsPath),
    ready: () => rendererReady && BrowserWindow.getAllWindows().length > 0,
    launch: launchCronRun,
    killTab: (tabId) => void killTabPty(tabId),
    stillWorking: (tabId) => tracker.stillWorking(tabId),
    whatIsLeft: whatClosingTheRunWouldLose,
    closeForGood: closeTheRunFully,
    toast: (text) => sendToRenderer('cron:toast', text),
    notify: notifyPlain,
    push: (state) => sendToRenderer('cron:state', state),
    killed: (tabId) => sendToRenderer('tab:killedByMain', tabId),
    endpointAccountWithModelOf: (tabId) => {
      const name = tracker.infoOf(tabId)?.pickedAccount
      return name && findAccount(name, 'custom')?.model ? name : undefined
    },
    bindDeadlineMs: cronBindDeadlineMs(),
    closeRecheckMs: cronTestMs('KOLOFT_CRON_CLOSE_RECHECK_MS', CRON_CLOSE_RECHECK_MS),
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
  powerMonitor.on('resume', () => void freshness?.sweep({ host: null }))
  // PLATFORM§3
  powerMonitor.on('resume', () => cronRunner?.onResume())
  screen.on('display-added', requestWebglRepair)
  screen.on('display-removed', requestWebglRepair)
  screen.on('display-metrics-changed', requestWebglRepair)

  createWindow()
  startUpdateNotifier((offer) => sendToRenderer('update:offer', offer))

  const capsuleShownSoLaunchProbeIsNotBilledForNothing = (): boolean =>
    listAccounts().some((a) => a.enabled && a.kind === 'oauth')
  probeOnceTheRendererIsUp = capsuleShownSoLaunchProbeIsNotBilledForNothing()

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

let storedQuitPending = false
let storedQuitStopped = false
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
  if (!quitCommitted) rememberOpenTabs()
  quitCommitted = true
  if (!storedQuitStopped && storedSessions().some((s) => s.hasProcesses())) {
    e.preventDefault()
    if (!storedQuitPending) {
      storedQuitPending = true
      void Promise.all(
        storedSessions().map((s) =>
          s
            .stopAll()
            .catch((error) =>
              console.error(`[koloft] ${BACKEND_LABEL[s.id]} did not stop cleanly:`, error)
            )
        )
      ).finally(() => {
        storedQuitStopped = true
        app.quit()
      })
    }
    return
  }
  for (const { leaving } of claudeTabExits.values()) {
    if (leaving?.claudePid && leaving.treeRoot)
      finishAfterKoloftQuits(leaving.claudePid, leaving.treeRoot)
  }
  claudeTabExits.clear()
  cronRunner?.quitSweep()
  cronRunner?.stop()
  discordLink?.stop()
  conductors?.flush()
  workspaceMgr?.dispose()
  flushLayout()
  openTabsFile?.flushSync()
  sessionAccounts?.flushSync()
  for (const stored of storedSessions()) stored.store.flushSync()
  flushAttention()
  freshness?.stop()
  remoteSync?.stop()
  gitAccounts?.stop()
  closeAllDirWatchers()
  resetQuitGuard()
})

function setupLine(playwrightBin?: string): string | undefined {
  if (!ptyMgr.shimDir) return undefined
  const dirs = playwrightBin ? `${ptyMgr.shimDir}:${playwrightBin}` : ptyMgr.shimDir
  return `export PATH="${dirs}:$PATH"; hash -r 2>/dev/null; clear`
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
const guestOwners = new WeakMap<WebContents, string>()

function tabOwningGuest(guest: WebContents): string | null {
  return guestOwners.get(guest) ?? uiActiveTabId
}
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

// PLATFORM§11
function setupGuestPermissionQuery(): void {
  ipcMain.on('browser:permission-undecided', (e, name: unknown) => {
    const decision = permissionQueryAsk(name, {
      requestingUrl: e.senderFrame?.url,
      isMainFrame: e.senderFrame?.parent === null
    })
    e.returnValue =
      e.sender.session === session.fromPartition(BROWSER_PARTITION) &&
      !isOverlayGuest(e.sender) &&
      decision.kind === 'ask' &&
      rememberedPermission(decision.origin, decision.permission) === undefined
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
    const decision = routeFor(url.slice(0, 4096), 'user')
    if (decision.dest !== 'browser') {
      routeGuestPopup(url, e.sender)
      return
    }
    if (openAsDrivingAgentsTab(e.sender, decision.target)) return
    const tabId = tabOwningGuest(e.sender)
    if (!tabId) return
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
const screenAsks = new Map<string, (a: ScreenAnswer) => void>()
let windowOpenedAt = 0
const SCREEN_ANSWER_BUDGET_MS = 3000

async function screenLines(tabId: string): Promise<string[] | undefined> {
  const screen = await screenOf(tabId)
  return 'lines' in screen ? screen.lines : undefined
}

async function screenOf(tabId: string): Promise<SessionScreen> {
  const handle = ptyMgr.get(tabId)
  if (!handle) return { error: 'it is not open, so it has no screen.' }
  if (!mainWindow || mainWindow.isDestroyed())
    return {
      error: 'the Koloft window is closed, so its screen cannot be read until it opens again.'
    }
  const requestId = crypto.randomUUID()
  const answer = await new Promise<ScreenAnswer | null>((resolve) => {
    const timer = setTimeout(() => {
      screenAsks.delete(requestId)
      resolve(null)
    }, SCREEN_ANSWER_BUDGET_MS)
    screenAsks.set(requestId, (a) => {
      clearTimeout(timer)
      resolve(a)
    })
    const request: ScreenRequest = { requestId, tabId }
    sendToRenderer('terminal:screen', request)
  })
  if (!answer?.lines) return { error: 'the Koloft window did not show its screen.' }
  const notes: string[] = []
  if (windowOpenedAt > handle.startedAt)
    notes.push(
      'The Koloft window was opened again after this session started, so the screen holds only what came after that.'
    )
  if (!answer.sizedToPane)
    notes.push(
      'This tab has not been on screen since Koloft started, so its lines may wrap at a different width.'
    )
  return { lines: answer.lines, notes }
}

function ptyTabIds(): string[] {
  return ptyMgr
    .list()
    .filter(
      (p) =>
        !p.util &&
        (p.kind === 'shell' ||
          capabilitiesFor(p.kind, remoteHostOfTab(p.id) ? 'ssh' : 'local').browserControl === true)
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
    sessionForTab: (tabId) =>
      claudeBackend.sessionIdOf(tabId) ?? storedOwnerOf(tabId)?.sessionIdOf(tabId) ?? null,
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

function openAsDrivingAgentsTab(from: WebContents, url: string): boolean {
  const driver = sessionDrivingGuest(from.id)
  if (driver) void cdpOp('create', driver, { url })
  return driver !== null
}

function routeGuestPopup(url: string, from: WebContents): void {
  if (isOverlayGuest(from)) {
    const decision = routeFor(url, 'user')
    if (decision.dest === 'browser') sendOverlayOpen(decision.target, 'now')
    else if (decision.dest === 'system') openUrlExternally(decision.target)
    else sendToRenderer('browser:blocked-scheme', url)
    return
  }
  const decision = routeFor(url, 'user')
  if (decision.dest === 'browser' && openAsDrivingAgentsTab(from, decision.target)) return
  const tabId = tabOwningGuest(from)
  if (!tabId) return
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
  // PLATFORM§14
  ses.setUserAgent(guestUA, app.getPreferredSystemLanguages().join(','))
  // PLATFORM§14
  app.userAgentFallback = guestUA
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
  // PLATFORM§39
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: webPageReachesDiscordDesktopApp(details.url, details.initiatorOrigin) })
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
    if (anotherLiveInstanceOwns(obj.tabId, pidAlive)) return
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

async function openOnMachine(
  tabId: string,
  machine: string,
  file: string,
  view?: ArtifactView
): Promise<boolean> {
  const keyed = formatRemoteKey(machine, file)
  if (!(await hosts.machine(machine).fileExists(keyed))) return false
  const payload: OpenRequest = { tabId, path: keyed, source: 'agent', view }
  sendToRenderer('preview:open-file', payload)
  return true
}

function killTabFromMain(tabId: string): void {
  sendToRenderer('tab:killedByMain', tabId)
  void killTabPty(tabId)
}

function killTabPty(tabId: string, restarting = false): Promise<boolean> {
  const sleeper = sleepers.get(tabId)
  if (sleeper) {
    forgetSleeper(tabId)
    const tree = projectInfoFor(sleeper.cwd).treeRoot
    const owner = restarting ? undefined : storedSessions().find((s) => s.id === sleeper.kind)
    const resource = owner?.store.listResources().find((r) => r.worktreePath === tree)
    if (!restarting) cronRunner?.onTabGone({ treeRoot: tree, sessionId: sleeper.sessionId })
    return (resource ? removeUntouchedWorktree(owner, resource) : Promise.resolve()).then(
      () => true
    )
  }
  if (ptyMgr.get(tabId)?.alive) {
    discordNotices?.closed(tabId)
    discordLive?.closed(tabId)
  }
  return stopTabProcess(tabId, restarting)
}

function stopTabProcess(tabId: string, restarting = false): Promise<boolean> {
  if (ptyMgr.get(tabId)?.alive)
    closedTabs.set(tabId, restarting ? null : leftTabOf(sessionOfTab(tabId)))
  const owner = sessionBackends.ownerOfTab(tabId)
  const stopped = owner
    ? Promise.resolve(owner.stop(tabId, restarting))
    : Promise.resolve(ptyMgr.kill(tabId))
  attention.clearKeepingExit(tabId)
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

function archiveSession(id: string): boolean {
  const archived = sessionBackends.forSession(id).archive(id)
  if (archived) {
    attention.clearSession(id)
    startedSessions.forget(id)
    readerDocs.forget(id)
  }
  return archived
}

const CLOSE_AFTER_THE_CALLER_READS_ITS_REPLY_MS = 1_000

function closableSessions(): ClosableSession[] {
  const live: ClosableSession[] = allSessions()
  const liveIds = new Set(live.map((s) => s.sessionId))
  const cold: ClosableSession[] = (workspaceMgr?.rows() ?? [])
    .flatMap((w) => w.rows)
    .filter((r) => !liveIds.has(r.id))
    .map((r) => ({
      sessionId: r.id,
      nativeSessionId: r.nativeSessionId,
      backendId: r.backendId,
      title: r.title,
      treeRoot: r.cwd
    }))
  return [...live, ...cold]
}

const hostGitOut: GitOut = (dir, args, timeoutMs) => hosts.of(dir).gitOut(dir, args, timeoutMs)

function treeRootOf(s: SessionInfo): string {
  return projectInfoFor(s.remote ? formatRemoteKey(s.remote.host, s.treeRoot) : s.treeRoot).treeRoot
}

function leftTabOf(s: SessionInfo | undefined): LeftTab {
  return s ? { treeRoot: treeRootOf(s), sessionId: s.sessionId || undefined } : {}
}

function aliveSessionsIn(treeRoot: string, exceptTabId?: string): SessionInfo[] {
  return allSessions().filter(
    (s) => s.tabId !== exceptTabId && s.alive && treeRootOf(s) === treeRoot
  )
}

async function whatClosingWouldLose(
  target: ClosableSession,
  info = projectInfoFor(target.treeRoot)
): Promise<string[]> {
  const tree = await closingTree(hostGitOut, info)
  if (!tree) return []
  const sharing = aliveSessionsIn(tree.treeRoot, target.tabId)
  return [
    ...sharing.map((s) => `The session "${s.title}" is still open in ${tree.treeRoot}.`),
    ...(await whatIsLeft(hostGitOut, tree))
  ]
}

async function closeSessionFully(
  target: ClosableSession,
  info = projectInfoFor(target.treeRoot)
): Promise<void> {
  const tabId = target.tabId ?? sleepingTabOf(target.sessionId)
  if (tabId) {
    sendToRenderer('tab:killedByMain', tabId)
    await killTabPty(tabId)
  } else if (allSessions().some((s) => s.alive && s.sessionId === target.sessionId)) {
    sendToRenderer('cron:toast', `${target.title} was opened again, so Koloft did not close it.`)
    return
  }
  const tree = await closingTree(hostGitOut, info)
  const alreadyRemoved =
    !!tree && !tree.branches.length && !(await hosts.of(info.treeRoot).dirExists(info.treeRoot))
  const problem = tree && !alreadyRemoved && (await removeTree(hostGitOut, tree))
  if (problem) {
    sendToRenderer('cron:toast', `${target.title}: ${problem}`)
    return
  }
  archiveSession(target.sessionId)
  for (const stored of storedSessions()) stored.store.removeUnusedResourcesAt(info.treeRoot)
}

async function removeUntouchedWorktree(
  owner: SessionsWithStore | null | undefined,
  resource: WorktreeResource
): Promise<void> {
  const tree = resource.worktreePath
  if (sleeperTrees().includes(tree)) return
  if (sessionBackends.occupantOf(tree) || !(await owner?.worktrees.untouched(resource))) return
  const problem = await removeTree(hostGitOut, {
    root: resource.originalCwd,
    treeRoot: tree,
    worktreeName: resource.worktreeName,
    branches: [`worktree-${resource.worktreeName}`]
  })
  if (problem && (await hosts.of(tree).dirExists(tree))) sendToRenderer('cron:toast', problem)
}

function cronRunTree(root: string, worktree?: string): ProjectInfo {
  return worktree
    ? { root, treeRoot: `${worktreeHomeOf(root)}/${worktree}`, worktreeName: worktree }
    : { root, treeRoot: root }
}

const NO_SESSION_FOR_THE_RUN = "Koloft cannot find this run's session."
const RUN_HAS_UNSAVED_EDITS = 'its Workbench has unsaved edits'

async function whatClosingTheRunWouldLose(
  tabId: string,
  root: string,
  worktree?: string
): Promise<string[]> {
  if (dirtyTabIds.has(tabId)) return [RUN_HAS_UNSAVED_EDITS]
  const session = sessionOfTab(tabId)
  if (!session) return [NO_SESSION_FOR_THE_RUN]
  return whatClosingWouldLose(session, cronRunTree(root, worktree))
}

async function closeTheRunFully(tabId: string, root: string, worktree?: string): Promise<void> {
  const session = sessionOfTab(tabId)
  if (session) await closeSessionFully(session, cronRunTree(root, worktree))
}

async function worktreeFolders(root: string): Promise<string[]> {
  const entries = await hosts.of(root).listDir(worktreeHomeOf(root), { showIgnored: true })
  return entries.filter((e) => e.isDir).map((e) => e.name)
}

async function listRunFolders(root: string, slug: string): Promise<string[]> {
  return (await worktreeFolders(root)).filter((name) => isRunFolderOf(slug, name))
}

const WORKTREE_BRANCH = 'worktree-'

async function runLeftovers(root: string): Promise<RunLeftovers> {
  const [folders, branches] = await Promise.all([
    worktreeFolders(root),
    hostGitOut(root, ['branch', '--list', `${WORKTREE_BRANCH}*`, '--format=%(refname:short)'])
  ])
  const branched =
    branches === null
      ? null
      : branches
          .split('\n')
          .filter((b) => b.startsWith(WORKTREE_BRANCH))
          .map((b) => b.slice(WORKTREE_BRANCH.length))
  return { folders, branched }
}

const STILL_RUNNING_ON_THE_MACHINE = 'still running on the machine'

async function tidyRun(root: string, worktree: string, sessionId?: string): Promise<TidyResult> {
  const host = parseRemoteKey(root)?.host
  if (host && sessionId) {
    const after = await claudeBackend.waitRemoteGone(host, sessionId)
    if (after === 'alive') return { removed: false, kept: [STILL_RUNNING_ON_THE_MACHINE] }
    if (after === 'unreachable') return machineUnreachable()
  }
  const info = cronRunTree(root, worktree)
  const result = await tidyTree(hostGitOut, info, (d) => hosts.of(d).dirExistsOrThrow(d))
  if (result.removed)
    for (const stored of storedSessions()) stored.store.removeUnusedResourcesAt(info.treeRoot)
  return result
}

function sleeperTrees(): string[] {
  return [...sleepers.values()].map((t) => projectInfoFor(t.cwd).treeRoot)
}

function foldersInUse(leavingTabId?: string): Set<string> {
  const alive = allSessions().filter((s) => s.tabId !== leavingTabId && s.alive)
  return new Set([...alive.map(treeRootOf), ...sleeperTrees()])
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

const RESUMES_AT_ONCE = 4

function restoreOpenTabs(): string | undefined {
  if (openTabsRestoreStarted || !workspaceMgr) return undefined
  openTabsRestoreStarted = true
  const plan = restorePlan(savedOpenTabs, workspaceMgr.residentIds())
  let activeAsleep: string | undefined
  for (const t of plan.asleep) {
    const id = `asleep-${++sleeperSeq}`
    addSleeper(id, t)
    if (t.sessionId === savedOpenTabs.active) activeAsleep = id
  }
  void resumeAwake(
    [...plan.awake.map((t) => t.sessionId), ...plan.keepRunningOnly],
    savedOpenTabs.active
  ).finally(() => {
    openTabsRestored = true
    rememberOpenTabs()
    cronRunner?.sweepLeftFolders()
  })
  tabLifecycle.emit('slept')
  return activeAsleep
}

async function resumeAwake(ids: string[], active: string | undefined): Promise<void> {
  if (!workspaceMgr || !ids.length) return
  await workspaceMgr.firstScan
  const rows = workspaceMgr.rows().flatMap((w) => w.rows)
  const resumeOne = async (id: string): Promise<void> => {
    const row = rows.find((r) => r.id === id)
    const resumed = row
      ? await resumeRow(row, { rebuildGoneWorktree: false }).catch(() => ({
          ok: false as const,
          error: couldNotStart(row.title)
        }))
      : undefined
    if (!resumed?.ok) {
      if (resumed) sendToRenderer('cron:toast', resumed.error)
      return
    }
    if (id === active) sendToRenderer('attention:activate-tab', { tabId: resumed.tabId })
    await tabReady(resumed.tabId, RESUMED_TAB_READY_MS, false)
  }
  await mapAtMost(ids, RESUMES_AT_ONCE, resumeOne)
}

function couldNotStart(title: string): string {
  return `Could not start “${title}” — click it to try again.`
}

// CC§11
async function resumeRow(
  row: SessionRow,
  { rebuildGoneWorktree }: { rebuildGoneWorktree: boolean }
): Promise<{ ok: true; tabId: string } | { ok: false; error: string }> {
  const backend = sessionBackends.forSession(row.id)
  const plan = await backend.resumePlan(row.id)
  if (plan.action === 'dialog' || (plan.action === 'rebuild' && !rebuildGoneWorktree)) {
    return {
      ok: false,
      error: `“${row.title}” needs you — its worktree changed. Click it to resume.`
    }
  }
  if (plan.action === 'unavailable') {
    return {
      ok: false,
      error:
        plan.reason === 'running'
          ? `“${row.title}” is already running in another ${row.backendId} process, so Koloft left it there.`
          : `Could not start “${row.title}” — its folder is gone.`
    }
  }
  const res = await backend.resume({
    sessionId: row.id,
    cwd: plan.action === 'rebuild' ? plan.resumeCwd : plan.cwd,
    mode: plan.action
  })
  if (!res.ok) return { ok: false, error: couldNotStart(row.title) }
  const spawned: SpawnedTab = {
    id: res.id,
    kind: row.backendId,
    cwd: res.cwd,
    title: row.title,
    sessionId: row.id
  }
  sendToRenderer('terminal:spawned', spawned)
  return { ok: true, tabId: res.id }
}

function tabReady(tabId: string, ms: number, turnEnded: boolean): Promise<boolean> {
  return ptyMgr.whenReady(
    tabId,
    () =>
      !!sessionOfTab(tabId)?.sessionId &&
      tracker.statusOf(tabId) !== undefined &&
      (!turnEnded || tracker.turnOver(tabId)),
    ms
  )
}

function registerSlashCommands(): void {
  const guilds = new Set((conductors?.bindings() ?? []).map((b) => b.channel.guildId))
  void discordLink?.registerCommands([...guilds], SLASH_COMMANDS)
}

function noticeSubjectOf(tabId: string): NoticeSubject | undefined {
  const s = sessionOfTab(tabId)
  return s?.sessionId
    ? {
        tabId,
        key: s.sessionId,
        name: s.title,
        backend: s.backendId,
        workspace: sessionBackends.workspaceOfTab(tabId),
        conductor: s.conductor
      }
    : undefined
}

const LOOPBACK_OPEN_TIMEOUT_MS = 15_000

// CODEX§15
async function openOnTabMachine(tabId: string, url: string): Promise<string> {
  const host = tracker.remoteOf(tabId)?.host
  if (!host) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(LOOPBACK_OPEN_TIMEOUT_MS)
    }).catch((error: unknown) => `nothing (${errorText(error)})`)
    return typeof res === 'string' ? res : String(res.status)
  }
  await loginEnvReady()
  const r = await runSsh(
    host,
    `curl -sS -o /dev/null -w '%{http_code}' --max-time ${LOOPBACK_OPEN_TIMEOUT_MS / 1000} ${shq(url)}`,
    { controlDir: remoteControlDir, timeoutMs: LOOPBACK_OPEN_TIMEOUT_MS * 2 }
  )
  return r.stdout.trim() || `nothing (${r.stderr.trim()})`
}

function guestPagesOf(tabId: string): GuestPage[] {
  return webContents
    .getAllWebContents()
    .filter((wc) => !wc.isDestroyed() && guestOwners.get(wc) === tabId)
    .map((wc) => ({
      url: () => wc.getURL(),
      run: (script: string) => wc.executeJavaScript(script),
      reload: () =>
        new Promise<void>((resolve) => {
          wc.once('did-stop-loading', () => resolve())
          wc.reload()
        })
    }))
}

async function saveDiscordToken(token: string): Promise<boolean> {
  const saved = await discordTokenWrite(token)
  if (saved) void discordLink?.connect()
  return saved
}

function openDiscordSetup(ownerWords?: string): Promise<ConductorOpenResult> {
  if (!conductors) return Promise.resolve({ ok: false, error: STILL_STARTING })
  return conductors.openTask(GLOBAL_SCOPE, { ...DISCORD_SETUP_TASK, ownerWords })
}

async function bindWithNewChannel(input: NewChannelInput): Promise<ConductorSaveResult> {
  const link = discordLink
  const bound = conductors
  if (!bound || !link) return { ok: false, error: STILL_STARTING }
  const saved = await bound.saveWithNewChannel(
    input,
    preferredAssistBackend(loadSettings()),
    (scope, category) => link.newChannel(scope, bound.bindings(), category)
  )
  if (saved.ok) registerSlashCommands()
  return saved
}

function conductorDestination(b: ConductorBinding): Destination {
  return {
    id: b.id,
    name: 'Assist',
    conductor: true,
    liveTab: () => conductors?.liveTab(b.scope),
    open: async () => {
      const opened = await conductors?.open(b.scope)
      if (!opened) throw new Error(STILL_STARTING)
      if (!opened.ok) throw new Error(opened.error)
      return opened.tabId
    },
    typeCommand: (tabId, command) =>
      slash.typeWhenIdle(
        { name: `the ${conductorName(b.scope)}`, tabId, conductor: true },
        command,
        b.channel.channelId
      ),
    seen: (id) => conductors?.setLastMessage(b.id, id)
  }
}

async function commandInto(b: ConductorBinding, t: Target, text: string): Promise<string> {
  const channelId = (await discordThreads?.place(b, t)) ?? b.channel.channelId
  const target = (tabId: string): SlashTarget => {
    conductors?.touchNowAndNext(b.id, t.key, tabId)
    return { name: t.name, tabId, conductor: false }
  }
  if (t.tabId) return slash.run(target(t.tabId), text, channelId)
  void t
    .open()
    .then((tabId) => slash.typeWhenIdle(target(tabId), text, channelId))
    .catch((error: unknown) => discordRelay?.say(channelId, `⚠ ${errorText(error)}`))
  return `${t.name} is closed; Koloft resumes it, types ${text} once it is ready, and posts what it prints in Discord.`
}

function commandIntoConductor(b: ConductorBinding, text: string): string {
  if (!discordRelay) throw new Error(STILL_STARTING)
  discordRelay.command(conductorDestination(b), text, b.channel.channelId)
  return `Koloft will type ${text} into the ${conductorName(b.scope)} once its turn ends, and post what it prints in Discord.`
}

const PALETTE_MESSAGE_WAITS_FOR_THE_ASSIST_MS = 10_000
let paletteMessages = 0

const PALETTE_TASK_ANSWERS_ITSELF =
  'When this is a question or a piece of writing you can answer from what you know (translate, explain, draft a message), answer it here yourself; start or message a session only for work on files, commands or what a workspace holds.'

function paletteTask(title: string, text: string): AssistTask {
  return {
    name: title || firstLineName(text),
    brief: `${text}\n${PALETTE_TASK_ANSWERS_ITSELF}`,
    staysOpen: true,
    ownerWords: text
  }
}

async function tellAssist(
  scope: string,
  title: string,
  text: string
): Promise<ConductorOpenResult> {
  const tabId = conductors?.liveTab(scope)
  return tabId ? sendPaletteText(scope, tabId, text) : openPaletteTask(scope, title, text)
}

async function openPaletteTask(
  scope: string,
  title: string,
  text: string
): Promise<ConductorOpenResult> {
  const all = conductors
  if (!all) return { ok: false, error: STILL_STARTING }
  const task = paletteTask(title, text)
  const running = all.runningTaskTab(scope, task.name)
  return running ? sendPaletteText(scope, running, text) : all.openTask(scope, task)
}

async function sendPaletteText(
  scope: string,
  tabId: string,
  text: string
): Promise<ConductorOpenResult> {
  const id = `koloft-palette-${++paletteMessages}`
  const route = messagingOf(backendIdOf(ptyMgr.get(tabId)?.kind) ?? 'claude', false)
  if (!(await tabReady(tabId, PALETTE_MESSAGE_WAITS_FOR_THE_ASSIST_MS, route === 'typed')))
    return { ok: false, error: `The ${conductorName(scope)} did not get ready in time.` }
  try {
    if (route === 'queue') await queueCodexMessage(tabId, text, id)
    else if (route === 'typed')
      await ptyMgr.type(tabId, [`The owner typed this in ⌘P: ${text}`, '\r'])
    else {
      const line = crossSessionLine('prompting', `The owner typed this in ⌘P: ${text}`, id)
      if (!line) return { ok: false, error: 'The message cannot be sent as it is.' }
      // ADR-0031
      if (hookRegDir) seedOwnerWords(saidFile(hookRegDir, tabId), text)
      await sendPeerLine(tabId, line, PALETTE_MESSAGE_WAITS_FOR_THE_ASSIST_MS)
    }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
  return { ok: true, tabId }
}

function conductorTarget(ref: string): Target | undefined {
  const all = conductors
  const scope = all?.scopeOf(ref)
  if (!all || !scope) return undefined
  const tabId = all.liveTab(scope)
  return {
    key: `conductor:${scope}`,
    name: `the ${conductorName(scope)}`,
    backend:
      (tabId && backendIdOf(ptyMgr.get(tabId)?.kind)) || preferredAssistBackend(loadSettings()),
    remote: false,
    tabId,
    assistScope: scope,
    open: async () => {
      const opened = await all.open(scope)
      if (!opened.ok) throw new Error(opened.error)
      return opened.tabId
    }
  }
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

const STILL_STARTING = 'Koloft is still starting — try again in a moment.'

const CRON_BIND_DEADLINE_MS = 90_000
const CRON_CLOSE_RECHECK_MS = 60_000
function cronTestMs(name: string, dflt: number): number {
  return (BACKGROUND_TEST && Number(process.env[name])) || dflt
}
function cronBindDeadlineMs(): number {
  return cronTestMs('KOLOFT_CRON_BIND_DEADLINE_MS', CRON_BIND_DEADLINE_MS)
}

const resumeProbes: ResumeProbes = {
  dirExists: dirExistsSync,
  occupantOf: (dir) => sessionBackends.occupantOf(dir),
  recorded: (dir) => storedSessions().some((s) => s.worktrees.recorded(dir)),
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

const BAD_GIT_STEP: { ok: false; reason: string } = { ok: false, reason: 'bad request' }

const githubOptions: GithubOptions = {
  fixture: parseGithubFixture(process.env.KOLOFT_GITHUB_FIXTURE),
  // PLATFORM§1
  countedAs: (root) => gitAccounts?.pickedAccount(root),
  openCounts: async (repo, root) => {
    await loginEnvReady()
    const onMachine = await gitAccounts?.machineGh(root, openCountsArgs(repo))
    if (onMachine) return onMachine.code === 0 ? parseOpenCounts(onMachine.stdout) : null
    return ghOpenCounts(repo, await gitAccounts?.ghEnv(root))
  },
  gh: async (args, root) => {
    await loginEnvReady()
    return (await gitAccounts?.machineGh(root, args)) ?? runGh(args, await gitAccounts?.ghEnv(root))
  },
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
  localHost(new GithubLookup(githubOptions), {
    hookRegDir: () => hookRegDir ?? '',
    agentPlugin: () => (agentToolsFor('claude', 'local') ? claudeAgentPlugin : undefined),
    assistOf: (cwd, resumeKey) => conductors?.identityOfLaunch(cwd, resumeKey)
  }),
  (machine) =>
    new SshHost(machine, {
      run: (cmd, opts) =>
        loginEnvReady().then(() =>
          runSshBytes(machine, cmd, { controlDir: remoteControlDir, ...opts })
        ),
      sshEnvReady: loginEnvReady,
      watch: (p, onChange) => remoteSync?.watch(machine, p, onChange),
      unwatch: (p) => remoteSync?.unwatch(machine, p),
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
        firstHeartbeatDone: () => remoteSync?.firstRoundDone(machine) ?? Promise.resolve(),
        realPath: (p) => workspaceMgr?.realRemotePath({ host: machine, path: p }) ?? p,
        settings: loadSettings,
        pickAccount: (launchKey, resumeSessionId) =>
          pickMachineAccount(() => pickForLaunch(launchKey, resumeSessionId)),
        agentTools: () => agentToolsFor('claude', 'ssh'),
        hookSettings: (tabId, dir, allowKoloft) =>
          machineHookSettings(tabId, dir, loadSettings().statuslineBuiltin, allowKoloft)
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
  setupLine: () => setupLine(playwrightCliBin),
  hookSettings: (tabId, allowKoloft, conductor) =>
    writeHookSettings?.(tabId, allowKoloft, conductor),
  ptysChanged: () => writeRelayEnv(ptyTabIds()),
  resumeProbes,
  events: (tabId, event) => sessionBackends.observe(tabId, event),
  error: (message) => sendToRenderer('cron:toast', message),
  machineOfTab,
  otherTabOnMachine: (machine, tmuxName, launchTab) =>
    storedSessions()
      .map((s) => s.tabOnMachine?.(machine, tmuxName, launchTab))
      .find(Boolean)
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
        koloftShim: PLAIN_KOLOFT_SHIM,
        cwd: launch.spawnCwd,
        cols: opts.cols,
        rows: opts.rows,
        setupCommand: setupLine(),
        launchCommand: launch.launchCommand,
        resized: launch.resized,
        shell: launch.shell,
        util: opts.util === true,
        ownerTabId: typeof opts.ownerTabId === 'string' ? opts.ownerTabId : undefined
      })
      writeRelayEnv(ptyTabIds())
      return { ok: true, id: handle.id, cwd: launch.cwd }
    }
  )

  ipcMain.on('terminal:write', (_e, id: string, data: string) => writeToTab(id, data))
  ipcMain.handle('terminal:paste', (_e, id: string, text: string, typedAfter?: string) => {
    if (typedWhileAsleep.has(id)) return writeToTab(id, bracketedPaste(text) + (typedAfter ?? ''))
    return ptyMgr.paste(id, text, typedAfter)
  })
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
  ipcMain.on(
    'terminal:kill',
    (_e, id: string, restarting: unknown) => void killTabPty(id, restarting === true)
  )

  ipcMain.handle('sessions:list', () => allSessions())
  ipcMain.handle('sessions:backends', (_e, recheck: unknown) => {
    if (recheck === true) sessionBackends.forgetAvailability()
    return sessionBackends.availability((id) => ({
      id,
      available: false,
      reason: startupErrors[id] ?? `${BACKEND_LABEL[id]} is not ready.`
    }))
  })
  ipcMain.handle('sessions:installTool', (_e, backend: unknown) => {
    const id = backendIdOf(backend)
    return id ? installTool(id) : null
  })
  ipcMain.handle('attention:list', () => attention.list())
  ipcMain.handle('tabs:list', (): TabInventoryReply => {
    rendererReady = true
    cronRunner?.onRendererReady()
    if (probeOnceTheRendererIsUp) {
      probeOnceTheRendererIsUp = false
      void probeAllForPanel().catch(() => {})
    }
    const activeAsleep = restoreOpenTabs()
    const active = activeAsleep ?? activeTabBeforeReload
    activeTabBeforeReload = null
    if (process.env.KOLOFT_TEST_NO_ADOPT === '1') return { tabs: [], activeTabBeforeReload: null }
    // CC§7
    const ptys = ptyMgr.list().filter((h) => !loginWatchers.has(h.id))
    const tracked = allSessions()
    const cwdByTab = new Map(tracked.map((s) => [s.tabId, s.cwd]))
    const tabs = adoptableTabs(
      ptys.map((h) => {
        const cwd = cwdByTab.get(h.id)
        if (!h.remoteHost || !cwd) return h
        return { ...h, cwd: isRemoteKey(cwd) ? cwd : formatRemoteKey(h.remoteHost, cwd) }
      }),
      tracked
    )
    // ADR-0007
    shrinkAdoptedClaudePtysOneRowSoFitRepaints(tabs)
    const asleep = [...sleepers].map(([id, t]): AdoptableTab => ({ id, ...t, asleep: true }))
    return { tabs: [...tabs, ...asleep], activeTabBeforeReload: active }
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
    rememberOpenTabs()
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
    hosts.of(workspacePath).listSkills(workspacePath)
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
    // CODEX§15 MUSE§13
    if (!SIGN_IN_FOLDER_KINDS.includes(kind)) await keychainDelete(kind, name)
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
  ipcMain.handle(
    'accounts:sign-in',
    async (_e, kind: unknown, name: string, again?: boolean): Promise<SignInResult> =>
      isSignInFolderKind(kind)
        ? signInToHome(kind, name, again === true)
        : { ok: false, error: 'invalid-name' }
  )
  ipcMain.handle('accounts:codex-use-reset', (_e, name: string) => codexUseReset(name))
  ipcMain.on('accounts:cancel-login', () => {
    for (const id of [...loginWatchers.keys()]) cancelGuidedLogin(id)
  })

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('settings:set', (_e, patch) => {
    const saved = commitSettings(sanitizeSettingsPatch(patch))
    const backend = preferredAssistBackend(saved)
    if (!conductors || saved.discord.bindings.every((b) => b.backend === backend)) return saved
    conductors.followBackend(backend)
    return loadSettings()
  })

  ipcMain.handle('assist:route', async (_e, id: unknown, message: unknown) => {
    if (typeof id !== 'number' || typeof message !== 'string' || !workspaceMgr) return null
    const mgr = workspaceMgr
    const run = new AbortController()
    assistRuns.set(id, run)
    try {
      return await routeSession(
        { rows: () => mgr.rows(), worktrees: (p) => mgr.worktrees(p), assist },
        message,
        run.signal
      )
    } finally {
      assistRuns.delete(id)
    }
  })
  ipcMain.on('assist:cancel', (_e, id: unknown) => {
    if (typeof id === 'number') assistRuns.get(id)?.abort()
  })
  const addWorkspacePath = (p: string): WorkspaceAddResult | undefined => {
    const r = workspaceMgr?.add(p)
    const remote = parseRemoteKey(p)
    if (remote && r?.code === 'added') remoteSync?.pokeNow(remote.host)
    return r
  }
  ipcMain.handle('workspace:add', (_e, p: string) => {
    const r = addWorkspacePath(p)
    if (r?.code === 'added') void gitAccounts?.autoPickNewWorkspace(p)
    return r
  })
  const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const isGitPlatform = (v: unknown): v is GitPlatform => GIT_PLATFORMS.includes(v as GitPlatform)
  ipcMain.handle('gitAccounts:list', () => gitAccounts?.views() ?? [])
  const machineOf = (v: unknown): string | undefined => (isText(v) ? v : undefined)
  ipcMain.handle(
    'gitAccounts:login-start',
    (_e, platform: unknown, url: unknown, machine: unknown) =>
      gitAccounts && isGitPlatform(platform) && typeof url === 'string'
        ? gitAccounts.loginStart(platform, url, machineOf(machine))
        : { ok: false, error: 'bad-url' }
  )
  ipcMain.on('gitAccounts:login-cancel', () => gitAccounts?.loginCancel())
  ipcMain.on('gitAccounts:login-browser', () => gitAccounts?.loginBrowser())
  ipcMain.handle('gitAccounts:add-token', (_e, add: Partial<GitTokenAdd> | undefined) =>
    gitAccounts && isGitPlatform(add?.platform) && isText(add.token) && typeof add.url === 'string'
      ? gitAccounts.addToken({
          platform: add.platform,
          url: add.url,
          token: add.token.trim(),
          ...(typeof add.username === 'string' && { username: add.username }),
          ...(machineOf(add.machine) && { machine: add.machine })
        })
      : { ok: false, error: 'rejected' }
  )
  ipcMain.handle('gitAccounts:remove', (_e, id: unknown, machine: unknown) =>
    isText(id) ? gitAccounts?.remove(id, machineOf(machine)) : undefined
  )
  ipcMain.handle('gitAccounts:make-default', (_e, id: unknown, machine: unknown) =>
    isText(id) ? gitAccounts?.makeDefault(id, machineOf(machine)) : undefined
  )
  ipcMain.handle('gitAccounts:check', () => gitAccounts?.checkAll())
  ipcMain.handle('gitAccounts:pick', (_e, wsPath: unknown, id: unknown) =>
    isText(wsPath) && (id === null || isText(id))
      ? gitAccounts?.pick(wsPath, id).then(() => void freshness?.fetchNow(wsPath))
      : undefined
  )
  ipcMain.handle('gitAccounts:suggest', (_e, wsPath: unknown, network: unknown) =>
    isText(wsPath) && gitAccounts ? gitAccounts.suggest(wsPath, network === true) : { kind: 'none' }
  )
  ipcMain.handle('gitAccounts:dismiss', (_e, wsPath: unknown) =>
    isText(wsPath) ? gitAccounts?.dismiss(wsPath) : undefined
  )
  ipcMain.handle('gitAccounts:make-ssh-key', (_e, wsPath: unknown) =>
    isText(wsPath) ? gitAccounts?.makeSshKey(wsPath) : undefined
  )
  ipcMain.handle('gitAccounts:check-ssh-key', (_e, wsPath: unknown) =>
    isText(wsPath) ? gitAccounts?.checkSshKey(wsPath) : undefined
  )
  ipcMain.handle('project:create', (_e, parent: unknown, name: unknown) =>
    typeof parent === 'string' && parent && typeof name === 'string'
      ? createProject(hosts.of(parent), parent, name, addWorkspacePath)
      : { ok: false, reason: 'Pick a folder.' }
  )
  ipcMain.handle('workspace:remove', (_e, p: string) => {
    const marked = markedSessionsOf(p)
    const r = workspaceMgr?.remove(p)
    if (r?.removed) {
      cronRunner?.removeWorkspace(p)
      conductors?.removeWorkspace(p)
      for (const id of marked) attention.clearSession(id)
    }
    return r
  })
  ipcMain.handle('workspace:removeConfirmed', async (_e, p: string) => {
    await Promise.all(
      storedSessions().flatMap((stored) => {
        const tabs = new Set(
          stored
            .rows(p)
            .filter((r) => r.running || r.pending)
            .map((r) => (r.pending ? r.id : stored.aliveTabFor(r.id)))
            .filter((id): id is string => !!id)
        )
        return [...tabs].map((id) => stored.stop(id))
      })
    )
    const marked = markedSessionsOf(p)
    workspaceMgr?.removeConfirmed(p)
    cronRunner?.removeWorkspace(p)
    conductors?.removeWorkspace(p)
    for (const id of marked) attention.clearSession(id)
  })
  ipcMain.handle('conductors:save', (_e, input: ConductorSaveInput) => {
    const channel = input?.channel
    if (
      typeof input?.scope !== 'string' ||
      !isDiscordId(channel?.guildId) ||
      !isDiscordId(channel.channelId) ||
      typeof channel.name !== 'string'
    )
      return { ok: false, error: 'Pick a channel.' }
    const { guildId, channelId, name } = channel
    const saved = conductors?.save(
      { id: input.id, scope: input.scope, channel: { guildId, channelId, name } },
      preferredAssistBackend(loadSettings())
    ) ?? { ok: false, error: STILL_STARTING }
    if (saved.ok) registerSlashCommands()
    return saved
  })
  ipcMain.handle('conductors:saveWithNewChannel', (_e, input: NewChannelInput) =>
    bindWithNewChannel({ id: input.id, scope: input.scope })
  )
  ipcMain.handle('conductors:unbind', (_e, id: string) => {
    conductors?.unbind(id)
    syncAnswerable()
  })
  ipcMain.handle(
    'conductors:open',
    (_e, scope: string) => conductors?.open(scope) ?? { ok: false, error: STILL_STARTING }
  )
  ipcMain.handle(
    'conductors:startFresh',
    (_e, scope: string) => conductors?.startFresh(scope) ?? { ok: false, error: STILL_STARTING }
  )
  ipcMain.handle('conductors:openTask', (_e, scope: string, title: string, text: string) =>
    openPaletteTask(scope, title, text)
  )
  ipcMain.handle('conductors:tell', (_e, scope: string, title: string, text: string) =>
    tellAssist(scope, title, text)
  )
  ipcMain.handle('conductors:closeTask', (_e, tabId: string) => conductors?.closeTask(tabId))
  ipcMain.handle('conductors:tasks', () => conductors?.taskRows() ?? [])
  ipcMain.handle('discord:status', () => discordLink?.status() ?? DISCORD_OFF)
  ipcMain.handle('discord:pair', (_e, isMe: unknown) => {
    const owner = discordLink?.pair(isMe === true)
    if (owner) conductors?.setOwner(owner)
  })
  ipcMain.handle('discord:channels', () => discordLink?.channels() ?? [])
  ipcMain.handle('discord:setUpWithAssist', (_e, ownerWords?: string) =>
    openDiscordSetup(ownerWords)
  )
  ipcMain.handle('workspace:move', (_e, p: string, before: string | null) =>
    workspaceMgr?.move(p, before)
  )
  ipcMain.handle('workspace:rows', async () => {
    await workspaceMgr?.firstScan
    return workspaceMgr?.rows() ?? []
  })
  ipcMain.handle('workspace:discover', () => workspaceMgr?.discover() ?? [])
  ipcMain.handle('workspace:worktrees', async (_e, p: string) => {
    const trees = (await workspaceMgr?.worktrees(p)) ?? []
    for (const stored of storedSessions()) {
      const mine = stored.store.listResources().filter((r) => r.originalCwd === p)
      const there = await Promise.all(
        mine.map((r) => r.state === 'ready' && hosts.of(r.worktreePath).dirExists(r.worktreePath))
      )
      for (const [i, resource] of mine.entries()) {
        if (there[i]) continue
        const existing = trees.find((t) => t.dir === resource.worktreePath)
        if (existing) {
          existing.recoveryResourceId = resource.id
          existing.recoveryBackend = stored.id
        } else
          trees.push({
            name: resource.worktreeName,
            dir: resource.worktreePath,
            branch: resource.worktreeBranch ?? undefined,
            recoveryResourceId: resource.id,
            recoveryBackend: stored.id
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
    return archiveSession(id)
  })

  ipcMain.on('sessions:setResident', (_e, id: unknown, on: unknown) => {
    if (typeof id !== 'string' || !id || typeof on !== 'boolean') return
    workspaceMgr?.setResident(id, on)
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

  const sessionSearch = new SessionSearch({
    candidates: () => {
      const localPins = (workspaceMgr?.pinnedPaths() ?? [])
        .map((w) => w.path)
        .filter((p) => !parseRemoteKey(p))
      return [
        ...(workspaceMgr?.searchableRows() ?? []),
        ...storedSessions().flatMap((s) => s.searchable(localPins))
      ]
    },
    backendSnippets: async (term, signal) =>
      (await Promise.all(storedSessions().map((s) => s.searchSnippets(term, signal)))).flat(),
    hidden: (id) => !!sessionBackends.conductorOf(id),
    scan: (files, term, found) => {
      // PLATFORM§4
      const worker = createTranscriptSearchWorker({ workerData: { files, term } })
      worker.on('message', (hit: { id: string; snippet: SearchSnippet }) =>
        found(hit.id, hit.snippet)
      )
      worker.on('error', (error) => console.error('[koloft] session search failed', error))
      return {
        done: new Promise((resolve) => worker.once('exit', () => resolve())),
        stop: () => void worker.terminate()
      }
    },
    send: (found) => sendToRenderer('sessions:search-hits', found)
  })
  ipcMain.on('sessions:search', (_e, searchId: unknown, term: unknown) => {
    if (typeof searchId !== 'number' || typeof term !== 'string') return
    sessionSearch.start(searchId, term)
  })

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
  ipcMain.on('browser:guest-owner', (_e, guestId: unknown, ownerTabId: unknown) => {
    if (typeof guestId !== 'number' || typeof ownerTabId !== 'string') return
    const guest = webContents.fromId(guestId)
    if (guest) guestOwners.set(guest, ownerTabId)
  })
  ipcMain.on('browser:overlay-ready', () => {
    overlayListening = true
    flushOverlayOpens()
  })
  ipcMain.on('browser:strip', (_e, sessionId: unknown, targets: unknown) => {
    if (typeof sessionId !== 'string' || !Array.isArray(targets)) return
    relayStripChanged(sessionId, targets as BrowserStripTarget[])
  })
  ipcMain.on('terminal:screen-done', (_e, answer: unknown) => {
    const a = answer as ScreenAnswer
    if (!a || typeof a.requestId !== 'string') return
    const pending = screenAsks.get(a.requestId)
    if (!pending) return
    screenAsks.delete(a.requestId)
    pending(a)
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
    typeof p === 'string' && p ? hosts.of(p).dirExistsOrThrow(p) : false
  )
  ipcMain.handle('fs:search', (_e, p: string, q: string, opts?: { showIgnored?: boolean }) =>
    hosts.of(p).search(p, q, opts)
  )
  const baseArg = sanitizeBase
  const untrackedArg = (u: unknown): boolean => u === true
  ipcMain.handle('fs:gitChanges', (_e, root: string, base?: unknown) =>
    typeof root === 'string' && root
      ? hosts.of(root).gitChanges(root, base === 'head' ? 'head' : 'merge-base')
      : { base: null, status: {}, numstat: {}, missing: false }
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
    if (typeof p === 'string' && isAbsoluteOnHost(p))
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
    return notesFileOfScope(ws) ?? null
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
    if (what !== 'repo' && what !== 'pulls' && what !== 'pr' && what !== 'compare') return null
    return hosts.of(root).github.target(root, what)
  })
  ipcMain.handle('github:checks', (_e, root: unknown, pr: unknown): Promise<PrChecks> => {
    if (typeof root !== 'string' || !root || !Number.isInteger(pr)) {
      return Promise.resolve({ state: 'failed' })
    }
    return hosts.of(root).github.checks(root, pr as number)
  })
  ipcMain.handle('github:failing-checks-text', (_e, root: unknown, pr: unknown) => {
    if (typeof root !== 'string' || !root || !Number.isInteger(pr)) return null
    return hosts.of(root).github.failingChecksText(root, pr as number)
  })
  ipcMain.handle('github:commit', (_e, root: unknown, message: unknown) => {
    if (typeof root !== 'string' || !root || typeof message !== 'string') return BAD_GIT_STEP
    const host = hosts.of(root)
    return commitAll((args, network) => host.gitRun(root, args, network), message)
  })
  ipcMain.handle('github:push', (_e, root: unknown) => {
    if (typeof root !== 'string' || !root) return BAD_GIT_STEP
    const host = hosts.of(root)
    return pushBranch((args, network) => host.gitRun(root, args, network))
  })
  ipcMain.handle('github:open-items', (_e, root: unknown) => {
    if (typeof root !== 'string' || !root) return { state: 'no-repo' }
    return hosts.of(root).github.openItems(root)
  })
  ipcMain.handle(
    'github:pr-worktree',
    async (_e, root: unknown, pr: unknown, branch: unknown): Promise<PrWorktreeResult> => {
      if (
        typeof root !== 'string' ||
        !root ||
        !Number.isInteger(pr) ||
        typeof branch !== 'string' ||
        !GIT_REF_RE.test(branch)
      ) {
        return BAD_GIT_STEP
      }
      const host = hosts.of(root)
      const r = await addPrWorktree(
        (args, network) => host.gitRun(root, args, network),
        pr as number,
        branch
      )
      if (r.ok && hostOf(root) === 'local') await copyWorktreeIncludes(root, r.dir)
      return r
    }
  )
  ipcMain.handle('preview:openFileDialog', async () => {
    const stub = process.env.KOLOFT_FILE_DIALOG_FILE
    if (stub) return takeStubbedDialogPick(stub)
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('window:isFullScreen', () => mainWindow?.isFullScreen() ?? false)

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
