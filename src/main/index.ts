import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  protocol,
  dialog,
  session,
  shell,
  powerMonitor,
  screen,
  Notification,
  webContents
} from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { pathToFileURL } from 'url'
import { anotherLiveInstanceOwns, PtyManager, type PtyHandle } from './ptyManager'
import { adoptableTabs } from './tabInventory'
import { allowCrashReload } from './crashGuard'
import { TerminalOutput } from './flowControl'
import type { CommandOutput } from '@agents/claude/main/claudeCommandOutput'
import { codexShowsAPanel } from './inputBox'
import type { TreeIo } from './sessionWorktrees'
import { sharedProcessTable, type ProcessTable } from './processTable'
import {
  agyAccountEnv,
  agyApiKeyRoute,
  agyHomeAccounts,
  endAgyOneShots,
  oneShotAgyHome,
  readAgyModels
} from '@agents/agy/main/agyAccounts'
import { ownersGeminiDir } from '@agents/agy/main/agyStore'
import { homeKeyOnDisk } from './homeKeyOnDisk'
import { watchHistoryOf } from './historyWatch'
import {
  MARK_OUTPUT_START,
  SignInOutput,
  afterOutputStart,
  outputStartCarry,
  plainTerminalTail
} from './signInOutput'
import type { SessionEvent } from '@shared/sessionEvent'
import { askWiring } from './askWiring'
import {
  OpenTabsFile,
  openTabsNow,
  readOpenTabs,
  restorePlan,
  type OpenTab,
  type OpenTabs
} from './openTabs'
import { SessionAccounts } from './sessionAccounts'
import { SavedUsage } from './savedUsage'
import { saveHomeUsage, type HomeUsage } from './savedHomeUsage'
import {
  BACKEND_LABEL,
  backendIdOf,
  capabilitiesFor,
  identityOf,
  reachedBySendMessage,
  effectiveBackend,
  turnedOffLine,
  SESSION_BACKENDS
} from '@shared/sessionBackend'
import {
  familyEfforts,
  resolveOwnPick,
  listsModels,
  needsTheAccountsModels,
  type ListedModel,
  type OwnPickResolved
} from '@shared/sessionPicks'
import { BUTLER_OFF_ITS_AGENT_LOG, butlerStart } from '@shared/butlerStart'
import { assistBackendsFor, assistLaunchOn, assistRowBackend } from '@shared/assistPicks'
import { flushAttention, loadLastRunAttention, saveAttention } from './attentionFile'
import { route, dockBadgeText } from './notifyRouter'
import { setupShim } from './shim'
import { openDropTarget, type OpenDrop } from '@core/openDrop'
import { leaveForOS, openUrlExternally, osOpenFallback } from './osOpen'
import { enforceGuestAttach, isAppNavigation } from './browserSecurity'
import { stripTerminalCodes } from '@core/terminalCodes'
import type { InstructionsVersion } from '@core/ownerInstructions'
import { formatRemoteKey, isRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import {
  defaultControlDir,
  ensureControlDir,
  rsyncPull,
  listenOverSsh,
  masterCommandOutlivingKoloft,
  runMasterCommand,
  runSsh,
  runSshBytes,
  problemOf,
  sshOptions
} from './remote/ssh'
import { sessionMessaging } from './sessionMessaging'
import { BrowserTunnels } from './remote/browserTunnel'
import { anyFreeMacPort, macPortFree, PageForwards } from './remote/portForward'
import { remoteAnswerCommand, remoteShCommand } from './remote/install'
import { codexMachineInstance } from '@agents/codex/main/codexMachine'
import {
  buildMachinePackage,
  POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE,
  tmuxSessionName,
  utilShellLine,
  writeTabPassFile,
  CLAUDE_AUTH_ENV_VARS,
  claudeCodeGuessesWindowOf,
  type MachinePackage
} from './remote/launch'
import {
  browserForwardFile,
  machinePackageBase,
  pageForwardsFile,
  mirrorAgyGemini,
  mirrorHookDir,
  mirrorProjectsRoot,
  remoteShellPidFile,
  tabPackageDir
} from './remote/paths'
import { RemoteSync } from './remote/sync'
import { machineUsageDirs } from './remote/usageMirror'
import { syncMirrorsOf } from './remote/syncMirrors'
import { machinePackageFiles } from './remote/machinePackageFiles'
import { OWNER_TYPES_A_SECRET_WITHIN_MS } from './agentShim'
import { passwordsOn } from '@plugins/passwords/api'
import { agentsInLoginShell, sshEnvFromLogin } from './loginShell'
import { oncePerName, watchAndSweepJsonDrops, writeWholeBeforeVisible } from './jsonDrops'
import { setupStatusline, setupAgyStatusline, statusLineSetting } from './statusline'
import { setupPlaywrightCli } from './playwrightCli'
import {
  bundledGcm,
  bundledGhDir,
  linkOrUnlink,
  setupBundledGit,
  stepAsideForTheUsersGit
} from './bundledTools'
import {
  setFindAvailable,
  setKeepAwakeChecked,
  setSaveAvailable,
  setupAppMenu,
  setWorkbenchAvailable,
  type MenuShortcut
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
import { flushSettings, loadSettings, onSwitchesChanged, saveSettings } from './settings'
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
  allLimitedNotice,
  type PickResponse
} from './accountPicker'
import { flushLayout, loadLayout, saveLayout } from './layout'
import { ensureNotesFile, notesBaseDir } from './notes'
import { rowsToAdopt } from '@shared/firstRun'
import {
  isWorkspaceWorkbenchKey,
  sanitizeSessionWorkbench,
  WORKSPACE_WORKBENCH_STARTS_OPEN_WHATEVER_THE_SESSION_DEFAULT
} from '@shared/workbenchState'
import {
  dirExistsSync,
  gitProbes,
  worktreeHomeRoot,
  worktreeNameAround,
  type ResumeProbes
} from './resumePlan'
import { branchExists, type GitOut, type TidyResult } from '@core/worktree'
import { codexConfigFile } from '@agents/codex/main/codexTrust'
import {
  codexHomeAccounts,
  codexHomeOf,
  codexHomes,
  prepareCodexHome
} from '@agents/codex/main/codexAccounts'
import { shq } from '@shared/shellQuote'
import { ResourceGuard, ownerTyped } from './resourceGuard'
import { readTheMachine, signalLog } from './machineRoom'
import { STUCK_AFTER_MS, StallWatchWhileFocused, answerTheStuckWatch } from './mainThreadStalls'
import createMainThreadStuckWorker from './mainThreadStuckWorker?nodeWorker'
import { giveWay, readTaggedTable } from './machineTrees'
import { isRunFolderOf, worktreeHomeOf } from '@shared/cronNames'
import { GitFreshnessEngine } from './gitFreshness'
import { COMMON_GIT_DIR, GitRepoKeys } from './gitRepoKey'
import { GithubRepos, parseGithubFixture, type GithubReposOptions } from './githubRepos'
import { ghRead, runGh } from './ghRun'
import { GitAccountService, newGitRequestDir, sweepStaleGitRequestDirs } from './gitAccountService'
import { removeStaleLoginDirs } from './githubLogin'
import { addPrWorktree, commitAll, GIT_REF_RE, pushBranch, readReadiness } from './gitSteps'
import { restoredWindowGeometry, trackWindowState } from './windowState'
import { fullscreenOption, usableSessionScreen, windowMinWidth } from './windowBounds'
import { closeAllFileWatchers, closeAllDirWatchers } from './fileWatch'
import { sanitizeBase } from './gitStatus'
import { Hosts } from './host/hosts'
import { localGitOut, localHost } from './host/localHost'
import { SIGN_IN_THROUGH_A_TAB_THAT_CAN_ASK_FIRST, SshHost } from './host/sshHost'
import { isGitCheckoutAsync, projectInfoFor, realpathSafe } from './projectInfo'
import { checkForUpdates, downloadAndInstall, releasePageUrl, restartApp } from './updater'
import { currentOffer, startUpdateNotifier } from './updateNotifier'
import { extOf } from '@shared/preview'
import { busyInCheckout } from '@shared/freshnessOps'
import {
  aPageOnTheMachineAsks,
  loopbackPortOf,
  MACHINE_PAGE_SCHEME,
  machinePageOf,
  onMacPort,
  PREVIEW_FILE_SCHEME,
  previewFileOf,
  webPageReachesDiscordDesktopApp,
  routeFor,
  schemeOf,
  type RouteDecision,
  type RouteSource
} from '@shared/browserRoute'
import { PASTED_PICTURE_EXTENSIONS, pastedPicturesIn, withPictures } from '@shared/pastedPictures'
import { sanitizeSettingsPatch } from '@shared/settingsOps'
import { pidAlive, scanLeftovers, stopLeftover } from './leftovers'
import { parseSessionPorts, scanPortsHere, scanPortsOnMachine } from './sessionPorts'
import { reachesThisMacsServer } from '@core/thisMacsServers'
import { mapAtMost } from '@core/mapAtMost'
import { SessionSearch } from './sessionSearch'
import createTranscriptSearchWorker from './transcriptSearchWorker?nodeWorker'
import createUsageScanWorker from './usageScanWorker?nodeWorker'
import { UsageCache, listUsageFiles, statOf, type ScannedFile } from './usageCache'
import { applyWindowCommand } from '@shared/shortcutDispatch'
import {
  attentionReason,
  BROWSER_PARTITION,
  PLACEHOLDER_SESSION_TITLE,
  PLACEHOLDER_TITLES,
  exitedAbnormally,
  GIT_PLATFORMS,
  isHttpUrl,
  keychainNamespace,
  keepsSecretInKeychain,
  takesAnEndpoint,
  BACKEND_OF_SIGN_IN_FOLDER,
  isSignInFolderKind,
  type SignInFolderKind,
  type GitPlatform,
  type GitTokenAdd
} from '@shared/types'
import {
  ACCOUNT_KINDS_OF,
  launchUsageProbe,
  noAccountLine,
  noAccountMessage,
  SHIM_FOUND_NO_ACCOUNT_EXIT,
  type LaunchUsageProbe
} from '@shared/accountUsage'
import type {
  AccountAddResult,
  AccountKind,
  ListeningPort,
  AccountMeta,
  AccountView,
  ArtifactView,
  BackendId,
  SignInResult,
  SignInFailure,
  ScreenAnswer,
  ScreenRequest,
  TerminalExit,
  UnexpectedExitScreen,
  BrowserOpenRequest,
  LoginProgress,
  CreateTabOptions,
  CreateTabResult,
  ConductorOpenResult,
  PaletteRequest,
  LeftoverProcess,
  ProjectInfo,
  SessionInfo,
  BackendAvailability,
  AttentionEvent,
  OsOutletsSeenByTests,
  AttentionSubject,
  SessionRow,
  WorkspaceRows,
  SearchSnippet,
  SpawnedTab,
  AdoptableTab,
  TabInventoryReply,
  OpenRequest,
  WindowCommand,
  Settings,
  HostId,
  WorkspaceAddResult
} from '@shared/types'
import { copyWorktreeIncludes } from './sessionWorktrees'
import { AgentRequests, tabSpokenFor } from './agentRequests'
import { errorText } from '@core/errorText'
import { projectRulesForTheButler } from '@shared/agentGuide'
import {
  asPeerName,
  butlersBlock,
  butlersFolderClaim,
  butlersWords,
  conductorFolder,
  DIGEST_GATHERS_MS,
  GUIDE_MOVED_NEWS,
  helperRoleOf,
  pluginsChangedNews,
  THIS_MAC
} from '@plugins/butler/api'
import { switchesThatAct } from '@core/switches'
import { cronPickFor, takesOwnDefaults } from '@shared/sessionDefaults'
import type { OwnPick } from '@shared/types'
import { projectDefaults } from './projectDefaults'
import type { WebPage } from '@core/webPage'
import { within } from '@core/within'
import { clicksTheMouse, pressesAKey, typeKeys } from '@core/typeKeys'
import { CH, type Channel } from '@shared/ipcChannels'
import { sleep } from '@core/sleep'
import { claudeJsonPath, claudeProjectKey } from '@agents/claude/main/claudeTrust'
import {
  AGY_PROJECT_MCP_FILE,
  PROJECT_MCP_FILE,
  claudeServers,
  codexServers,
  foldersUpToRepoTop,
  foldersUpToRoot,
  jsonServers,
  ownersClaudePlaywrightMcp,
  textOrNull,
  type ConfigText
} from './mcpServers'
import type { McpServer } from '@shared/types'
import {
  LIVE_REGISTRY_ON_A_MACHINE_SH,
  claudeShowsAPanel,
  claudeShowsAPanelOnMachine,
  whenMessagingSocket,
  whenMessagingSocketOnMachine
} from '@agents/claude/main/claudeSessionRegistry'
import { GLOBAL_SCOPE, scopeName } from '@shared/scope'
import { Commands } from '@core/commands'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_STARTS, type PluginStartDeps, type PluginsStarted } from '@plugins/starts'
import { startPlugins } from '@core/pluginStart'
import {
  FILE_OPENED,
  Moments,
  QUESTION_ASKED,
  SESSION_BOUND,
  SESSION_STARTED,
  SESSION_STARTING,
  STATE_CHANGED,
  TOOL_DONE,
  TURN_ENDED,
  TURN_OVER,
  ATTENTION_CHANGED,
  DIALOG_CLOSED,
  TURN_STARTED,
  type LeftTab,
  type Moment,
  type StateChanged,
  type TabEnded,
  type TurnOver
} from '@core/moment'
import type { MainIpc } from '@core/ipc'
import type { WorktreeResource } from '@core/agent/worktreeRecords'
import { ClaudeDialogWatch } from '@agents/claude/main/claudeDialogWatch'
import { docsWritingOn } from '@plugins/docs-writing/api'
import { koloftPrompt, type SessionsWithStore } from '@plugins/sessions/api'
import { localFile } from './realFiles'
import { isHandsOn, OwnerPresence, type OwnerWhere } from '@core/presence'
import { koloftAssist } from './assist'
import { AgentsMain, type AgentMain, type OneShotTarget } from '@core/agent/agentsMain'
import { createProject } from './newProject'
import { routeSession } from './sessionRouter'
import { TreeRemovals } from './treeRemovals'
import {
  finishAfterKoloftQuits,
  WorktreeRemovalWatch
} from '@agents/claude/main/claudeWorktreeExit'
import { discordTokenRead, discordTokenWrite } from './accounts'
import { checkSkillsAgain, pluginSkills, writeAgentPlugin, writeDocsPlugin } from './agentPlugin'
import { installThen, pathWithDirFirst, pathWithDirLast, pathWithInstallDir } from './toolInstall'

type SessionsStarted = PluginsStarted['sessions']
type SessionVerbDeps = PluginStartDeps['sessions']['session']
type ClosableSession = ReturnType<SessionVerbDeps['closable']>[number]
type Target = Parameters<SessionVerbDeps['command']>[1]
type SessionScreen = Awaited<ReturnType<SessionVerbDeps['screen']>>
type HelperTask = Parameters<SessionsStarted['sessionCommand']['startHelper']>[1]
type SlashTarget = Parameters<SessionsStarted['slash']['typeWhenIdle']>[0]
type SlashReplyTo = Parameters<SessionsStarted['slash']['typeWhenIdle']>[2]
type Recipient = Parameters<ReturnType<SessionsStarted['buildHandOver']>['tell']>[0]
type MergedHeads = NonNullable<Parameters<SessionsStarted['whatIsLeft']>[2]>
type NoticeFile = ReturnType<SessionsStarted['localNotice']>
type SyncSession = Parameters<SessionsStarted['sessionSync']['observe']>[0][number]
type ToolCall = Parameters<SessionsStarted['isAskedCall']>[1]

const pluginIpc: MainIpc = {
  handle: (channel, handler) =>
    ipcMain.handle(channel, (_e, ...args) => handler(...(args as Parameters<typeof handler>))),
  on: (channel, listener) =>
    ipcMain.on(channel, (_e, ...args) => listener(...(args as Parameters<typeof listener>))),
  onEvent: (channel, listener) => ipcMain.on(channel, listener),
  push: (channel, ...args) => sendToRenderer(channel as Channel, ...args)
}

// PLATFORM§4
if (!app.isPackaged) app.setName('koloft-dev')

const BACKGROUND_TEST = process.env.KOLOFT_TEST_BACKGROUND === '1'
const OFF_SCREEN_TEST = BACKGROUND_TEST && process.env.KOLOFT_TEST_REAL_WINDOW !== '1'
// PLATFORM§4
if (OFF_SCREEN_TEST && process.platform === 'darwin') {
  app.setActivationPolicy('accessory')
  app.dock?.hide()
}

const AN_ERROR_NOBODY_CAUGHT_IS_SHOWN_AT_MOST_EVERY_MS = 60_000
const MAIN_ERRORS_LOG = 'main-errors.log'

// PLATFORM§4
function takeErrorsNobodyCaught(): void {
  const log = signalLog(path.join(app.getPath('userData'), MAIN_ERRORS_LOG))
  let shownAt = -Infinity
  process.on('uncaughtException', (error) => {
    console.error(error)
    const message = error instanceof Error ? error.message : String(error)
    const [firstLine] = message.split('\n')
    log(error instanceof Error && error.stack ? error.stack : message)
    if (Date.now() - shownAt < AN_ERROR_NOBODY_CAUGHT_IS_SHOWN_AT_MOST_EVERY_MS) return
    const shown = sendToRenderer(
      CH.toast.show,
      `Koloft hit an error it did not expect and kept going (details in ${MAIN_ERRORS_LOG}, in its data folder): ${firstLine}`
    )
    if (shown) shownAt = Date.now()
  })
  process.on('unhandledRejection', (reason) => {
    console.error(reason)
    log(
      `a promise nobody handled was rejected: ${reason instanceof Error && reason.stack ? reason.stack : String(reason)}`
    )
  })
}

const moments = new Moments(PLUGINS)
const throwAsIfNobodyCaughtIt = (error: unknown): void =>
  queueMicrotask(() => {
    throw error
  })
const announceNow = <T>(moment: Moment<T>, m: T): void =>
  void moments.announce(moment, m).catch(throwAsIfNobodyCaughtIt)

const ptyMgr = new PtyManager()
const terminalOutput = new TerminalOutput({
  pause: (id) => ptyMgr.pause(id),
  resume: (id) => ptyMgr.resume(id),
  send: (id, data) => sendToRenderer(CH.terminal.data, { id, data }),
  rendererUp: () => rendererReady,
  now: () => performance.now()
})
const runtimeDeps: PluginStartDeps['sessions']['runtime'] = {}
const trackerDeps: PluginStartDeps['sessions']['tracker'] = {}
const {
  claudeAsked,
  forgetClaudeAsk,
  claudeAskOf,
  endsTheAsk: claudeToolEndsTheAsk,
  askingOf,
  pendingAskOf,
  ownerAsleepAsked,
  dialogOf
} = askWiring({
  runtime: () => runtime,
  storedOwnerOf,
  sessionAsks: () => sessionAsks,
  readers: () => ({ claudeDialog, codexDialog, questionsOf, isAskedCall }),
  questionAsked: (asked) => announceNow(QUESTION_ASKED, asked)
})
let codexSessions: ReturnType<typeof buildCodexSessions> | null = null
let agySessions: ReturnType<typeof buildAgySessions> | null = null
const startupErrors: Partial<Record<BackendId, string>> = {}

function storedSessions(): SessionsWithStore[] {
  return [codexSessions, agySessions].filter((s): s is NonNullable<typeof s> => !!s)
}
function storedOwnerOf(tabId: string): SessionsWithStore | undefined {
  return storedSessions().find((s) => s.hasTab(tabId))
}
const startedSessionsFile = (): string =>
  path.join(app.getPath('userData'), 'started-sessions.json')
const workbenchReaderDocs: PluginStartDeps['workbench']['readerDocs'] = {
  file: () => path.join(app.getPath('userData'), 'doc-verdicts.json'),
  assist: (job) => assist(job),
  session: sessionOfTab,
  remoteFileExists: (host, keyed) => hosts.machine(host).fileExists(keyed),
  localFile,
  changed: () => pushToSessions.sessions(onSessionsChanged())
}
const sessionsEndedThisRun = new Set<string>()
const backendLifecycle: PluginStartDeps['sessions']['backendLifecycle'] = {
  turnEnded: (tabId, turn) => announceNow(TURN_ENDED, { tabId, turn }),
  prompted: (tabId) => {
    forgetClaudeAsk(tabId)
    consumeOutletDedupe(tabId)
    announceNow(TURN_STARTED, tabId)
  },
  bound: (tabId, key, idleCompaction) => {
    forgetClaudeAsk(tabId)
    const session = sessionOfTab(tabId)
    if (session) sessionAccounts?.note([session])
    if (!idleCompaction) attention.bound(tabId, key)
    announceNow(SESSION_BOUND, { tabId, key, idleCompaction })
    startedSessions.bound(tabId, key)
    ptyMgr.agentBound(tabId)
    ptyMgr.wakeReady(tabId)
  },
  exited: (tabId, subject) => {
    if (subject.sessionId) sessionsEndedThisRun.add(subject.sessionId)
    attention.onExited(tabId, subject)
  },
  asked: claudeAsked,
  clearAttention: (tabId) => attention.clear(tabId),
  open: (tabId, target) => {
    if (path.isAbsolute(target) && !fs.existsSync(target)) return
    openInWorkbench(tabId, routeFor(target, 'agent'), 'agent', target)
  }
}
const backendHooks: PluginStartDeps['sessions']['backendHooks'] = {}
backendHooks.isKoloftsOwnSession = (id) => !!butler?.isButlerSession(id)
backendHooks.turnOver = (tabId) => runtime.turnOver(tabId)
backendHooks.askingOf = askingOf
function showAskOnItsRow(tabId: string): void {
  if (runtime.statusOf(tabId) === 'approval') pushToSessions.sessions(onSessionsChanged())
}
backendHooks.verdictsOnFilesOf = (sessionId) => readerDocs.of(sessionId)
const noAccountNow = (backend: BackendId): string => noAccountMessage(listAccounts(), backend)
backendHooks.noAccountMessage = noAccountNow
backendHooks.turnedOff = turnedOffNow
function allSessions(): SessionInfo[] {
  return sessionBackends.list()
}

const newsJudgeDeps: PluginStartDeps['sessions']['newsJudge'] = {
  judge: (turn) => judgeTurn(assist, turn),
  awaitingVerdict: (tabId) => attention.awaitingVerdict(tabId),
  markFyi: (tabId) => attention.markFyi(tabId),
  onVerdict: (tabId, verdict) => koloftInbox.judged(tabId, verdict)
}

// CC§14
function asksTheOwner(tabId: string): boolean {
  return runtime.statusOf(tabId) === 'approval' || !!sessionAsks?.dialogOpen(tabId)
}

type PanelOpen = (
  tabId: string,
  sessionId: string,
  screen?: string[]
) => Promise<boolean | undefined>

function panelOnScreen(shows: (lines: string[]) => boolean | undefined): PanelOpen {
  return async (tabId, _sessionId, screen) => {
    const lines = screen ?? (await screenLines(tabId))
    const somethingDrawn = lines?.some((line) => line.trim())
    return lines && somethingDrawn ? shows(lines) : undefined
  }
}

const panelOpenOn: Record<BackendId, PanelOpen> = {
  claude: async (tabId, sessionId) => {
    if (!sessionId) return undefined
    const host = tracker.remoteOf(tabId)?.host
    if (!host) return claudeShowsAPanel(sessionId)
    const registry = await liveClaudeRegistryOn(host).catch(() => undefined)
    return registry === undefined ? undefined : claudeShowsAPanelOnMachine(registry, sessionId)
  },
  codex: panelOnScreen(codexShowsAPanel),
  agy: async () => undefined
}

const slashDeps: PluginStartDeps['sessions']['slash'] = {
  backendOf: (tabId) => backendIdOf(ptyMgr.get(tabId)?.kind),
  keyOf: (tabId) => sessionOfTab(tabId)?.sessionId || undefined,
  turnOver: (tabId) => runtime.turnOver(tabId),
  asking: asksTheOwner,
  takesTyping: (tabId) => !!sessionAsks?.takesCommand(tabId),
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
  typeNow: async (tabId, keys) => {
    await typeKeys((data) => ptyMgr.write(tabId, data), keys)
  },
  // AGY§23
  outputOnlyOnScreen: (tabId) =>
    backendIdOf(ptyMgr.get(tabId)?.kind) === 'agy'
      ? screenOf(tabId).then((s) => ('lines' in s ? s.lines.join('\n').trim() : '') || undefined)
      : undefined
}
trackerDeps.pidOf = (tabId) => ptyMgr.pidOf(tabId)
const dirtyTabIds = new Set<string>()
runtimeDeps.activeTabId = () => uiActiveTabId
runtimeDeps.heldTabs = () => {
  const held = new Set(dirtyTabIds)
  for (const h of ptyMgr.list()) if (h.util && h.alive && h.ownerTabId) held.add(h.ownerTabId)
  for (const s of allSessions())
    if (
      discordBinding?.channelOfTab(s.tabId) ||
      roomOfTab(s.tabId) ||
      workspaceMgr?.isResident(s.sessionId) ||
      cronRunner?.holdsOpenRunThatClosesItself(s.tabId)
    )
      held.add(s.tabId)
  return held
}
runtimeDeps.needsUser = (id) => attention.waitsOnApproval(id)
let leftovers: Record<string, LeftoverProcess[]> = {}
trackerDeps.leftBehind = (sessionId) => !!leftovers[sessionId]?.length
const LEFTOVER_SCAN_MS = 30_000
const LEFTOVERS_OF_A_CLOSED_SESSION_STOPPED_FOR_MS = 2 * LEFTOVER_SCAN_MS
const closedSessionsStoppedUntil = new Map<string, number>()
async function stopLeftoversOfClosedSessions(
  found: Record<string, LeftoverProcess[]>
): Promise<void> {
  const now = Date.now()
  for (const [sessionId, until] of closedSessionsStoppedUntil) {
    if (until < now) closedSessionsStoppedUntil.delete(sessionId)
    else if (found[sessionId]) {
      const stopped = await Promise.all(found[sessionId].map((p) => stopLeftover(sessionId, p.pid)))
      found[sessionId] = found[sessionId].filter((_, i) => !stopped[i])
      if (!found[sessionId].length) delete found[sessionId]
    }
  }
}
let leftoverScans: Promise<void> = Promise.resolve()
function refreshLeftovers(
  table: () => Promise<ProcessTable | null> = () => sharedProcessTable.eachRound(LEFTOVER_SCAN_MS)
): Promise<void> {
  leftoverScans = leftoverScans
    .then(async () => {
      const next = await scanLeftovers(await table())
      await stopLeftoversOfClosedSessions(next)
      const changed = JSON.stringify(next) !== JSON.stringify(leftovers)
      leftovers = next
      if (changed) pushToSessions.leftovers(next)
    })
    .catch(() => undefined)
  return leftoverScans
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
const closedTabs = new Map<string, LeftTab | null>()
const treeRemovals = new TreeRemovals()

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
  const removalOutlivesKoloftsQuit = hostOfTab(tabId) === 'ssh'
  exit.leaving = {
    sessionId: session?.sessionId,
    ...(!removalOutlivesKoloftsQuit && {
      claudePid: ptyMgr.pidOf(tabId),
      treeRoot: session?.treeRoot
    })
  }
  if (session?.sessionId) claudeStore?.leavingWorktree(session.sessionId, tabId)
  sendToRenderer(CH.tab.killedByMain, tabId)
}

const attentionDeps: PluginStartDeps['sessions']['attention'] = {
  onChange: (pending, event) => {
    if (!quitCommitted) saveAttention(pending)
    updateDockBadge(pending)
    pushToSessions.attention(pending)
    retractStaleOsNotifications(pending)
    if (event) routeAttentionEvent(event)
    announceNow(ATTENTION_CHANGED, pending)
  },
  lastRun: loadLastRunAttention(),
  asleep: (tabId) => sleepers.has(tabId),
  watching: () => (windowFocused() ? uiActiveTabId : null),
  turnDone: (tabId) => newsJudge.marked(tabId),
  // ADR-0039
  outlivesKoloft: (tabId) => !!remoteHostOfTab(tabId),
  waitsOnAnother: (tabId) => {
    const me = sessionOfTab(tabId)
    return (
      !!me?.sessionId &&
      waitsOnOtherWork(
        me,
        allSessions(),
        (id) => startedSessions.parentOfRow(id),
        (id) => sessionCommand.waitsOnAnother(id)
      )
    )
  }
}
let uiActiveTabId: string | null = null
let lastTabTheOwnerLookedAt: string | null = null
let activeTabBeforeReload: string | null = null
function sessionOfTab(tabId: string): SessionInfo | undefined {
  return allSessions().find((s) => s.tabId === tabId)
}
function sidebarTitle(s: SessionInfo): string | undefined {
  return shownTitle(s.title)
}
function shownTitle(title: string | undefined): string | undefined {
  return title && !Object.values(PLACEHOLDER_TITLES).includes(title) ? title : undefined
}

const sleepersDeps: PluginStartDeps['sessions']['sleepers'] = {
  write: (tabId, data) => ptyMgr.write(tabId, data),
  ready: (tabId) => tabReady(tabId, RESUMED_TAB_READY_MS, false),
  type: (tabId, keys) => void ptyMgr.type(tabId, keys)
}
let openTabsRestoreStarted = false
let openTabsFile: OpenTabsFile | undefined
let sessionAccounts: SessionAccounts | undefined
let savedOpenTabs: OpenTabs = { tabs: [] }
let openTabsRestored = false
const RESUMED_TAB_READY_MS = 30_000
const TAB_IDS_KEPT_PER_TAB = 8
const earlierTabIds = new Map<string, string[]>()

const tabIdsOf = (tabId: string): string[] =>
  [tabId, ...(earlierTabIds.get(tabId) ?? sleepers.get(tabId)?.tabIds ?? [])].slice(
    0,
    TAB_IDS_KEPT_PER_TAB
  )

function carryTabIds(newId: string, ids: string[]): void {
  const merged = new Set([...(earlierTabIds.get(newId) ?? []), ...ids])
  merged.delete(newId)
  earlierTabIds.set(newId, [...merged].slice(0, TAB_IDS_KEPT_PER_TAB - 1))
}

function openTabOf(s: SessionInfo): OpenTab {
  return {
    sessionId: s.sessionId,
    kind: s.backendId,
    title: sidebarTitle(s) ?? s.title,
    cwd: s.remote ? formatRemoteKey(s.remote.host, s.cwd) : s.cwd,
    tabIds: tabIdsOf(s.tabId)
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
      cwd: h.remoteHost ? formatRemoteKey(h.remoteHost, h.cwd) : h.cwd,
      tabIds: tabIdsOf(h.id)
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

function sleepTab(tabId: string): void {
  const s = sessionOfTab(tabId)
  if (!s?.sessionId) return killTabFromMain(tabId)
  sleepers.add(tabId, openTabOf(s))
  sendToRenderer(CH.tab.slept, tabId)
  void stopTabProcess(tabId)
  tabLifecycle.emit('slept')
  rememberOpenTabs()
}

function forgetSleeper(tabId: string): void {
  sleepers.forget(tabId)
  attention.clearKeepingExit(tabId)
  sendToRenderer(CH.tab.killedByMain, tabId)
  tabLifecycle.emit('forgotten', tabId)
  rememberOpenTabs()
}

function settleWokenSleepers(all: SessionInfo[]): void {
  const woken = sleepers.settle(all)
  for (const { oldId, newId, tab } of woken) {
    attention.rehome(oldId, newId)
    if (tab.tabIds) carryTabIds(newId, tab.tabIds)
  }
  if (woken.length) tabLifecycle.emit('woken')
}

async function discordShownName(s: SessionInfo | undefined): Promise<string | null> {
  const title = s && sidebarTitle(s)
  if (title) return title
  return s?.sessionId ? sessionBackends.peerNames()(s) : null
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
const presence = new OwnerPresence({
  now: Date.now,
  macIdleSeconds: () => powerMonitor.getSystemIdleTime(),
  asleepSince: loadSettings().ownerAsleepSince,
  wake: () => commitSettings({ ownerAsleepSince: null }),
  awayForTests: () => {
    const pretend = process.env.KOLOFT_TEST_PRESENCE_FILE
    if (pretend)
      return !fs.existsSync(pretend) || fs.readFileSync(pretend, 'utf8').trim() !== 'active'
    return BACKGROUND_TEST || undefined
  }
})
const AWAY_CHECKED_EVERY_MS = 30_000
function handsOnKoloft(_e: unknown, input: { type: string }): void {
  if (isHandsOn(input.type)) presence.handsOn()
}
const ownerAsleepDeps: PluginStartDeps['butler']['ownerAsleep'] = {
  presence,
  machines: () => [
    THIS_MAC,
    ...new Set([
      ...ptyMgr.list().flatMap((h) => (h.alive && h.remoteHost ? [h.remoteHost] : [])),
      ...(codexSessions?.machinesWithTabs() ?? [])
    ])
  ],
  mark: async (machine, awakeTabs) => {
    if (machine !== THIS_MAC) return hosts.machine(machine).markOwnerAsleep(awakeTabs)
    if (hookRegDir) markOwnerAsleep(hookRegDir, awakeTabs)
    return !!hookRegDir
  },
  awakeTabs: () => {
    const tab = butler?.liveTab()
    return tab ? [tab] : []
  },
  tabs: agentTabIds,
  asked: ownerAsleepAsked,
  answer: (tabId, reply) => answerSession(tabId, reply, true),
  titleOf: (tabId) => sessionOfTab(tabId)?.title ?? 'A session',
  changedSince: (since) => awayDigest?.changedSince(since) ?? [],
  report: (text) => void handOver?.tell(butlerRecipient(), text),
  now: Date.now,
  answeredFile: path.join(app.getPath('userData'), 'owner-asleep-answers.json')
}

function ownerCameBack(): void {
  presence.ownerWrote()
}

function ownerAway(): boolean {
  return presence.away()
}

function windowFocused(): boolean {
  try {
    return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()
  } catch {
    return false
  }
}

function projectFolderName(event: AttentionEvent): string | undefined {
  const root =
    sessionOfTab(event.tabId)?.treeRoot ??
    (event.sessionId ? workspaceMgr?.workspaceOf(event.sessionId) : undefined)
  return root ? path.basename(root) : undefined
}

const osOutletsSeenByTests: OsOutletsSeenByTests = {
  notifications: [],
  inNotificationCenter: [],
  dockBadge: '',
  windowHidden: false
}
;(globalThis as { __koloftOsOutlets?: OsOutletsSeenByTests }).__koloftOsOutlets =
  osOutletsSeenByTests

function updateDockBadge(pending: AttentionEvent[]): void {
  if (process.platform !== 'darwin') return
  const text = dockBadgeText(pending.length, loadSettings().dockBadge)
  if (OFF_SCREEN_TEST) osOutletsSeenByTests.dockBadge = text
  else app.dock?.setBadge(text)
}

let hiddenByClose = false
let hiddenFromFullScreen = false

function setHiddenByClose(hidden: boolean): void {
  hiddenByClose = hidden
  osOutletsSeenByTests.windowHidden = hidden
}

function hideMainWindow(win: BrowserWindow): void {
  setHiddenByClose(true)
  pageTools.windowHidden()
  if (OFF_SCREEN_TEST) return
  // PLATFORM§5
  if (win.isFullScreen()) {
    hiddenFromFullScreen = true
    win.once('leave-full-screen', () => {
      if (hiddenByClose) return win.hide()
      hiddenFromFullScreen = false
      win.setFullScreen(true)
    })
    win.setFullScreen(false)
  } else win.hide()
}

function showMainWindow(win: BrowserWindow): void {
  setHiddenByClose(false)
  pageTools.windowShown()
  if (OFF_SCREEN_TEST) return
  if (win.isMinimized()) win.restore()
  if (win.isVisible()) return
  win.show()
  if (hiddenFromFullScreen) win.setFullScreen(true)
  hiddenFromFullScreen = false
}

function activateTabFromNotification(tabId: string): void {
  const win = mainWindow
  if (win && !win.isDestroyed()) {
    uiActiveTabId = tabId
    runtime.noteActivity(tabId)
    showMainWindow(win)
    win.focus()
    app.focus({ steal: true })
    pushToSessions.activateTab(tabId)
    return
  }
  createWindow()
  app.focus({ steal: true })
}

interface OsNotification {
  show(): void
  close(): void
  on(event: 'click', listener: () => void): unknown
}

// PLATFORM§4
const osNotifications = new Map<string, OsNotification>()

function withdrawOsNotification(tabId: string): void {
  const n = osNotifications.get(tabId)
  osNotifications.delete(tabId)
  try {
    n?.close()
  } catch {}
}

function retractStaleOsNotifications(pending: AttentionEvent[]): void {
  for (const tabId of osNotifications.keys())
    if (!pending.some((ev) => ev.tabId === tabId)) withdrawOsNotification(tabId)
}

function ownerSees(tabId: string): void {
  attention.seen(tabId)
  withdrawOsNotification(tabId)
}

function osNotificationText(event: AttentionEvent): { title: string; body: string } {
  const reason = attentionReason(event)
  const folder = projectFolderName(event)
  return {
    title: event.title || PLACEHOLDER_SESSION_TITLE,
    body: folder ? `${reason} · ${folder}` : reason
  }
}

class NotificationSeenByTests implements OsNotification {
  constructor(private readonly text: { title: string; body: string }) {}

  show(): void {
    osOutletsSeenByTests.notifications.push(this.text)
    osOutletsSeenByTests.inNotificationCenter.push(this.text)
  }

  // PLATFORM§4
  close(): void {
    osOutletsSeenByTests.inNotificationCenter = osOutletsSeenByTests.inNotificationCenter.filter(
      (t) => t !== this.text
    )
  }

  on(): this {
    return this
  }
}

function osNotification(text: { title: string; body: string }): OsNotification | null {
  if (OFF_SCREEN_TEST) return new NotificationSeenByTests(text)
  return Notification.isSupported() ? new Notification(text) : null
}

function showOsNotification(event: AttentionEvent): void {
  const n = osNotification(osNotificationText(event))
  if (!n) return
  n.on('click', () => {
    osNotifications.delete(event.tabId)
    activateTabFromNotification(event.tabId)
  })
  withdrawOsNotification(event.tabId)
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
  const decision = route(event, windowFocused(), loadSettings(), uiActiveTabId)
  if (!decision.os && !decision.sound) return
  const outletKey = `${event.tabId}:${event.kind}`
  const lastAt = recentOutlets.get(outletKey)
  const now = Date.now()
  if (lastAt !== undefined && now - lastAt < OUTLET_FLAP_DEDUPE_MS) return
  recentOutlets.set(outletKey, now)
  if (decision.os) showOsNotification(event)
  if (decision.sound && !BACKGROUND_TEST) shell.beep()
}
let mainWindow: BrowserWindow | null = null

// PLATFORM§5
function sendToRenderer(channel: Channel, ...args: unknown[]): boolean {
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

const MENU_SHORTCUT_CHANNEL: {
  [K in Exclude<MenuShortcut, 'toggle-keep-awake'>]: `shortcut:${K}`
} = {
  'new-session': CH.shortcut.newSession,
  'new-worktree-session': CH.shortcut.newWorktreeSession,
  'close-tab': CH.shortcut.closeTab,
  'close-session': CH.shortcut.closeSession,
  find: CH.shortcut.find,
  'find-files': CH.shortcut.findFiles,
  'check-update': CH.shortcut.checkUpdate,
  'restart-session': CH.shortcut.restartSession,
  'add-workspace': CH.shortcut.addWorkspace,
  'new-terminal-tab': CH.shortcut.newTerminalTab,
  save: CH.shortcut.save,
  'focus-notes': CH.shortcut.focusNotes,
  'next-waiting-session': CH.shortcut.nextWaitingSession,
  'toggle-sidebar': CH.shortcut.toggleSidebar,
  'open-settings': CH.shortcut.openSettings,
  'command-palette': CH.shortcut.commandPalette
}

let webglRepairTimer: NodeJS.Timeout | undefined
const WEBGL_REPAIR_BURST_DEBOUNCE_MS = 500
function requestWebglRepair(): void {
  clearTimeout(webglRepairTimer)
  webglRepairTimer = setTimeout(
    () => sendToRenderer(CH.webgl.repair),
    WEBGL_REPAIR_BURST_DEBOUNCE_MS
  )
}

let workspaceMgr: ReturnType<typeof buildWorkspaces> | null = null
let claudeStore: ReturnType<typeof buildClaudeStore> | null = null

let freshness: GitFreshnessEngine | null = null
let gitAccounts: GitAccountService | null = null
let remoteSync: RemoteSync | null = null
trackerDeps.machineTmp = (host) => remoteSync?.machineTmp(host)
const realFilesOn = (host: string, files: string[]): Promise<Map<string, string>> =>
  hosts.machine(host).realFiles(files)
trackerDeps.realFilesOn = realFilesOn
let machinePkg: MachinePackage | null = null
const remoteControlDir = defaultControlDir()
const browserTunnels = new BrowserTunnels({
  master: (host, op) => runMasterCommand(host, op, { controlDir: remoteControlDir }),
  masterOutlivingKoloft: (host, op) =>
    masterCommandOutlivingKoloft(host, op, { controlDir: remoteControlDir }),
  run: (host, cmd) => runSsh(host, cmd, { controlDir: remoteControlDir }),
  forwardFile: (host) => browserForwardFile(app.getPath('userData'), host),
  endpointOnMachine: (tabId) => relayEndpointOnMachine(tabId),
  renewEndpointOnMachine: (tabId) => renewRelayEndpointOnMachine(tabId)
})
const pageForwards = new PageForwards({
  master: (host, op) => runMasterCommand(host, op, { controlDir: remoteControlDir }),
  masterOutlivingKoloft: (host, op) =>
    masterCommandOutlivingKoloft(host, op, { controlDir: remoteControlDir }),
  macPortFree,
  anyFreeMacPort,
  forwardFile: (host) => pageForwardsFile(app.getPath('userData'), host)
})
let loginEnv: Promise<void> | null = null
process.env.PATH = pathWithInstallDir(process.env.PATH, os.homedir())

// PLATFORM§1
function loginEnvReady(): Promise<void> {
  return (loginEnv ??= agentsInLoginShell(process.env)
    .then(({ env }) => {
      Object.assign(process.env, sshEnvFromLogin(process.env, env))
      if (fallbackBin) process.env.PATH = pathWithDirLast(process.env.PATH, fallbackBin)
      try {
        if (gitFirstBin) stepAsideForTheUsersGit(gitFirstBin, env.PATH)
      } catch (err) {
        console.error('[koloft] could not hand git to the one on the login PATH:', err)
      }
    })
    .catch(() => undefined))
}

function machinePackage(): MachinePackage {
  if (machinePkg) return machinePkg
  const pkgFiles = machinePackageFiles()
  return (machinePkg = buildMachinePackage(machinePackageBase(app.getPath('userData')), pkgFiles))
}

let playwrightCliBin: string | undefined
let fallbackBin: string | undefined
let gitFirstBin: string | undefined
type CronRunnerDeps = Parameters<typeof buildCronRunner>[0]
type LaunchRequest = Parameters<CronRunnerDeps['launch']>[0]
type LaunchResult = Awaited<ReturnType<CronRunnerDeps['launch']>>
type RunLeftovers = Awaited<ReturnType<CronRunnerDeps['runLeftovers']>>
let cronRunner: ReturnType<typeof buildCronRunner> | null = null
type Butler = ReturnType<typeof buildButler>
type AssistBackendChoice = Awaited<ReturnType<Parameters<typeof buildButler>[0]['backend']>>
type AwayDigest = ReturnType<typeof buildDigest>
let butler: Butler | null = null
let discordBinding: ReturnType<typeof buildDiscordBinding> | null = null
let discordLink: ReturnType<typeof buildDiscordLink> | null = null
let discordRelay: ReturnType<typeof buildDiscordRelay> | null = null
let handOver: ReturnType<typeof buildHandOver> | null = null
let sessionAsks: ReturnType<typeof buildSessionAsks> | null = null
let awayDigest: AwayDigest | null = null
let rooms: ReturnType<typeof buildRooms> | null = null
let instructionCards: ReturnType<typeof buildInstructionCards> | null = null
type SecretAsks = ReturnType<typeof buildSecretAsks>
type OwnerAsk = Parameters<SecretAsks['ask']>[0]
type SecretAnswer = Awaited<ReturnType<SecretAsks['ask']>>
let secretAsks: SecretAsks | null = null
let instructionAsks: ReturnType<typeof buildInstructionAsks> | null = null
const answerable = new Set<string>()
let hookRegDir: string | undefined
let guard: ResourceGuard | undefined
let writeHookSettings:
  | ((
      tabId: string,
      allowKoloft: boolean,
      conductor: boolean,
      playwrightServers?: string[]
    ) => string)
  | undefined
const PLAIN_KOLOFT_SHIM = {
  hookSettings: (tabId: string): string | undefined => writeHookSettings?.(tabId, false, false)
}
let claudeAgentPlugin: string | undefined
let claudeDocsPlugin: string | undefined
const docsPluginWhileOn = (): string | undefined => (docsWritingOn() ? claudeDocsPlugin : undefined)

const ATTACHMENTS_KEPT_MS = 7 * 24 * 60 * 60 * 1000
const SWITCH_FLIPS_GATHER_MS = 2000
const ATTACHMENTS_PRUNED_EVERY_MS = 24 * 60 * 60 * 1000
const ELEMENT_PICKS_KEPT_MS = 24 * 60 * 60 * 1000
const ELEMENT_PICKS_PRUNED_EVERY_MS = 60 * 60 * 1000

function elementPicksDir(): string {
  return path.join(app.getPath('userData'), 'element-picks')
}

async function savePictureIn(dir: string, extension: string, picture: Buffer): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${crypto.randomUUID()}.${extension}`)
  await fs.promises.writeFile(file, picture)
  return file
}

function savePickOnThisMac(png: Buffer): Promise<string> {
  return savePictureIn(elementPicksDir(), 'png', png)
}

const PASTED_PICTURES_KEPT_MS = 7 * 24 * 60 * 60 * 1000
const PASTED_PICTURES_PRUNED_EVERY_MS = 24 * 60 * 60 * 1000

function pastedPicturesDir(): string {
  return path.join(app.getPath('userData'), 'palette-pictures')
}

async function savePastedPicture(dataUrl: string): Promise<string | null> {
  const [, mime, picture] = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl) ?? []
  if (!Object.hasOwn(PASTED_PICTURE_EXTENSIONS, mime ?? '')) return null
  return savePictureIn(
    pastedPicturesDir(),
    PASTED_PICTURE_EXTENSIONS[mime],
    Buffer.from(picture, 'base64')
  )
}

async function withPastedPicturesOnItsMachine(
  options: CreateTabOptions
): Promise<CreateTabOptions> {
  const machine = typeof options.cwd === 'string' ? parseRemoteKey(options.cwd)?.host : undefined
  if (!machine || !options.firstPrompt) return options
  let firstPrompt = options.firstPrompt
  await Promise.all(
    pastedPicturesIn(firstPrompt, pastedPicturesDir()).map(async (file) => {
      try {
        const picture = await fs.promises.readFile(file)
        const there = await hosts.machine(machine).savePick(path.basename(file), picture)
        firstPrompt = firstPrompt.replaceAll(file, there)
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        sendToRenderer(CH.toast.show, `A pasted picture could not be copied to ${machine}: ${why}`)
      }
    })
  )
  return { ...options, firstPrompt }
}

function syncAnswerable(): void {
  const binding = discordBinding
  if (!hookRegDir || !binding) return
  for (const s of allSessions()) {
    if (!s.alive || capabilitiesFor(s.backendId, s.host).askHookWaitsForDiscord !== true) continue
    const on =
      ownerAsleep.answersFor(s.tabId) || (discordConnected() && !!binding.channelOfTab(s.tabId))
    if (on === answerable.has(s.tabId)) continue
    if (on) answerable.add(s.tabId)
    else answerable.delete(s.tabId)
    markAnswerable(hookRegDir, s.tabId, on)
  }
}

const BOOT_TIME = Date.now()

let rendererReady = false

// CC§7
const usageViews = new Map<string, Omit<AccountView, keyof AccountMeta>>()

function viewKey(name: string, kind: AccountKind): string {
  return `${kind}:${name.toLowerCase()}`
}

function accountViews(): AccountView[] {
  return listAccounts().map((a) => ({ ...a, ...usageViews.get(viewKey(a.name, a.kind)) }))
}

function pushAccounts(): void {
  sendToRenderer(CH.accounts.update, accountViews())
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
  } else {
    const status = recordProbeOutcome(name, kind, result.error === 'expired' ? '401' : 'fail')
    usageViews.set(key, { ...usageViews.get(key), probeError: result.error })
    if (status === 'expired' && prevStatus !== 'expired') notifyExpired(name)
  }
  pushAccounts()
}

const savedUsage = new SavedUsage(path.join(app.getPath('userData'), 'usage-snapshots.json'))
const picker = new AccountPicker(
  {
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
  },
  savedUsage
)

const savedHomeUsage = new SavedUsage<HomeUsage>(
  path.join(app.getPath('userData'), 'home-usage-snapshots.json')
)

function savedHomeUsageOf(a: AccountView): HomeUsage | undefined {
  return savedHomeUsage.get(viewKey(a.name, a.kind))
}

function pushHomeAccount(name: string, kind: SignInFolderKind): void {
  const key = viewKey(name, kind)
  if (findAccount(name, kind)?.status === 'ok')
    saveHomeUsage(savedHomeUsage, key, usageViews.get(key))
  pushAccounts()
}

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

function agentToolsOn(): boolean {
  return loadSettings().agentTools
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
    machine
  }
}

const machineRemoteDeps = {
  machine: (host: string) => hosts.machine(host),
  hosts: () => workspaceMgr?.remoteTargets().map((t) => t.host) ?? [],
  keyed: pinnedKeyOn,
  mirrorDir: (host: string) => mirrorHookDir(app.getPath('userData'), host),
  gone: (host: string, sessionId: string) =>
    !!remoteSync?.connected(host) && !remoteSync.alive(host).has(sessionId),
  connected: (host: string) => !!remoteSync?.connected(host),
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

function projectRows(): WorkspaceRows[] {
  return (workspaceMgr?.rows() ?? []).filter((w) => !w.workspace.claim)
}

function butlerSide(tabId: string): boolean {
  return (
    !!butler?.isButlerTab(tabId) ||
    sessionBackends.workspaceOfTab(tabId) === conductorFolder(app.getPath('userData'))
  )
}

async function mcpServersNow(): Promise<McpServer[]> {
  const folders = [
    ...(workspaceMgr?.pinnedPathList() ?? []).filter((p) => !isRemoteKey(p)),
    conductorFolder(app.getPath('userData'))
  ]
  const walks = await Promise.all(
    folders.map(async (onlyIn) => ({
      onlyIn,
      toRoot: foldersUpToRoot(onlyIn),
      toRepoTop: await foldersUpToRepoTop(onlyIn, isGitCheckoutAsync)
    }))
  )
  const inFolders = (file: string, walk: 'toRoot' | 'toRepoTop'): Promise<ConfigText[]> =>
    Promise.all(
      walks.flatMap((w) =>
        w[walk].map(async (folder) => ({
          onlyIn: w.onlyIn,
          text: await textOrNull(path.join(folder, file))
        }))
      )
    )
  const [claudeJson, projectFiles, agyProjectFiles, codexToml, agy] = await Promise.all([
    textOrNull(claudeJsonPath()),
    inFolders(PROJECT_MCP_FILE, 'toRoot'),
    inFolders(AGY_PROJECT_MCP_FILE, 'toRepoTop'),
    textOrNull(codexSharedConfig()),
    textOrNull(path.join(ownersGemini(), 'config', 'mcp_config.json'))
  ])
  const claudeFolders = folders.map((folder) => ({
    folder,
    projectKey: claudeProjectKey(folder)
  }))
  return [
    ...claudeServers(claudeJson, projectFiles, claudeFolders),
    ...codexServers(codexToml),
    ...jsonServers('agy', [{ text: agy }, ...agyProjectFiles])
  ]
}

function pinnedWorkspaceOfTab(tabId: string): string | undefined {
  const workspace = sessionBackends.workspaceOfTab(tabId)
  return workspace && workspaceMgr?.isPinned(workspace) ? workspace : undefined
}

function notesFileOfScope(scope: string): string | undefined {
  return scope === GLOBAL_SCOPE || workspaceMgr?.isPinned(scope)
    ? ensureNotesFile(notesBaseDir(), scope)
    : undefined
}

const commands = new Commands(PLUGINS)

const workbenchCommands: PluginStartDeps['workbench']['commands'] = {
  open: async (tabId, target, view) => {
    const machine = machineOfTab(tabId)
    if (machine && !schemeOf(target)) return openOnMachine(tabId, machine, target, view)
    const routed = routeFor(target, 'agent')
    const decision: RouteDecision =
      routed.reason === 'unsupported-target' && !schemeOf(target) && (await isRegularFile(target))
        ? { dest: 'preview', target }
        : routed
    return openInWorkbench(tabId, decision, 'agent', target, view)
  },
  announceOpened: (opened) => moments.announce(FILE_OPENED, opened),
  notesFileOf: (tabId) => {
    const scope = butlerSide(tabId) ? GLOBAL_SCOPE : sessionBackends.workspaceOfTab(tabId)
    return scope ? notesFileOfScope(scope) : undefined
  }
}

const leavesNothingToCleanUp = (): void => {}
const oneShotTargets: Record<BackendId, AgentMain['oneShotTarget']> = {
  claude: async () => {
    const env = await pickedAccountEnv()
    if (!env) return null
    const binary = ptyMgr.shimDir ? path.join(ptyMgr.shimDir, 'claude') : 'claude'
    return { binary, env, done: leavesNothingToCleanUp }
  },
  codex: async () => {
    const picked = pickCodexHome()
    if (!picked || !codexSessions || !(await codexSessions.availability()).available) return null
    const binary = codexSessions.cliBinary
    if (!binary) return null
    const env = { ...codexSessions.defaultEnv, CODEX_HOME: picked.home }
    return { binary, env, done: leavesNothingToCleanUp }
  },
  agy: () => agyOneShotTarget()
}
const agentsMain = new AgentsMain()
for (const id of SESSION_BACKENDS) agentsMain.register({ id, oneShotTarget: oneShotTargets[id] })
const assist = koloftAssist({
  picks: loadSettings,
  enabled: (backend) => !turnedOffNow(backend),
  target: (backend) => agentsMain.oneShotTarget(backend),
  onThisAccount: assistJobPick
})
const assistRuns = new Map<number, AbortController>()

function turnedOffNow(backend: BackendId): string | null {
  return loadSettings().sessionMethods.enabled[backend] ? null : turnedOffLine(backend)
}

function installedBackends(): Promise<BackendAvailability[]> {
  return sessionBackends.availability((id) => ({
    id,
    available: false,
    reason: startupErrors[id] ?? `${BACKEND_LABEL[id]} is not ready.`
  }))
}

async function assistBackendChoice(): Promise<AssistBackendChoice> {
  const settings = loadSettings()
  const order = assistBackendsFor('butler', settings)
  const preferred = order[0]
  const inputs = {
    enabled: settings.sessionMethods.enabled,
    installed: await installedBackends(),
    accounts: listAccounts()
  }
  const choice = butlerStart(order, inputs, butlerNameNow())
  const notOnPreferred = 'error' in choice ? choice.inFull : choice.because
  if (notOnPreferred) logWhyButlerIsNotOn(preferred, inputs, notOnPreferred)
  if ('error' in choice) return choice
  const asked = assistLaunchOn('butler', choice.backend, settings)
  const { pick, note } = await ownPick(choice.backend, asked, modelsAssistGoesBy)
  const { model, effort } = pick
  return {
    ...choice,
    ...(model && { model }),
    ...(effort && { effort }),
    ...(note && { modelNote: note })
  }
}

function logWhyButlerIsNotOn(
  preferred: BackendId,
  inputs: Parameters<typeof butlerStart>[1],
  said: string
): void {
  const probe = inputs.installed.find((b) => b.id === preferred)
  const found = probe?.available ? 'found' : `not found (${probe?.reason ?? 'no answer'})`
  const accounts = inputs.accounts
    .filter((a) => ACCOUNT_KINDS_OF[preferred].includes(a.kind))
    .map((a) => (a.enabled ? a.status : 'turned off'))
  console.error(
    `${BUTLER_OFF_ITS_AGENT_LOG} ${said} (${BACKEND_LABEL[preferred]} ${found}; its accounts: ${accounts.join(', ') || 'none'})`
  )
}

// CC§11
async function liveClaudeRegistryOn(host: string): Promise<string> {
  await loginEnvReady()
  const r = await runSsh(host, remoteAnswerCommand(LIVE_REGISTRY_ON_A_MACHINE_SH), {
    controlDir: remoteControlDir
  })
  if (r.code !== 0) throw new Error(problemOf(r))
  return r.stdout
}

const messaging = sessionMessaging({
  get tracker() {
    return tracker
  },
  get hosts() {
    return hosts
  },
  get codexSessions() {
    return codexSessions
  },
  get hookRegDir() {
    return hookRegDir
  },
  get butler() {
    return butler
  },
  get sessionBackends() {
    return sessionBackends
  },
  get writeLineInTurn() {
    return writeLineInTurn
  },
  get noteOfWhatKoloftSends() {
    return noteOfWhatKoloftSends
  },
  get noteSent() {
    return noteSent
  },
  get buildHandOver() {
    return buildHandOver
  },
  ptyMgr,
  startupErrors,
  remoteControlDir,
  sessionOfTab,
  machineOfTab,
  storedOwnerOf,
  liveClaudeRegistryOn,
  whenMessagingSocket,
  whenMessagingSocketOnMachine
})

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
    s.alive && !s.overseer && s.sessionId
      ? [
          {
            tabId: s.tabId,
            sessionId: s.sessionId,
            title: s.title,
            treeRoot: s.treeRoot,
            files: s.files,
            liveWrites: s.liveWrites
          }
        ]
      : []
  )
}

function noticeOf(tabId: string): NoticeFile | undefined {
  const host = machineOfTab(tabId)
  if (host) return hosts.machine(host).notice(tabId)
  return hookRegDir ? localNotice(noticeFile(hookRegDir, tabId)) : undefined
}

const sessionSyncDeps: PluginStartDeps['sessions']['sessionSync'] = {
  repoOf: (dir) => syncRepoKeys.resolve(dir),
  gitOut: (dir, args) => hosts.of(dir).gitOut(dir, args),
  notice: noticeOf
}

const A_MODEL_LIST_IS_READ_AGAIN_AFTER_MS = 3_600_000
const modelLists = new Map<BackendId, { at: number; listed: Promise<ListedModel[] | undefined> }>()

async function readModelList(backend: BackendId): Promise<ListedModel[] | undefined> {
  if (backend === 'codex') {
    const picked = codexPicker.peek(accountViews())
    return codexSessions?.listedModels(picked && codexHomeOf(app.getPath('userData'), picked.name))
  }
  const target = await agentsMain.oneShotTarget(backend)
  if (!target) return undefined
  return readAgyModels(target.binary, target.env, target.args ?? []).finally(() => target.done())
}

function listedModels(backend: BackendId): Promise<ListedModel[] | undefined> {
  const kept = modelLists.get(backend)
  if (kept && Date.now() - kept.at < A_MODEL_LIST_IS_READ_AGAIN_AFTER_MS) return kept.listed
  const listed = readModelList(backend).catch(() => undefined)
  modelLists.set(backend, { at: Date.now(), listed })
  void listed.then((models) => {
    if (models?.length) modelsLastRead.set(backend, models)
    else if (modelLists.get(backend)?.listed === listed) modelLists.delete(backend)
  })
  return listed
}

const THE_DIALOG_WAITS_FOR_THE_ACCOUNTS_MODELS_MS = 2000
// AGY§21
const ASSIST_WAITS_FOR_ITS_FIRST_MODEL_LIST_MS = 5000

const listedModelsWithin = (backend: BackendId, ms: number): Promise<ListedModel[] | undefined> =>
  within(listedModels(backend), ms, 'the model list').catch(() => undefined)

const modelsLastRead = new Map<BackendId, ListedModel[]>()

async function modelsAssistGoesBy(backend: BackendId): Promise<ListedModel[] | undefined> {
  const reading = listedModelsWithin(backend, ASSIST_WAITS_FOR_ITS_FIRST_MODEL_LIST_MS)
  return modelsLastRead.get(backend) ?? reading
}

const defaultsOfProjects = projectDefaults({
  rootOf: (dir) => projectInfoOnHost(dir).root,
  reachable: (root) => {
    const remote = parseRemoteKey(root)
    return remote ? hosts.machine(remote.host).reachOrThrow() : Promise.resolve()
  },
  repoOf: (root, fresh) => hosts.of(root).github.ownerSlashName(root, fresh),
  saved: () => loadSettings().sessionDefaults,
  save: (sessionDefaults) => commitSettings({ sessionDefaults }),
  now: Date.now
})

async function rulesOf(workspace: string): Promise<string | undefined> {
  return (await defaultsOfProjects.of(workspace))?.rules
}

async function instructionsOf(workspace: string): Promise<string[]> {
  return ownerPartsOf(
    loadSettings().everyWorkspaceInstructions,
    await defaultsOfProjects.of(workspace),
    workspace === butlerFolderNow()
  )
}

const everyWorkspaceVersions = (): InstructionsVersion[] =>
  loadSettings().everyWorkspaceInstructions
const saveEveryWorkspaceVersions = (everyWorkspaceInstructions: InstructionsVersion[]): void => {
  commitSettings({ everyWorkspaceInstructions })
}

async function ownPick(
  backend: BackendId,
  asked: OwnPick,
  models: (backend: BackendId) => Promise<ListedModel[] | undefined> = listedModels
): Promise<OwnPickResolved> {
  const listed = needsTheAccountsModels(backend, asked.model) ? await models(backend) : undefined
  return resolveOwnPick(backend, asked, listed)
}

const assistNotesSaid = new Set<string>()

async function assistJobPick(backend: BackendId, asked: OwnPick): Promise<OwnPick> {
  const { pick, note } = await ownPick(backend, asked, modelsAssistGoesBy)
  if (note && !assistNotesSaid.has(note)) {
    assistNotesSaid.add(note)
    sendToRenderer(CH.toast.show, `Koloft Assist: ${note}`)
  }
  return pick
}

async function withOwnDefaults(opts: CreateTabOptions): Promise<CreateTabOptions> {
  const backend = backendIdOf(opts.kind)
  if (!backend || typeof opts.cwd !== 'string' || !takesOwnDefaults(opts)) return opts
  const asked = (await defaultsOfProjects.of(opts.cwd))?.picks[backend]
  if (!asked) return opts
  const { pick, note } = await ownPick(backend, asked)
  if (note) sendToRenderer(CH.toast.show, note)
  return { ...opts, ...pick }
}

const butlerFolderNow = (): string => conductorFolder(app.getPath('userData'))
const isButlerNow = (tabId: string): boolean => !!butler?.isButlerTab(tabId)

const sessionDeps: SessionVerbDeps = {
  projectRules: rulesOf,
  pickFacts: async (backend) => ({
    fableLeft: picker.fableLeft(),
    ...(listsModels(backend) && { listed: await listedModels(backend) })
  }),
  workspaceOf: (tabId) => sessionBackends.workspaceOfTab(tabId),
  allSessions: () => allSessions().filter((s) => !s.overseer),
  tabOpen: (tabId) => sessionBackends.ownerOfTab(tabId) !== undefined,
  pinnedWorkspaces: () => workspaceMgr?.pinnedPaths() ?? [],
  peerNames: () => sessionBackends.peerNames(),
  turnedOff: turnedOffNow,
  launch: async (options) => {
    const title = options.name ?? BACKEND_LABEL[options.kind]
    return launchQuietTab(options, title, { launch: options })
  },
  assist,
  ...messaging.forSessionVerbs,
  get startedSessions() {
    return startedSessions
  },
  closable: closableSessions,
  whatIsLeft: (target, waitUntil) => whatClosingWouldLose(target, undefined, waitUntil),
  closeSoon: (inOrder, tellStarter) =>
    setTimeout(async () => {
      for (const target of inOrder) {
        const tell = (text: string): void => {
          tellTheOwner(text)
          tellStarter(target, text)
        }
        if (!(await closeOrTell(target, tell))) return
      }
    }, CLOSE_AFTER_THE_CALLER_READS_ITS_REPLY_MS),
  overseer: { is: isButlerNow, target: butlerTarget, folder: butlerFolderNow, ...butlersWords },
  speaksForTheOwner: butlerSide,
  sidebar: () => workspaceMgr?.rows() ?? [],
  worktrees: async (wsPath) => (await workspaceMgr?.worktrees(wsPath).catch(() => [])) ?? [],
  readTurns: (key, n) => sessionBackends.turns(key, n),
  transcriptPlaces: (key) => sessionBackends.transcriptPlaces(key),
  quotedPrompt: (tabId) => {
    const host = tracker.remoteOf(tabId)?.host
    const dir = host ? mirrorHookDir(app.getPath('userData'), host) : hookRegDir
    return dir ? quotedPrompt(dir, tabId) : undefined
  },
  resume: async (row) => {
    const resumed = await resumeRow(row, { rebuildGoneWorktree: true })
    if (!resumed.ok) throw new Error(resumed.error)
    return resumed.tabId
  },
  ready: tabTypable,
  bound: tabBound,
  asking: asksTheOwner,
  stop: killTabFromMain,
  answer: answerSession,
  undelivered: (callerTab, target, why) => {
    const callerChannel = discordBinding?.channelOfTab(callerTab)
    const channelId =
      callerChannel ?? (target.overseer ? discordBinding?.channel()?.channelId : undefined)
    const text = `Could not deliver to ${target.name}: ${why}`
    const butlerTab = callerChannel ? callerTab : butler?.liveTab()
    if (channelId && discordRelay?.reaches(butlerTab ?? callerTab))
      discordRelay.say(channelId, `⚠ ${text}`)
    else sendToRenderer(CH.toast.show, text)
    if (callerChannel) void handOver?.tell(butlerRecipient(), `[Koloft] ${text}`)
  },
  command: async (callerTab, target, text, tellCaller) =>
    target.overseer && discordBinding?.channelOfTab(callerTab) && discordRelay?.reaches(callerTab)
      ? commandIntoButler(text)
      : typeCommandInto(target, text, toCaller(tellCaller)),
  screen: screenOf,
  rowNote: (key) => roomNoteOfKey(key),
  announceStarting: (starting) => moments.announce(SESSION_STARTING, starting),
  announceStarted: (started) => moments.announce(SESSION_STARTED, started),
  ownersWords: (said) => withoutTheRelayTag(said)
}

const inboxCards: PluginStartDeps['inbox']['cards'] = {
  now: () => Date.now(),
  sendFrom: (sender, ref, text, toItsOwnSession) =>
    sessionCommand.sendFrom(sender, ref, text, toItsOwnSession),
  startSession: async (spec, card, onReply) => {
    const started = await sessionCommand.startForReply(
      card.session ?? undefined,
      spec,
      ownersPermission(),
      onReply
    )
    const bound = started.session && sessionOfTab(started.session)?.sessionId
    return bound ? { ...started, session: bound } : started
  },
  quitting: () => quitCommitted
}

function liveSessionOf(ref: string): SessionInfo | undefined {
  return allSessions().find((s) => s.alive && (s.tabId === ref || s.sessionId === ref))
}

type AskedSession = NonNullable<ReturnType<PluginStartDeps['inbox']['koloft']['sessionOfTab']>>

function inboxSessionOfTab(tabId: string): AskedSession | undefined {
  const s = sessionOfTab(tabId)
  if (!s?.sessionId) return undefined
  const ws = sessionBackends.workspaceOfTab(tabId)
  return askedSession(s.sessionId, s.title, s.backendId, ws, ws && parseRemoteKey(ws)?.host)
}

function inboxSessionOfEndedTab(tabId: string): AskedSession | undefined {
  const ended = attention.list().find((m) => m.tabId === tabId && m.kind === 'exited')
  if (!ended?.sessionId || !sessionsEndedThisRun.has(ended.sessionId)) return undefined
  const ws = workspaceMgr?.workspaceOf(ended.sessionId)
  const identity = identityOf(ended.sessionId)
  if (!identity) return undefined
  const { backendId, sourceId } = identity
  const machine = (ws && parseRemoteKey(ws)?.host) ?? (sourceId === 'local' ? undefined : sourceId)
  return askedSession(ended.sessionId, ended.title, backendId, ws, machine)
}

function askedSession(
  sessionId: string,
  title: string | undefined,
  backend: BackendId,
  ws: string | undefined,
  machine: string | undefined
): AskedSession {
  return {
    sessionId,
    title: shownTitle(title) ?? BACKEND_LABEL[backend],
    backend,
    workspace: ws ? scopeName(ws) : undefined,
    machine
  }
}

const inboxKoloft: PluginStartDeps['inbox']['koloft'] = {
  marks: () => attention.list(),
  sessionOfTab: (tabId) => inboxSessionOfTab(tabId) ?? inboxSessionOfEndedTab(tabId),
  liveTabOf: (ref) => {
    const s = liveSessionOf(ref)
    return s && { tabId: s.tabId, backend: s.backendId }
  },
  claudeAskOf,
  pendingAskOf,
  answer: answerSession,
  butlerSide,
  watching: () => attention.watching()
}

const claudeDialogs = new ClaudeDialogWatch({
  watchedProcess: (tabId) => {
    const pty = ptyMgr.get(tabId)
    return backendIdOf(pty?.kind) === 'claude' ? pty : undefined
  },
  reply: (tabId, text) => ptyMgr.write(tabId, text),
  dialogShown: (tabId, onScreen) => runtime.showDialog(tabId, onScreen),
  closed: (tabId, stateAfter) => {
    claudeAskEnded(tabId)
    announceNow(DIALOG_CLOSED, tabId)
    if (stateAfter === 'working') tracker.dialogAnswered(tabId)
  }
})
trackerDeps.dialogJustClosed = (tabId) => claudeDialogs.justClosedADialog(tabId)

function claudeAskEnded(tabId: string): void {
  forgetClaudeAsk(tabId)
  questionSeen.delete(tabId)
}

async function answerSession(
  tabId: string,
  reply: string,
  byTheOverseer = false
): Promise<string | undefined> {
  return sessionAsks ? sessionAsks.answerSession(tabId, reply, { byTheOverseer }) : STILL_STARTING
}

const ownerAsks = {
  sessionTab: (tabId: string): string => tabSpokenFor(tabId, ptyMgr.get(tabId) ?? { util: false }),
  ask: (a: OwnerAsk): Promise<SecretAnswer> =>
    secretAsks
      ? secretAsks.ask(a, OWNER_TYPES_A_SECRET_WITHIN_MS)
      : Promise.resolve({ ended: 'timeout' }),
  ownerAsleep: (): boolean => presence.asleep()
}

const sessionsCommands: PluginStartDeps['sessions']['commands'] = {
  rulesOfTab: async (tabId) => {
    const workspace = sessionBackends.workspaceOfTab(tabId)
    return workspace && rulesOf(workspace)
  },
  workspace: { sidebar: projectRows },
  instructions: {
    // CC§28 CODEX§4 AGY§13
    askTheOwner: (ask, write, stillWaiting) =>
      instructionAsks
        ? instructionAsks.ask(
            ask,
            cronTestMs('KOLOFT_INSTRUCTIONS_ASK_MS', OWNER_TYPES_A_SECRET_WITHIN_MS),
            write,
            stillWaiting
          )
        : Promise.reject(new Error(STILL_STARTING)),
    overseerSide: butlerSide,
    isOverseer: isButlerNow,
    overseerBlock: () =>
      butlersBlock(
        () => loadSettings().butler,
        (butler) => commitSettings({ butler }),
        Date.now
      ),
    workspaceOf: pinnedWorkspaceOfTab,
    pinnedWorkspaces: sessionDeps.pinnedWorkspaces,
    workspaceBlock: (workspace) => workspaceBlock(defaultsOfProjects, workspace, Date.now),
    everyWorkspaceBlock: () =>
      everyWorkspaceBlock(everyWorkspaceVersions, saveEveryWorkspaceVersions, Date.now),
    nameOf: (s) =>
      isButlerNow(s.tabId) ? butlerNameNow() : (sidebarTitle(s) ?? BACKEND_LABEL[s.backendId])
  }
}

const cronCommand: PluginStartDeps['scheduled-tasks']['command'] = {
  pinnedWorkspaceOf: pinnedWorkspaceOfTab,
  resolveWorkspace: (ref) => {
    const found = resolveWorkspace(ref, workspaceMgr?.pinnedPaths() ?? [])
    return found.ok ? { ok: true, value: found.value.path } : found
  },
  toast: (text) => sendToRenderer(CH.toast.show, text),
  now: () => new Date()
}

const secretCommand: PluginStartDeps['passwords']['secretCommand'] = {
  ...ownerAsks,
  machine: machineOfTab,
  pages: guestPagesOf,
  showSignIn: (tabId, url) => void openInWorkbench(tabId, routeFor(url, 'agent'), 'user'),
  open: openSignInEndOn,
  sleep
}

const pageCommand: PluginStartDeps['passwords']['pageCommand'] = {
  ...ownerAsks,
  webPagesOf: (tabId) => webPages.pagesOf(tabId),
  shoot: async ({ html, width, height }) => {
    const shot = await shootHtml(
      html,
      { width, height, pictureHeight: Infinity, mostPictures: 1 },
      'the page'
    )
    return shot.files[0]
  },
  sleep
}

async function pinnedPathsChecked(): Promise<{ path: string; missing: boolean }[]> {
  return (await workspaceMgr?.pinnedPathsCheckedOffTheMainThread()) ?? []
}

const githubMain: PluginStartDeps['github']['main'] = {
  repos: (wsPath) => hosts.of(wsPath).github,
  pinnedWorkspaces: pinnedPathsChecked,
  restampRows: () => workspaceMgr?.restampLive(),
  browserCookies: (domain) => session.fromPartition(BROWSER_PARTITION).cookies.get({ domain }),
  accounts: {
    ready: loginEnvReady,
    picked: (root) => gitAccounts?.pickedAccount(root),
    ghEnv: async (root) => gitAccounts?.ghEnv(root),
    ghEnvForRepo: async (repo, pinned) => gitAccounts?.ghEnvForRepo(repo, pinned),
    machineGh: async (root, args) => (await gitAccounts?.machineGh(root, args)) ?? null
  },
  ghOnThisMac: ghRead,
  butlerSide,
  workspaceOfTab: (tabId) => sessionBackends.workspaceOfTab(tabId),
  pinnedPaths: () => workspaceMgr?.pinnedPathList() ?? []
}

const todoCommand: PluginStartDeps['todo'] = {
  allowed: butlerSide,
  sidebar: () => workspaceMgr?.rows() ?? [],
  pinnedWorkspaces: sessionDeps.pinnedWorkspaces,
  sessions: () => allSessions().filter((s) => !s.overseer),
  asking: asksTheOwner,
  asleep: (sessionId) => !!sleepers.tabOf(sessionId),
  workLeft: async (row, merged) => {
    const tree = await closingTree(hostGitOut, projectInfoFor(row.cwd))
    return tree ? whatIsLeft(hostGitOut, tree, merged) : null
  },
  deleting: (row) => treeRemovals.has(row.cwd),
  worktrees: sessionDeps.worktrees,
  repoOf: (wsPath) => hosts.of(wsPath).github.ownerSlashName(wsPath),
  ghOfRepo: (wsPath) => hosts.of(wsPath).github.ghOfRepo(wsPath),
  mergedHeadsByBranch: (wsPath) => hosts.of(wsPath).github.mergedHeadsByBranch(wsPath),
  mergedHeads: (dir, branch) => mergedHeads(dir, branch),
  settings: { load: loadSettings, commit: commitSettings },
  projectFiles: async (wsPath) => (await hosts.of(wsPath).listDir(wsPath)).filter((e) => !e.isDir),
  readText: (file) => hosts.of(file).readText(file),
  servers: mcpServersNow,
  butlerFolder: butlerFolderNow,
  now: Date.now
}

const agentRequests = new AgentRequests({
  commands,
  tab: (tabId) => ptyMgr.get(tabId),
  session: sessionOfTab,
  enabled: (tabId) => {
    const backend = backendIdOf(ptyMgr.get(tabId)?.kind)
    return !!backend && agentToolsOn()
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

interface UtilTerminalPick {
  account: string
  home: string
  banner?: string
  warning?: string
  kind?: 'apikey'
}

const utilTerminalPicks: Record<
  Exclude<BackendId, 'claude'>,
  () => UtilTerminalPick | undefined
> = {
  codex: () => terminalPickOf(pickCodexHome()),
  agy: () => {
    const picked = terminalPickOf(pickAgyHome())
    return picked && (agyApiKeyRoute(picked.home) ? { ...picked, kind: 'apikey' } : picked)
  }
}

function terminalPickOf(
  picked: { account: string; home: string; banner?: string; notice?: string } | undefined
): UtilTerminalPick | undefined {
  return (
    picked && {
      account: picked.account,
      home: picked.home,
      banner: picked.banner,
      warning: picked.notice
    }
  )
}

const shimAccountRefusals = new Map<string, string>()

async function handlePickRequest(pickDir: string, reqName: string, raw: unknown): Promise<void> {
  const obj = raw as { tabId?: string; ts?: number; backend?: string }
  const tab = obj.tabId ? ptyMgr.get(obj.tabId) : undefined
  if (!obj.tabId || !tab) return
  const id = reqName.slice('req-'.length).replace(/\.json$/, '')
  if (!/^[A-Za-z0-9-]+$/.test(id)) return
  const resPath = path.join(pickDir, `res-${id}.json`)
  const backend = backendIdOf(obj.backend)
  if (obj.backend !== undefined && !backend) {
    try {
      writeWholeBeforeVisible(resPath, '{}')
    } catch {}
    return
  }
  if (backend && backend !== 'claude') {
    let picked: UtilTerminalPick | undefined
    try {
      picked = utilTerminalPicks[backend]()
    } catch (err) {
      console.error(`[koloft] picking a ${backend} account for a terminal failed:`, err)
    }
    try {
      writeWholeBeforeVisible(resPath, JSON.stringify(picked ?? {}))
    } catch {}
    pushAccounts()
    return
  }
  const { res, endpoint } = await pickForLaunch(obj.tabId, tab.resumeSessionId)
  const accountIssue = res.account === null && noAccountLine(listAccounts(), 'claude')
  if (accountIssue) shimAccountRefusals.set(obj.tabId, accountIssue)
  else shimAccountRefusals.delete(obj.tabId)
  const payload: Record<string, unknown> = { ...res }
  if (res.account && loadSettings().skipPermissions) payload.skipFlag = true
  claudeBackend.picked(obj.tabId, payload.skipFlag === true)
  if (endpoint?.baseUrl) payload.baseUrl = endpoint.baseUrl
  if (endpoint?.model) {
    payload.model = endpoint.model
    if (claudeCodeGuessesWindowOf(endpoint.model)) payload.disable1mContext = true
  }
  try {
    writeWholeBeforeVisible(resPath, JSON.stringify(payload))
  } catch {}
  pushAccounts()
}

// CC§7
interface LoginWatch {
  name: string
  buf: string
  sawUrl: boolean
  done: boolean
  giveUp: NodeJS.Timeout
  installing?: { carry: string }
}
const loginWatchers = new Map<string, LoginWatch>()
const loginPtys = new Set<string>()
const LOGIN_TIMEOUT_MS = 10 * 60_000
const LOGIN_TIMED_OUT = 'Sign-in timed out'
// CC§10
const INSTALL_SILENCE_LONGER_THAN_EITHER_SILENT_DOWNLOAD_AT_2_MBIT_MS = 30 * 60_000
const INSTALL_STALLED = `The Claude Code install did not finish: it printed nothing for ${INSTALL_SILENCE_LONGER_THAN_EITHER_SILENT_DOWNLOAD_AT_2_MBIT_MS / 60_000} minutes`
const LOGIN_BUF_MAX = 8192
const LOGIN_PTY_COLS_WIDER_THAN_TOKEN = 800
const ACCOUNT_PROBE_TIMEOUT_MS = 10_000
// CC§7
const AUTH_URL_RE = /https?:\/\/[^\s'"`<>\x00-\x1f\x7f]+(?=[\s'"`<>\x00-\x1f\x7f])/
// CC§7
const TOKEN_RE = /sk-ant-[A-Za-z0-9]{2,12}-[A-Za-z0-9_-]{24,}/

function loginTimeoutMs(): number {
  return cronTestMs('KOLOFT_LOGIN_TIMEOUT_MS', LOGIN_TIMEOUT_MS)
}

function sendLoginProgress(p: LoginProgress): void {
  sendToRenderer(CH.accounts.loginProgress, p)
}

function feedLoginWatcher(tabId: string, data: string): void {
  const w = loginWatchers.get(tabId)
  if (!w || w.done) return
  if (w.installing) {
    const seen = w.installing.carry + data
    const rest = afterOutputStart(seen)
    if (rest === null) {
      w.installing.carry = outputStartCarry(seen)
      w.giveUp.refresh()
      w.buf = (w.buf + stripTerminalCodes(data)).slice(-LOGIN_BUF_MAX)
      return
    }
    clearTimeout(w.giveUp)
    w.giveUp = giveUpLoginAfter(tabId, loginTimeoutMs(), LOGIN_TIMED_OUT)
    w.installing = undefined
    w.buf = ''
    data = rest
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
  endLoginWatch(tabId, w)
  void completeLogin(tabId, w.name, m[0])
}

function endLoginWatch(tabId: string, w: LoginWatch): void {
  w.done = true
  loginWatchers.delete(tabId)
  clearTimeout(w.giveUp)
}

function failLogin(tabId: string, why: string, terminalKept = true): void {
  const w = loginWatchers.get(tabId)
  if (!w || w.done) return
  endLoginWatch(tabId, w)
  const tail = plainTerminalTail(w.buf)
  sendLoginProgress({
    phase: 'failed',
    name: w.name,
    tail: `${why}${tail ? `\n${tail}` : ''}`,
    ...(terminalKept && { tabId, cwd: ptyMgr.get(tabId)?.cwd })
  })
}

function giveUpLoginAfter(tabId: string, ms: number, why: string): NodeJS.Timeout {
  return setTimeout(() => {
    failLogin(tabId, why, false)
    try {
      ptyMgr.kill(tabId)
    } catch {}
  }, ms)
}

function cancelGuidedLogin(tabId: string): void {
  const w = loginWatchers.get(tabId)
  if (!w) return
  endLoginWatch(tabId, w)
  try {
    ptyMgr.kill(tabId)
  } catch {}
}

function startGuidedLogin(name: string, installFirst: boolean): string {
  const handle = ptyMgr.create({
    kind: 'shell',
    koloftShim: PLAIN_KOLOFT_SHIM,
    cwd: os.homedir(),
    // CC§7
    cols: LOGIN_PTY_COLS_WIDER_THAN_TOKEN,
    rows: 50,
    setupCommand: setupLine(),
    launchCommand: installFirst
      ? installThen(
          'claude',
          (claude) => `${MARK_OUTPUT_START}; exec ${claude} setup-token`,
          process.env.KOLOFT_TEST_TOOL_INSTALLER
        )
      : 'claude setup-token'
  })
  loginWatchers.set(handle.id, {
    name,
    buf: '',
    sawUrl: false,
    done: false,
    giveUp: installFirst
      ? giveUpLoginAfter(
          handle.id,
          cronTestMs(
            'KOLOFT_INSTALL_SILENCE_MS',
            INSTALL_SILENCE_LONGER_THAN_EITHER_SILENT_DOWNLOAD_AT_2_MBIT_MS
          ),
          INSTALL_STALLED
        )
      : giveUpLoginAfter(handle.id, loginTimeoutMs(), LOGIN_TIMED_OUT),
    ...(installFirst && { installing: { carry: '' } })
  })
  loginPtys.add(handle.id)
  if (installFirst) toolInstallPtys.add(handle.id)
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
    picker.probed('oauth', name, result)
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
let probeOnceTheRendererIsUp: LaunchUsageProbe = null

function probeSignInFolderAccounts(): Promise<void> {
  return Promise.all([probeCodexAccounts(), probeAgyAccounts()]).then(() => undefined)
}

function probeAllForPanel(): Promise<AccountView[]> {
  if (probeAllInFlight) return probeAllInFlight
  const round = (async (): Promise<AccountView[]> => {
    const claude = listAccounts().filter(
      (a) => a.enabled && ACCOUNT_KINDS_OF.claude.includes(a.kind)
    )
    await Promise.all([
      probeSignInFolderAccounts(),
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
        picker.probed(a.kind, a.name, result)
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

const LAUNCH_PROBES: Record<NonNullable<LaunchUsageProbe>, () => Promise<unknown>> = {
  everyAccount: probeAllForPanel,
  signInFoldersOnly: probeSignInFolderAccounts
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
  if (isSignInFolderKind(kind)) return addHomeKey(kind, name, trimmed)
  const baseUrl = endpoint?.baseUrl?.trim()
  const model = endpoint?.model?.trim() || undefined
  if (takesAnEndpoint(kind) && !isHttpUrl(baseUrl)) return { ok: false, error: 'invalid-endpoint' }
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
    ...(takesAnEndpoint(kind) ? { baseUrl, model } : {})
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

function foldHomeSignIn(name: string, kind: SignInFolderKind, signedIn: boolean): void {
  if (!signedIn) savedHomeUsage.delete(viewKey(name, kind))
  const acct = findAccount(name, kind)
  if (!acct) return
  const status = signedIn ? 'ok' : acct.status === 'ok' ? 'expired' : acct.status
  if (status === acct.status) return
  upsertAccountMeta({ ...acct, status })
  if (status === 'expired') notifyExpired(name, BACKEND_LABEL[BACKEND_OF_SIGN_IN_FOLDER[kind]])
}

const homeAccountsDeps = {
  app,
  accountViews,
  allLimitedNotice,
  findAccount,
  foldHomeSignIn,
  listAccounts,
  pushHomeAccount,
  savedHomeUsageOf,
  usageViews,
  viewKey,
  sessionAccounts: () => sessionAccounts
}
const codexAccounts = codexHomeAccounts({
  ...homeAccountsDeps,
  codexSharedConfig,
  codexSessions: () => codexSessions
})
const { codexPicker, pickCodexHome, codexUseReset, probeCodexAccounts } = codexAccounts
const agyAccounts = agyHomeAccounts({
  ...homeAccountsDeps,
  keychainRead,
  keychainWrite,
  ownersGemini,
  agySessions: () => agySessions
})
const { agyPicker, agyHomeFor, agyApiKeyOf, pickAgyHome, agyBinary, probeAgyAccounts } = agyAccounts

function codexSharedConfig(): string {
  return codexConfigFile(codexSessions?.defaultEnv)
}

interface HomeSignInTab {
  kind: SignInFolderKind
  name: string
  again: boolean
  output: SignInOutput
}
const signInPtys = new Map<string, HomeSignInTab>()
let signInFailure: SignInFailure | null = null

function setSignInFailure(f: SignInFailure | null): void {
  signInFailure = f
  sendToRenderer(CH.accounts.signInFailure, f)
}

function forgetAccount(name: string, kind: AccountKind): void {
  removeAccountMeta(name, kind)
  usageViews.delete(viewKey(name, kind))
  savedHomeUsage.delete(viewKey(name, kind))
  picker.forget(kind, name)
  pushAccounts()
}

async function endHomeSignIn(s: HomeSignInTab): Promise<void> {
  const probeAnswered = await probeHomeAccount[s.kind](s.name).then(
    () => !usageViews.get(viewKey(s.name, s.kind))?.probeError,
    () => false
  )
  const account = findAccount(s.name, s.kind)
  if (!probeAnswered || !account || account.status === 'ok') return
  if (!s.again) forgetAccount(s.name, s.kind)
  setSignInFailure({
    backend: BACKEND_OF_SIGN_IN_FOLDER[s.kind],
    name: s.name,
    again: s.again,
    tail: s.output.tail()
  })
}

function noteHomeAccount(name: string, kind: SignInFolderKind): void {
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

const homeLogin: Record<
  SignInFolderKind,
  (name: string) => Promise<{ binary?: string; env: Record<string, string>; args?: string[] }>
> = {
  'codex-home': codexAccounts.homeLogin,
  'agy-home': agyAccounts.homeLogin
}

const probeHomeAccount: Record<SignInFolderKind, (name: string) => Promise<void>> = {
  'codex-home': codexAccounts.probeHomeAccount,
  'agy-home': agyAccounts.probeHomeAccount
}

async function signInToHome(
  kind: SignInFolderKind,
  name: string,
  again: boolean
): Promise<SignInResult> {
  const v = again
    ? findAccount(name, kind)
      ? 'ok'
      : 'invalid-name'
    : validateNewAccount(name, kind)
  if (v !== 'ok') return { ok: false, error: v }
  if (!again && keepsSecretInKeychain(kind) && !(await keychainDelete(kind, name)))
    return { ok: false, error: 'keychain' }
  if (signInFailure) setSignInFailure(null)
  const login = await homeLogin[kind](name)
  noteHomeAccount(name, kind)
  const assignments = Object.entries(login.env).map(([k, val]) => `${k}=${shq(val)}`)
  const args = (login.args ?? ['login']).map(shq).join(' ')
  // PLATFORM§63
  const signIn = (quotedBinary: string): string =>
    `exec env ${assignments.join(' ')} ${quotedBinary} ${args}`
  const tab = homeShellTab(
    `${MARK_OUTPUT_START}; ` +
      (login.binary
        ? signIn(shq(login.binary))
        : installThen(
            BACKEND_OF_SIGN_IN_FOLDER[kind],
            signIn,
            process.env.KOLOFT_TEST_TOOL_INSTALLER
          ))
  )
  signInPtys.set(tab.tabId, { kind, name, again, output: new SignInOutput() })
  if (!login.binary) toolInstallPtys.add(tab.tabId)
  return { ok: true, ...tab }
}

function ownersGemini(): string {
  return ownersGeminiDir(agySessions?.defaultEnv ?? process.env)
}

function markKeyAccountsSavedOnDisk(): void {
  for (const a of listAccounts())
    if (isSignInFolderKind(a.kind) && homeKeyOnDisk[a.kind](app.getPath('userData'), a.name))
      usageViews.set(viewKey(a.name, a.kind), { apiKey: true })
}

const storeHomeKey: Record<SignInFolderKind, (name: string, key: string) => Promise<void>> = {
  'codex-home': codexAccounts.storeHomeKey,
  'agy-home': agyAccounts.storeHomeKey
}

async function addHomeKey(
  kind: SignInFolderKind,
  name: string,
  key: string
): Promise<AccountAddResult> {
  try {
    await storeHomeKey[kind](name, key)
  } catch {
    return { ok: false, error: 'unknown' }
  }
  noteHomeAccount(name, kind)
  await probeHomeAccount[kind](name)
  const account = accountViews().find((a) => a.kind === kind && a.name === name)
  return { ok: account?.status === 'ok', account }
}

// AGY§6 AGY§20
async function agyOneShotTarget(): Promise<OneShotTarget | null> {
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
    scheme: PREVIEW_FILE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  },
  { scheme: MACHINE_PAGE_SCHEME, privileges: { standard: true, secure: true } },
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
    '.ico': 'image/x-icon',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
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
  cronRunner?.onRendererTeardown((tabId) => !!ptyMgr.get(tabId)?.alive)
  closeAllDirWatchers()
  closeAllFileWatchers()
  remoteSync?.unwatchAll()
  terminalOutput.clear()
  pageRouting.overlayListenerLost()
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
  mainWindow.webContents.on('input-event', handsOnKoloft)
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
    OFF_SCREEN_TEST ? { maximized: geo.maximized, fullScreen: geo.fullScreen } : undefined,
    () => hiddenFromFullScreen,
    () => ptyMgr.sessionScreen
  )

  // PLATFORM§5
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    rendererTeardown()
  })
  const win = mainWindow
  win.on('close', (e) => {
    if (quitCommitted || win.webContents.isCrashed()) return
    e.preventDefault()
    hideMainWindow(win)
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
  mainWindow.on('enter-full-screen', () => sendToRenderer(CH.window.fullscreen, true))
  mainWindow.on('leave-full-screen', () => sendToRenderer(CH.window.fullscreen, false))
  mainWindow.on('focus', () => {
    // PLATFORM§10
    sendToRenderer(CH.window.focus, true)
    if (blurredAt && Date.now() - blurredAt > WEBGL_REPAIR_BLUR_MS) requestWebglRepair()
    blurredAt = 0
    if (uiActiveTabId) ownerSees(uiActiveTabId)
    void freshness?.sweep({ host: null })
  })
  mainWindow.on('blur', () => {
    sendToRenderer(CH.window.focus, false)
    blurredAt = Date.now()
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
  ptyMgr.sessionScreen = restoredWindowGeometry().sessionScreen
  const stallLog = signalLog(path.join(app.getPath('userData'), 'main-stalls.log'))
  const stalls = new StallWatchWhileFocused(stallLog)
  answerTheStuckWatch(
    (workerData) => createMainThreadStuckWorker({ workerData }),
    {
      pid: process.pid,
      samplesDir: path.join(app.getPath('userData'), 'main-stuck'),
      stuckAfterMs: envMs('KOLOFT_MAIN_STUCK_MS', STUCK_AFTER_MS) || STUCK_AFTER_MS
    },
    stallLog
  )
  const followFocus = (): void => stalls.follow(!!BrowserWindow.getFocusedWindow())
  app.on('browser-window-focus', followFocus)
  app.on('browser-window-blur', () => setImmediate(followFocus))
  presence.macLastUsed()
  protocol.handle(PREVIEW_FILE_SCHEME, async (request) => {
    const file = previewFileOf(request.url)
    const data = file === null ? null : await bytesOfAFileHere(file)
    if (!file || !data) return new Response('Not found', { status: 404 })
    return new Response(bodyOf(data), { headers: { 'content-type': mimeOf(file) } })
  })

  setUpBrowserPartition({
    machinePage: machinePageResponse,
    beforeRequest: routePageRequest,
    guestPreload: path.join(__dirname, '../preload/guest.js')
  })
  setupPageShotPartition()
  updateDockBadge(attention.list())
  setUpExtensions({ window: () => mainWindow })
  pageDialogs.watchSignIns()
  pageDialogs.watchCertificates()
  pageTools.watchUnload()
  setupSecretLanding()
  setupGuestForwardsEnd()
  pageRouting.watchPopups()
  pageRouting.watchContextMenu()
  pageTools.muteUnderTest()
  pageTools.watchMuteWhileHidden()
  webPages.watchGestures()
  setupPermissionCleanup()
  pageTools.watchAudio()
  pageTools.watchFullscreen()

  sweepStaleGitRequestDirs(pidAlive)
  for (const old of ['muse-homes', 'muse-sessions.json', 'muse-open', 'muse-quota'])
    void fs.promises
      .rm(path.join(app.getPath('userData'), old), { recursive: true, force: true })
      .catch(() => {})
  const gitRequestDir = newGitRequestDir()
  const { shimDir, regDir, openDir, pickDir, agentDir, gitHelper, ghWrapper } = setupShim(
    gitRequestDir,
    conductorFolder(app.getPath('userData'))
  )
  ptyMgr.shimDir = shimDir
  ptyMgr.regDir = regDir
  try {
    claudeDocsPlugin = writeDocsPlugin(app.getPath('userData'))
  } catch (err) {
    console.error('[koloft] the koloft-docs plugin could not be written:', err)
  }
  if (agentRequests.watch(agentDir)) {
    ptyMgr.agentDir = agentDir
    claudeAgentPlugin = writeAgentPlugin(app.getPath('userData'))
  }
  let butlerHearsOfSwitches: ReturnType<typeof setTimeout> | undefined
  const butlerHearsSoon = (): void => {
    clearTimeout(butlerHearsOfSwitches)
    butlerHearsOfSwitches = setTimeout(
      () => butler?.whatItKnowsMayHaveChanged(),
      SWITCH_FLIPS_GATHER_MS
    )
  }
  onSwitchesChanged(() => {
    checkSkillsAgain()
    machinePkg = null
    if (!passwordsOn()) secretAsks?.declineAll()
    followDiscordSwitch()
    startedPlugins.github.followSwitch()
    try {
      writeSudoShims(shimDir, SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS)
      if (claudeAgentPlugin) claudeAgentPlugin = writeAgentPlugin(app.getPath('userData'))
    } catch (err) {
      console.error('[koloft] could not rewrite what a plugin switch changed:', err)
    }
    butlerHearsSoon()
  })
  claudeBackend.agentReply = (tabId, raw, stillWaiting) =>
    agentRequests.replyFor(tabId, raw, stillWaiting)
  claudeBackend.watchShimRegistrations(regDir)
  if (watchOpenRequests(openDir)) ptyMgr.openDir = openDir
  if (watchPickRequests(pickDir)) ptyMgr.pickDir = pickDir
  const pruneElementPicks = (): void => pruneStale(elementPicksDir(), ELEMENT_PICKS_KEPT_MS, true)
  pruneElementPicks()
  setInterval(pruneElementPicks, ELEMENT_PICKS_PRUNED_EVERY_MS).unref()
  const prunePastedPictures = (): void =>
    pruneStale(pastedPicturesDir(), PASTED_PICTURES_KEPT_MS, true)
  prunePastedPictures()
  setInterval(prunePastedPictures, PASTED_PICTURES_PRUNED_EVERY_MS).unref()

  ptyMgr.cdpDir = cdpEnvDir()
  startRelay()
  setRelayEnabled(loadSettings().browserControl, ptyTabIds())

  const hookPaths = setupHooks((tabId) => anotherLiveInstanceOwns(tabId, pidAlive))
  const statusline = setupStatusline()
  const agyStatusline = setupAgyStatusline(statusline)
  const playwrightBin = setupPlaywrightCli()
  playwrightCliBin = playwrightBin
  fallbackBin = bundledGhDir()
  if (fallbackBin) process.env.PATH = pathWithDirLast(process.env.PATH, fallbackBin)
  gitFirstBin = setupBundledGit(path.dirname(playwrightBin), process.env.PATH)
  if (gitFirstBin) {
    process.env.PATH = pathWithDirFirst(process.env.PATH, gitFirstBin)
    void loginEnvReady()
  }
  // PLATFORM§2
  linkOrUnlink(path.join(shimDir, 'git'), gitFirstBin && path.join(gitFirstBin, 'git'))
  removeStaleLoginDirs(app.getPath('userData'))
  endAgyOneShots(path.join(app.getPath('userData'), 'agy-one-shots'))
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
    progress: (p) => sendToRenderer(CH.gitAccounts.loginProgress, p),
    accountsChanged: (views) => sendToRenderer(CH.gitAccounts.update, views),
    picksChanged: () => {
      startedPlugins.github.sweepNow()
      workspaceMgr?.restampLive()
    },
    runOnMachine: async (machine, script, args = [], opts = {}) => {
      await loginEnvReady()
      return runSsh(machine, remoteAnswerCommand(script, args), {
        controlDir: remoteControlDir,
        timeoutMs: opts.timeoutMs,
        ...(opts.input !== undefined && { input: Buffer.from(opts.input) })
      })
    }
  })
  // ADR-0033
  Object.assign(process.env, gitAccounts.configEnv(process.env))
  gitAccounts.start()
  writeHookSettings = (tabId, allowKoloft, conductor, playwrightServers) =>
    writeTabHookSettings(
      hookPaths,
      tabId,
      loadSettings().statuslineBuiltin ? statusLineSetting(statusline) : undefined,
      allowKoloft,
      conductor,
      playwrightServers
    )
  hookRegDir = hookPaths.regDir
  guard = new ResourceGuard({
    koloftPid: process.pid,
    read: readTheMachine,
    log: signalLog(path.join(app.getPath('userData'), 'machine.log')),
    memoryStaysCritical: () => pushToPages.memoryCritical(pagesInUse()),
    // ADR-0042
    agentTabsOnThisMac: () =>
      allSessions()
        .map((s) => s.tabId)
        .filter((tabId) => !machineOfTab(tabId)),
    lookedAt: () => lastTabTheOwnerLookedAt && sleepers.liveTabOf(lastTabTheOwnerLookedAt),
    changed: (state) => sendToRenderer(CH.machine.state, state),
    readTrees: readTaggedTable,
    giveWay: process.platform === 'darwin' ? giveWay : async () => {}
  })
  guard.start()
  claudeBackend.watchLocalHooks(hookPaths.regDir)

  ptyMgr.on('data', (d: { id: string; data: string }) => {
    // CC§12
    if (sleepers.has(d.id)) return
    claudeDialogs.data(d.id, d.data)
    if (loginWatchers.size) feedLoginWatcher(d.id, d.data)
    if (signInPtys.size) signInPtys.get(d.id)?.output.feed(d.data)
    watchForWorktreeRemoval(d.id, d.data)
    terminalOutput.push(d.id, d.data)
  })
  ptyMgr.on('process-title', (t: { id: string; name: string }) => {
    sendToRenderer(CH.terminal.processTitle, t)
  })
  ptyMgr.on('cwd', (c: { id: string; cwd: string }) => {
    sendToRenderer(CH.terminal.cwd, c)
  })
  subscribeTabSubsystems({
    toast: (message) => sendToRenderer(CH.toast.show, message),
    workspaces: () => workspaceMgr,
    announce: announceNow
  })
  ptyMgr.on('exit', (e) => {
    const exited = ptyMgr.get(e.id)
    if (!exited?.alive) claudeDialogs.forget(e.id)
    // CC§12 CODEX§5 AGY§1
    const unexpected =
      !e.endedByKoloft &&
      !closedTabs.has(e.id) &&
      !quitCommitted &&
      exitedAbnormally(e) &&
      !!backendIdOf(exited?.kind)
    if (unexpected && exited) unexpectedExits.set(e.id, unexpectedExitHeading(exited, e))
    const left = closedTabs.has(e.id) ? closedTabs.get(e.id) : leftTabOf(sessionOfTab(e.id))
    const restarting = closedTabs.get(e.id) === null
    closedTabs.delete(e.id)
    const asleep = sleepers.has(e.id)
    const exit: TabEnded = {
      tabId: e.id,
      exitCode: e.exitCode,
      signal: e.signal,
      asleep,
      crashed: !quitCommitted && exitedAbnormally(e),
      sessionGoesOn: quitCommitted || asleep || restarting,
      left: left ?? undefined,
      ...(unexpected ? { unexpected } : {})
    }
    for (const id of sleepers.exited(e.id, ptyMgr.get(e.id)?.resumeSessionId)) forgetSleeper(id)
    tabLifecycle.emit('exit', exit)
    touchedAt.delete(e.id)
    if (!restarting) earlierTabIds.delete(e.id)
    ownerTouchedAt.delete(e.id)
    questionSeen.delete(e.id)
    if (answerable.delete(e.id) && hookRegDir) markAnswerable(hookRegDir, e.id, false)
    if (hookRegDir) forgetAssistMarkers(hookRegDir, e.id)
    guard?.forget(e.id)
    if (exited?.utilMachine) forgetShellOnMachine(exited.utilMachine, e.id)
    const signInNobodyOpened = loginPtys.delete(e.id) && !terminalOutput.isAttached(e.id)
    if (toolInstallPtys.delete(e.id)) {
      sessionBackends.forgetAvailability()
      pushToSessions.toolsChanged()
    }
    const signingIn = signInPtys.get(e.id)
    if (signingIn) {
      signInPtys.delete(e.id)
      void endHomeSignIn(signingIn)
    }
    if (teardownKilledPtys.delete(e.id)) {
      terminalOutput.end(e.id, false)
      return
    }
    if (loginWatchers.has(e.id))
      failLogin(
        e.id,
        loginWatchers.get(e.id)?.installing
          ? 'Installing Claude Code failed'
          : 'setup-token exited without printing a token'
      )
    const claudeExit = claudeTabExits.get(e.id)
    claudeTabExits.delete(e.id)
    if (claudeExit?.leaving) {
      const { sessionId } = claudeExit.leaving
      const claudeSaid = claudeExit.watch.failure()
      if (sessionId) claudeStore?.leftWorktree(sessionId, !claudeSaid)
      if (claudeSaid)
        sendToRenderer(CH.toast.show, `Claude Code did not remove the worktree: ${claudeSaid}`)
    }
    // PLATFORM§21
    terminalOutput.end(e.id, !sleepers.has(e.id) && !signInNobodyOpened)
    forgetClaudeAsk(e.id)
    tabLifecycle.emit('teardown', exit)
    const sent: TerminalExit = { id: e.id, exitCode: e.exitCode, signal: e.signal }
    const accountIssue = shimAccountRefusals.get(e.id)
    shimAccountRefusals.delete(e.id)
    // ADR-0030
    if (accountIssue && !e.signal && e.exitCode === SHIM_FOUND_NO_ACCOUNT_EXIT)
      sent.accountIssue = accountIssue
    sendToRenderer(CH.terminal.exit, unexpected ? { ...sent, unexpected } : sent)
  })
  const sessionsChanged = sessionsChangedIn({
    noteSessions: onSessionsChanged,
    sendSessions: (all) => pushToSessions.sessions(all),
    workspaces: () => workspaceMgr,
    syncAnswerable
  })
  tracker.on('update', sessionsChanged)
  tracker.on('relocated', (e: { tabId: string; dir: string }) => {
    pushToSessions.relocated(e)
  })
  runtime.on('auto-close', ({ tabId }: { tabId: string }) => sleepTab(tabId))
  tracker.on('tool-done', ({ tabId, ...call }: ToolCall & { tabId: string }) => {
    const endsTheAsk = claudeToolEndsTheAsk(tabId, call)
    if (endsTheAsk) claudeAskEnded(tabId)
    announceNow(TOOL_DONE, { tabId, call, endsTheAsk })
  })
  tracker.on('command-output', ({ tabId, ...output }: CommandOutput & { tabId: string }) =>
    slash.output(tabId, output)
  )
  runtime.on('turn-over', ({ tabId, over }: TurnOver) => {
    ptyMgr.wakeReady(tabId)
    announceNow(TURN_OVER, { tabId, over })
    if (!over) return
    const workspace = pinnedWorkspaceOfTab(tabId)
    if (workspace) freshness?.fetchSoon(workspace)
  })
  runtime.on('status', (t: StateChanged) => {
    if (t.prev === 'approval') claudeAskEnded(t.tabId)
    ptyMgr.wakeReady(t.tabId)
    announceNow(STATE_CHANGED, t)
  })

  const userData = app.getPath('userData')
  const droppedSessionsLog = signalLog(path.join(userData, 'dropped-sessions.log'))
  const openTabsPath = path.join(userData, 'open-tabs.json')
  savedOpenTabs = readOpenTabs(openTabsPath)
  openTabsFile = new OpenTabsFile(openTabsPath, savedOpenTabs)
  sessionAccounts = new SessionAccounts(path.join(userData, 'session-accounts.json'))
  const storedDeps = {
    pty: ptyMgr,
    runtime,
    projectInfo: projectInfoOnHost,
    projectRules: rulesOf,
    workspaceInstructions: instructionsOf,
    remoteDirExists: (dir: string) => hosts.machineOf(dir)!.sessionDirThere(dir),
    remoteTreeIo: machineTreeIo,
    realFilesOn,
    changed: sessionsChanged,
    pinnedWorkspaces: () => workspaceMgr?.pinnedPathList() ?? [],
    rereadRows: () => workspaceMgr?.refresh(),
    replaced: (oldKey: string, newKey: string) => workspaceMgr?.moveResident(oldKey, newKey),
    events: (tabId: string, event: SessionEvent) => sessionBackends.observe(tabId, event),
    error: (message: string) => sendToRenderer(CH.toast.show, message),
    noAccountMessage: noAccountNow,
    koloftPrompt,
    hookRegDir: hookPaths.regDir
  }
  try {
    codexSessions = buildCodexSessions({
      file: path.join(userData, 'sessions.json'),
      ...storedDeps,
      machine: {
        instance: codexMachineInstance(userData),
        machine: (host) => hosts.machine(host),
        keyed: pinnedKeyOn,
        mirrorDir: (host) => mirrorHookDir(userData, host),
        nextPull: (host) => remoteSync?.nextPullDone(host) ?? Promise.resolve()
      },
      leftWorktree: (resource) => removeUntouchedWorktree(codexSessions, resource),
      trustFolder: trustCodexFolder,
      pickHome: pickCodexHome,
      homeOf: (sessionId) => {
        const name = sessionAccounts?.of('codex', sessionId)
        return name && codexHomeOf(userData, name)
      },
      assistOf: (cwd, resumeKey) => butler?.identityOfLaunch(cwd, resumeKey),
      skipPermissions: () => loadSettings().skipPermissions,
      replyLanguageScript: hookPaths.codexReplyLanguage,
      builtInStatusLine: () => loadSettings().statuslineBuiltin,
      browserEndpoint: relayEndpoint,
      openShimRoot: path.join(userData, 'codex-open'),
      playwrightBin,
      fallbackBin,
      gitBin: gitFirstBin,
      docsSkillsFolder: () => {
        const docs = docsPluginWhileOn()
        return docs && pluginSkills(docs)
      },
      agent: {
        enabled: agentToolsOn,
        answer: (tabId, dir, name, raw) => void agentRequests.answerFor(tabId, dir, name, raw),
        skillsFolder: () => claudeAgentPlugin && pluginSkills(claudeAgentPlugin)
      },
      gitAccounts: {
        configEnv: (env) => gitAccounts!.configEnv(env),
        ghWrapper
      }
    })
  } catch (error) {
    startupErrors.codex = `Codex session data could not be loaded; the original file is preserved. ${String(error)}`
  }
  try {
    agySessions = buildAgySessions({
      file: path.join(userData, 'agy-sessions.json'),
      ...storedDeps,
      projectInfo: projectInfoOnHost,
      remoteTreeIo: machineTreeIo,
      remote: {
        ...machineRemoteDeps,
        machine: (host) => hosts.machine(host),
        saidWhenTheMachineWantsAPasswordFirst: SIGN_IN_THROUGH_A_TAB_THAT_CAN_ASK_FIRST,
        mirrorGemini: (host) => mirrorAgyGemini(userData, host),
        nextPull: (host) => {
          if (!remoteSync) return Promise.resolve()
          const pulled = remoteSync.nextPullDone(host)
          remoteSync.pokeNow(host)
          return pulled
        }
      },
      leftWorktree: (resource) => removeUntouchedWorktree(agySessions, resource),
      openShimRoot: path.join(userData, 'agy-open'),
      scriptsDir: path.join(userData, 'agy-scripts'),
      ownersGemini,
      pickHome: pickAgyHome,
      apiKeyOf: agyApiKeyOf,
      builtInStatusLine: () => (loadSettings().statuslineBuiltin ? agyStatusline : undefined),
      skipPermissions: () => loadSettings().skipPermissions,
      assistOf: (cwd, resumeKey) => butler?.identityOfLaunch(cwd, resumeKey),
      browserEndpoint: relayEndpoint,
      playwrightBin,
      fallbackBin,
      gitBin: gitFirstBin,
      agent: {
        enabled: agentToolsOn,
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
      .catch((error) => sendToRenderer(CH.toast.show, String(error)))
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
      .catch((error) => sendToRenderer(CH.toast.show, String(error)))
  }
  for (const stored of [codexSessions, agySessions])
    if (stored) void watchHistoryOf(stored).catch(() => undefined)
  const runningBindings = (): Map<string, string> => {
    const m = new Map<string, string>()
    for (const s of allSessions()) if (s.alive && s.sessionId) m.set(s.sessionId, s.tabId)
    for (const stored of storedSessions())
      for (const [key, tabId] of stored.runningBindings()) m.set(key, tabId)
    for (const [tabId, t] of sleepers) if (!m.has(t.sessionId)) m.set(t.sessionId, tabId)
    return m
  }
  const remoteRunning = (host: string): Set<string> => remoteSync?.alive(host) ?? new Set()
  const workspaces = buildWorkspaces({
    agents: sessionBackends.rows,
    loadLayout,
    saveLayout,
    projectInfo: projectInfoFor,
    runningBindings,
    killTab: (tabId) => void killTabPty(tabId),
    pushRows: (payload) => {
      sendToRenderer(CH.workspace.rows, payload)
      syncAnswerable()
    },
    freshness: (wsPath) => freshness?.get(wsPath),
    pluginData: startedPlugins.github.rowData,
    gitAccount: (wsPath) => gitAccounts?.workspaceAccount(wsPath),
    gitPickable: (wsPath) => !!gitAccounts?.pickableOnMachine(wsPath),
    onRescanned: (wsPaths) => {
      void freshness?.refreshLocal(wsPaths)
      void gitAccounts?.refreshRepoKeys(wsPaths).then(() => workspaceMgr?.restampLive())
      startedPlugins.github.sweepNow()
      claudeBackend.watchRemoteHookMirrors()
    },
    jobCountFor: (wsPath) => cronRunner?.jobCountFor(wsPath) ?? 0,
    remoteRunning,
    remoteConnected: (host) => remoteSync?.connected(host) ?? false,
    remoteProblem: (host) => remoteSync?.problem(host),
    remoteGit: (host, p) => remoteSync?.gitInfo(host, p),
    remoteOrphansOf: (wsPath) => claudeStore?.remoteOrphansOf(wsPath) ?? [],
    killRemoteSession: (host, sessionId) =>
      claudeBackend.endRemoteTmux(host, tmuxSessionName(sessionId)),
    hiddenRow: (id) => sessionBackends.isKoloftsOwnSession(id),
    parentOf: (rowId) => startedSessions.parentOfRow(rowId),
    conductorsRoot: path.join(userData, 'conductors'),
    scratchRoots: scratchRootsAround(os.homedir(), os.tmpdir()),
    claimedFolder: butlersFolderClaim(userData)
  })
  workspaceMgr = workspaces
  claudeStore = buildClaudeStore({
    projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
    headCache: { file: path.join(userData, 'transcript-heads.json'), version: app.getVersion() },
    remoteProjectsRoot: (host) => mirrorProjectsRoot(userData, host),
    pinnedPaths: () => workspaces.pinnedPathList(),
    remoteTargets: () => workspaces.remoteTargets(),
    kept: workspaces.keptInLayout,
    rereadRows: () => workspaces.refresh(),
    rereadGrownRows: () => workspaces.rescanForGrowth(),
    runningBindings,
    remoteRunning,
    sessionsOnDiskOrRunning: (ids) => {
      const stillThere = (key: string): boolean => sessionBackends.sessionStillThere(key, ids)
      butler?.forgetGone(stillThere)
      attention.forgetLastRunGone(stillThere)
    },
    memberDropped: (sessionId, why) => droppedSessionsLog(`${sessionId} ${why}`)
  })
  const bindingNow = buildDiscordBinding({
    load: () => loadSettings().discord,
    save: (discord) => {
      void commitSettings({ discord })
      syncAnswerable()
      butlerHearsSoon()
    },
    saveQuietly: (discord) => void saveSettings({ discord }),
    rowsChanged: () => workspaceMgr?.refresh(),
    isButlerTab: (tabId) => !!butler?.isButlerTab(tabId)
  })
  discordBinding = bindingNow
  attention.turnTakenElsewhere = turnTakenOnDiscord
  butler = buildButler({
    userData,
    realpath: realpathSafe,
    butler: () => loadSettings().butler,
    roleFacts: () => bindingNow.butlerRoleFacts(),
    loadSession: () => loadSettings().butlerSession,
    saveSession: (butlerSession) => void commitSettings({ butlerSession }),
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
          ownerText: l.ownerText,
          conductor: true,
          permission: ownersPermission(),
          trustFolder: true,
          firstPrompt: l.firstPrompt,
          name: reachedBySendMessage(l.backend) ? asPeerName(l.title) : l.title,
          model: l.model,
          effort: l.effort
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
        permission: ownersPermission(),
        trustFolder: true,
        model: l.model,
        effort: l.effort
      })
      if (!res.ok) throw new Error(res.code === 'backend' ? res.message : couldNotStart(l.title))
      const spawned: SpawnedTab = {
        id: res.id,
        kind: l.backend,
        cwd: res.cwd,
        title: l.title,
        sessionId: l.key
      }
      sendToRenderer(CH.terminal.spawned, spawned)
      return res.id
    },
    kill: killTabFromMain,
    rowsChanged: () => workspaceMgr?.refresh(),
    toast: (text) => sendToRenderer(CH.toast.show, text),
    notice: async (text) =>
      (await handOver?.tell(butlerRecipient(), text, discordRelay?.quietMarks)) ?? false,
    news: [TODO_NEWS, GUIDE_MOVED_NEWS],
    noticeWhileOpen: async (text) =>
      (await handOver?.tell(
        butlerWhileOpen(),
        text,
        discordOn() ? discordRelay?.quietMarks : undefined
      )) ?? false,
    pluginsOn: switchesThatAct,
    pluginsNews: (changed, lines) =>
      pluginsChangedNews(
        PLUGINS.filter((p) => p.id in changed).map((p) => ({ name: p.name, on: changed[p.id] })),
        lines
      ),
    showsPromptBeforeBind,
    bindDeadlineMs: cronBindDeadlineMs()
  })
  const tabState = {
    backendOf: (tabId: string) => backendIdOf(ptyMgr.get(tabId)?.kind),
    boundKey: (tabId: string) => sessionOfTab(tabId)?.sessionId || undefined,
    status: (tabId: string) => runtime.statusOf(tabId),
    awaitsInput: (tabId: string) => runtime.awaitsInput(tabId),
    type: (tabId: string, keys: string[], stillWanted?: () => boolean) =>
      ptyMgr.type(tabId, keys, stillWanted),
    pendingApproval: (tabId: string) => storedOwnerOf(tabId)?.openApproval(tabId),
    pendingQuestion: (tabId: string) => storedOwnerOf(tabId)?.openQuestion(tabId)
  }
  const asks = buildSessionAsks({
    ...tabState,
    turnOver: (tabId) => runtime.turnOver(tabId),
    showsPromptBeforeBind,
    queueDrained: (tabId) => codexSessions?.queueDrained(tabId) ?? true,
    touchedSinceAsked: (tabId) => {
      const asked = questionSeenAt(tabId)
      return asked !== undefined && ownerTouchedSince(tabId, asked)
    },
    ownerTouchedSince,
    answerable: async (tabId) => {
      await storedOwnerOf(tabId)?.answerable?.(tabId)
    },
    answerInPlace: async (tabId, reply) => {
      return storedOwnerOf(tabId)?.answer(tabId, reply) ?? false
    },
    showsDialogsClosing: (tabId) => claudeDialogs.showsDialogsClosing(tabId),
    regDir: hookPaths.regDir
  })
  sessionAsks = asks
  const waitsBesidesInstructions = (tabId: string): boolean =>
    runtime.statusOf(tabId) === 'approval' || !!secretAsks?.views().some((a) => a.tabId === tabId)
  const ownerWaits = {
    waitsOnTheOwner: (tabId: string) => attention.waitsOnTheOwner(tabId, attentionSubjectOf(tabId)),
    ownerAnswered: (tabId: string) => {
      if (!instructionAsks?.asking(tabId) && !waitsBesidesInstructions(tabId))
        attention.ownerAnswered(tabId)
    }
  }
  const secrets = buildSecretAsks({ owner: ownerWaits })
  const instructions = buildInstructionAsks({
    show: (asks) => pushToSessions.instructionAsks(asks),
    owner: ownerWaits,
    told: (text) => sendToRenderer(CH.toast.show, text)
  })
  instructionAsks = instructions
  const link = buildDiscordLink({
    lockFile: path.join(userData, 'discord.lock'),
    pidAlive,
    owner: () => bindingNow.owner(),
    foundAppOwner: (owner) => bindingNow.setOwner(owner),
    openButler: () => void butler?.open(),
    postFailed: (channelId, error) => {
      const channel = bindingNow.channel()
      const name = channel?.channelId === channelId ? channel.name : channelId
      sendToRenderer(CH.toast.show, `Koloft could not post to #${name} in Discord: ${error}`)
    }
  })
  discordLink = link
  const butlerNow = butler
  const roomsNow = buildRooms({
    link,
    owner: () => bindingNow.owner(),
    lobby: () => bindingNow.channel(),
    rooms: () => bindingNow.rooms(),
    save: (list) => bindingNow.saveRooms(list)
  })
  rooms = roomsNow
  buildOldThreads({
    link,
    owner: () => bindingNow.owner(),
    butlerName: butlerNameNow,
    channel: () => bindingNow.channel(),
    archived: () => bindingNow.oldThreadsArchived(),
    markArchived: () => bindingNow.markOldThreadsArchived(),
    isRoom: (threadId) => !!roomsNow.ofThread(threadId),
    now: Date.now
  })
  buildButlerTyping({
    link,
    channelOf: (tabId) =>
      discordRelay?.reaches(tabId) && !discordRelay.quietTurn(tabId)
        ? bindingNow.channelOfTab(tabId)
        : undefined,
    status: (tabId) => runtime.statusOf(tabId),
    alive: (tabId) => !!ptyMgr.get(tabId)?.alive
  })
  const buttons = buildAskButtons({
    owner: () => bindingNow.owner(),
    dialogText: async (tabId) => (await dialogOf(tabId))?.text,
    answer: answerSession,
    respond: (i, body) => link.respond(i, body),
    followUp: (i, privateText) => link.followUp(i, privateText),
    edit: (placed, card) => link.editCard(placed.channelId, placed.messageId, card)
  })
  asks.listen({
    asksChanged: (tabId) => {
      ptyMgr.wakeReady(tabId)
      void buttons.check(tabId)
      showAskOnItsRow(tabId)
      void ownerAsleep.asks(tabId)
    },
    answered: (tabId, reply) => buttons.answered(tabId, reply)
  })
  const cards = buildSecretCards({
    asks: secrets,
    owner: () => bindingNow.owner(),
    place: async (tabId, card, files) => {
      const channelId = roomOfTab(tabId) ?? bindingNow.channel()?.channelId
      if (!channelId) return undefined
      const [name] = await Promise.all([
        secretAskerName(tabId),
        files?.length ? link.upload(channelId, files, '') : undefined
      ])
      const messageId = (await link.card(channelId, card(name))).at(-1)
      return messageId ? { channelId, messageId, name } : undefined
    },
    edit: (placed, card) => link.editCard(placed.channelId, placed.messageId, card),
    respond: (i, body) => link.respond(i, body)
  })
  secrets.listen(cards)
  secretAsks = secrets
  const instructionCardsNow = buildInstructionCards({
    asks: instructions,
    owner: () => bindingNow.owner(),
    place: async (tabId, card) => {
      const channelId = roomOfTab(tabId) ?? bindingNow.channel()?.channelId
      if (!channelId) return undefined
      const name =
        butlerSide(tabId) || roomOfTab(tabId)
          ? (discordRelay?.askerName(tabId) ?? butlerNameNow())
          : await secretAskerName(tabId)
      const messageId = (await link.card(channelId, card(name))).at(-1)
      return messageId ? { channelId, messageId, name } : undefined
    },
    edit: (placed, card) => link.editCard(placed.channelId, placed.messageId, card),
    respond: (i, body) => link.respond(i, body)
  })
  instructions.listen(instructionCardsNow)
  instructionCards = instructionCardsNow
  buildInteractions({
    owner: () => bindingNow.owner(),
    ownerWrote: ownerCameBack,
    submit: (i) => cards.submit(i),
    respond: (i, body) => link.respond(i, body)
  })
  const attachmentsDir = path.join(userData, 'discord-attachments')
  const handOverNow = messaging.handOver(tabState, asks)
  handOver = handOverNow
  discordRelay = buildDiscordRelay({
    ...tabState,
    asks,
    handOver: handOverNow,
    link,
    download: async (url) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Discord answered ${res.status} to an attachment download.`)
      return Buffer.from(await res.arrayBuffer())
    },
    owner: () => bindingNow.owner(),
    ownerAway,
    ownerWrote: ownerCameBack,
    butlerName: butlerNameNow,
    replyChannelOf: phoneChannelOf,
    askChannelOf: askChannelOfTab,
    inRoom: (tabId) => !!roomOfTab(tabId),
    helperTitle: (tabId) =>
      butlerNow.isButlerTab(tabId) ? undefined : (sessionOfTab(tabId)?.title ?? 'helper'),
    withButtons: (tabId, view, card) => buttons.attach(tabId, view, card),
    askPlaced: (card, at) => buttons.placed(card, at),
    attachmentsDir
  })
  asks.watchAsks()
  awayDigest = buildDigest({
    away: ownerAway,
    lastHandsAt: () => presence.lastHandsAt(),
    reachable: () => discordConnected() && !!bindingNow.channel(),
    marks: () => attention.list(),
    butlerSide,
    inRoom: (tabId) => !!roomOfTab(tabId),
    instructionsCard: (tabId) =>
      waitsBesidesInstructions(tabId) ? undefined : instructionCardsNow.onDiscord(tabId),
    touchedBeforeLeaving: () => touchedBefore(presence.lastHandsAt()),
    judging: (tabId) => newsJudge.judging(tabId),
    sessionOf: (mark) => {
      const s = sessionOfTab(mark.tabId)
      const workspace = sessionBackends.workspaceOfTab(mark.tabId)
      return {
        title: s?.title ?? mark.title,
        sessionId: s?.sessionId ?? mark.sessionId,
        workspace: workspace && path.basename(workspace)
      }
    },
    butlerBusy: () => {
      const tab = butlerNow.liveTab()
      return handOverNow.delivering(BUTLER_RECIPIENT) || (!!tab && !asks.takesCommand(tab))
    },
    tell: (text) => handOverNow.tell(butlerRecipient(), text, discordRelay?.quietMarks),
    now: Date.now,
    gatherMs: cronTestMs('KOLOFT_AWAY_DIGEST_MS', DIGEST_GATHERS_MS)
  })
  const digest = awayDigest
  setInterval(() => {
    digest.marked()
    void ownerAsleep.reconcile()
  }, AWAY_CHECKED_EVERY_MS).unref()
  void ownerAsleep.reconcile()
  const pruneAttachments = (): void => pruneStale(attachmentsDir, ATTACHMENTS_KEPT_MS, true)
  pruneAttachments()
  setInterval(pruneAttachments, ATTACHMENTS_PRUNED_EVERY_MS).unref()
  void startDiscord()
  remoteSync = new RemoteSync({
    run: (host, cmd) =>
      loginEnvReady().then(() => runSsh(host, cmd, { controlDir: remoteControlDir })),
    rsync: (host, r, l, extra) =>
      loginEnvReady().then(() => rsyncPull(host, r, l, extra, { controlDir: remoteControlDir })),
    listen: (host, cmd, onLine, onEnd) =>
      listenOverSsh(host, cmd, { controlDir: remoteControlDir }, onLine, onEnd),
    targets: () => {
      const codexMachines = new Set(codexSessions?.machinesWithTabs())
      const live = new Set(codexMachines)
      const agentTabsOn = new Set<string>()
      const shellTabsOn = new Map<string, string[]>()
      for (const h of ptyMgr.list()) {
        if (!h.alive) continue
        if (h.remoteHost) {
          live.add(h.remoteHost)
          agentTabsOn.add(h.remoteHost)
        }
        if (h.utilMachine) {
          live.add(h.utilMachine)
          shellTabsOn.set(h.utilMachine, [...(shellTabsOn.get(h.utilMachine) ?? []), h.id])
        }
      }
      const busy = new Set(
        allSessions().flatMap((s) => {
          const host = s.alive && machineOfTab(s.tabId)
          return host && (s.status === 'working' || s.status === 'approval') ? [host] : []
        })
      )
      return (workspaceMgr?.remoteTargets() ?? []).map((t) => ({
        host: t.host,
        ...syncMirrorsOf(t, userData, codexMachines, codexSessions, agySessions),
        paths: t.paths,
        hasTabs: live.has(t.host),
        agentTabs: agentTabsOn.has(t.host),
        busy: busy.has(t.host),
        shellTabs: shellTabsOn.get(t.host)
      }))
    },
    onChange: (host) => {
      tracker.fillMachineScratchpads(host)
      workspaceMgr?.onRemoteChanged()
    },
    onLeft: (host, ids) => sessionBackends.noticeRemoteExits(host, ids),
    onHooksPulled: (host) => sessionBackends.mirrorPulled(host),
    onShells: (host, shells) => {
      for (const s of shells) ptyMgr.shellOnMachineSaid(host, s.tabId, s.name, s.cwd)
    },
    onToolShells: (host, outputs) => tracker.toolShellsOnMachineSaid(host, outputs),
    onConnected: (host) => void freshness?.machineUp(host),
    onConnectedRound: (host) => {
      void pageForwards.checkMaster(host)
      void browserTunnels.sync(
        host,
        ptyTabIds()
          .filter((id) => remoteHostOfTab(id) === host)
          .map((tabId) => ({ tabId, endpoint: relayEndpoint(tabId) }))
      )
    }
  })
  ptyMgr.on('typed', (tabId: string) => {
    const host = machineOfTab(tabId) ?? ptyMgr.get(tabId)?.utilMachine
    if (host) remoteSync?.typedInto(host)
  })
  freshness = new GitFreshnessEngine({
    workspaces: pinnedPathsChecked,
    autoFetch: () => loadSettings().gitAutoFetch,
    autoPull: () => loadSettings().gitAutoPull,
    busy: (wsPath) => busyInCheckout(allSessions(), wsPath) > 0,
    toast: (text) => sendToRenderer(CH.toast.show, text),
    onChange: () => workspaceMgr?.restampLive(),
    onDefaultMoved: (move) => void sessionSync.defaultMoved(move, syncSessionsOf(allSessions())),
    runner: (wsPath) => {
      const key = parseRemoteKey(wsPath)
      return key && !remoteSync?.connected(key.host) ? null : hosts.of(wsPath).freshness
    },
    fetchFailed: (wsPath, stderr) => gitAccounts?.fetchFailed(wsPath, stderr)
  })
  claudeStore.start()
  workspaceMgr.start()
  freshness.start()
  startedPlugins.github.followSwitch()
  ensureControlDir(remoteControlDir)
  remoteSync.start()

  cronRunner = buildCronRunner({
    now: () => Date.now(),
    bootTime: BOOT_TIME,
    userData,
    pinnedPaths: () => workspaceMgr?.pinnedPathList() ?? [],
    isPinned: (p) => workspaceMgr?.isPinned(p) ?? false,
    dirExists: (p) => hosts.of(p).dirExists(p),
    gitDirExists: (root) => hosts.of(root).dirExists(`${root}/.git`),
    worktreeDirExists: (root, name) => hosts.of(root).dirExists(`${worktreeHomeOf(root)}/${name}`),
    worktreeRecorded: (root, name) =>
      sessionBackends.worktreeRecords.recorded(`${worktreeHomeOf(realpathSafe(root))}/${name}`),
    branchExists: (root, branch) => branchExists(hostGitOut, root, branch),
    listRunFolders,
    runLeftovers,
    tidyRun,
    foldersInUse,
    quitting: () => quitCommitted,
    turnedOff: turnedOffNow,
    noUsableAccount: (backend) => sessionBackends.noUsableAccount(backend),
    trusted: (wsPath, backend) => sessionBackends.get(backend).trustsFolder(wsPath),
    ready: () => rendererReady && BrowserWindow.getAllWindows().length > 0,
    launch: launchCronRun,
    killTab: (tabId) => void killTabPty(tabId),
    stillWorking: runOrASessionItStartedStillWorks,
    whatIsLeft: whatClosingTheRunWouldLose,
    closeForGood: closeTheRunFully,
    tellToCarryOn: async (tabId) => {
      if (attention.outlivesKoloft(tabId)) return 'outlived'
      await tabReady(tabId, RESUMED_TAB_READY_MS, false)
      return (await sessionCommand.tellFromKoloft(tabId, A_RESTART_CUT_THE_RUN_OFF))
        ? 'told'
        : 'undelivered'
    },
    turnUnderWay: (tabId) => {
      const status = runtime.statusOf(tabId)
      return status === 'working' || status === 'approval'
    },
    toast: (text) => sendToRenderer(CH.toast.show, text),
    notify: notifyPlain,
    killed: (tabId) => sendToRenderer(CH.tab.killedByMain, tabId),
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

  registerIpc()
  setupAppMenu(
    (action, from) => {
      if (action === 'toggle-keep-awake') {
        commitSettings({ keepAwake: !loadSettings().keepAwake })
        return
      }
      if (
        pageRouting.keptBySignInWindow(
          from,
          action === 'close-tab' || action === 'close-session' ? 'closes-it' : 'acts-on-the-app'
        )
      )
        return
      if (hiddenByClose) return
      sendToRenderer(MENU_SHORTCUT_CHANNEL[action])
    },
    (cmd, from) => {
      if (
        pageRouting.keptBySignInWindow(
          from,
          cmd === 'browser-close-tab' ? 'closes-it' : 'acts-on-its-page'
        )
      )
        return
      if (hiddenByClose) return
      sendToRenderer(CH.shortcut.browser, cmd)
    },
    loadSettings().keepAwake
  )
  holdMacAwake(loadSettings().keepAwake)

  pageTools.watchKeys()

  // PLATFORM§20
  powerMonitor.on('resume', requestWebglRepair)
  powerMonitor.on('unlock-screen', requestWebglRepair)
  powerMonitor.on('lock-screen', () => {
    presence.screenLocked()
    awayDigest?.marked()
    discordRelay?.checkHeld()
    instructionCards?.checkHeld()
  })
  powerMonitor.on('resume', () => void freshness?.sweep({ host: null }))
  // PLATFORM§3
  powerMonitor.on('resume', () => cronRunner?.onResume())
  screen.on('display-added', requestWebglRepair)
  screen.on('display-removed', requestWebglRepair)
  screen.on('display-metrics-changed', requestWebglRepair)

  markKeyAccountsSavedOnDisk()
  createWindow()
  takeErrorsNobodyCaught()
  startUpdateNotifier((offer) => sendToRenderer(CH.update.offer, offer))

  probeOnceTheRendererIsUp = launchUsageProbe(listAccounts())

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) showMainWindow(mainWindow)
    else createWindow()
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
  if (!sendToRenderer(CH.app.quitRequested)) return false
  clearQuitFallback()
  quitFallback = setTimeout(() => {
    quitFallback = null
    approveAndRun(() => app.quit())
  }, QUIT_ANSWER_GRACE_MS)
  return true
}
setQuitAsk(askQuit)

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
  if (!quitCommitted) {
    rememberOpenTabs()
    browserTunnels.cancelOnQuit()
    pageForwards.cancelOnQuit()
  }
  quitCommitted = true
  guard?.liftAllBeforeQuitting()
  const waitsForAnAgent = sessionBackends.holdsQuitUntilAgentsEnded(
    () => app.quit(),
    (backend, error) =>
      console.error(`[koloft] ${BACKEND_LABEL[backend]} did not stop cleanly:`, error)
  )
  if (waitsForAnAgent) {
    e.preventDefault()
    return
  }
  for (const { leaving } of claudeTabExits.values()) {
    if (leaving?.claudePid && leaving.treeRoot)
      finishAfterKoloftQuits(leaving.claudePid, leaving.treeRoot)
  }
  claudeTabExits.clear()
  endAgyOneShots(path.join(app.getPath('userData'), 'agy-one-shots'))
  stopScheduledTasks()
  discordLink?.stop()
  discordBinding?.flush()
  workspaceMgr?.dispose()
  claudeStore?.dispose()
  flushLayout()
  flushSettings()
  openTabsFile?.flushSync()
  sessionAccounts?.flushSync()
  savedUsage.flushSync()
  savedHomeUsage.flushSync()
  sessionBackends.flushSync()
  flushAttention()
  flushInbox()
  freshness?.stop()
  remoteSync?.stop()
  gitAccounts?.stop()
  closeAllDirWatchers()
  resetQuitGuard()
})

app.on('quit', () => ptyMgr.killWhatOutlivesTheQuit())

function setupLine(playwrightBin?: string): string | undefined {
  if (!ptyMgr.shimDir) return undefined
  const dirs = playwrightBin ? `${ptyMgr.shimDir}:${playwrightBin}` : ptyMgr.shimDir
  return `export PATH="${dirs}:$PATH"; hash -r 2>/dev/null; clear`
}

const processedOpenIds = new Set<string>()

function watchOpenRequests(openDir: string): fs.FSWatcher | null {
  const handle = (obj: unknown, full: string): void => handleOpenRequest(obj as OpenDrop, full)
  return watchAndSweepJsonDrops(
    openDir,
    () => handle,
    undefined,
    () => true
  )
}

function setupSecretLanding(): void {
  webPages.onEveryWebPage((contents) => {
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame) secretAsks?.navigationStarted(contents.id, details.url)
    })
    contents.on('did-navigate', (_e, url) => secretAsks?.navigated(contents.id, url))
  })
}

function setupGuestForwardsEnd(): void {
  webPages.onEveryWebPage((contents) => {
    const id = contents.id
    contents.once('destroyed', () => {
      webPages.pageGone(id)
      pageForwards.pageGone(id)
    })
  })
}

function setupPermissionCleanup(): void {
  webPages.onEveryWebPage((contents) => sitePermissions.pageOpened(contents))
}

const boundSessions = new Map<string, string>()
const screenAsks = new Map<string, (a: ScreenAnswer) => void>()
const unexpectedExits = new Map<string, string>()
let agentExitLog: ((line: string) => void) | undefined
let windowOpenedAt = 0

function unexpectedExitHeading(h: PtyHandle, e: TerminalExit): string {
  const how = e.signal ? `was killed by signal ${e.signal}` : `exited with code ${e.exitCode}`
  const where = h.remoteHost ? `${h.remoteHost}:${h.cwd}` : h.cwd
  const after = Math.round((Date.now() - h.startedAt) / 1000)
  return `${h.kind} tab ${h.id} ${how} in ${where}, ${after}s after it started; its last screen:`
}

function logUnexpectedExit(screen: UnexpectedExitScreen): void {
  const heading = unexpectedExits.get(screen.id)
  if (!heading) return
  unexpectedExits.delete(screen.id)
  agentExitLog ??= signalLog(path.join(app.getPath('userData'), 'agent-exits.log'))
  agentExitLog([heading, ...screen.lines.map((l) => `  | ${l}`)].join('\n'))
}
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
    terminalOutput.flush(tabId)
    sendToRenderer(CH.terminal.screen, request)
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

function agentTabIds(): string[] {
  return ptyMgr.list().flatMap((p) => (p.alive && !p.util && p.kind !== 'shell' ? [p.id] : []))
}

const browserControlOps: PluginStartDeps['browser-control']['cdpOps'] = {
  anotherLiveKoloftOwns: (tabId) => anotherLiveInstanceOwns(tabId, pidAlive),
  sessionForTab: (tabId) => sessionOfTab(tabId)?.sessionId ?? null,
  cameThroughAForward: (guestId, url) => {
    const port = loopbackPortOf(url)
    return port !== null && pageForwards.carries(guestId, port)
  }
}

const workbenchPages: PluginStartDeps['workbench']['pages'] = {
  activeTab: () => uiActiveTabId,
  machineOfTab,
  openExternally: openUrlExternally,
  allowFullscreen: allowPageFullscreenWithoutTheWindow,
  driverOf: (guestId) => sessionDrivingGuest(guestId),
  drivenFromAnotherMachine: (guestId) => guestDrivenFromAnotherMachine(guestId),
  openAsDrivingAgentsTab: (guestId, url) => cdpOps.openAsDrivingAgentsTab(guestId, url),
  handsOn: handsOnKoloft,
  mainWindow: () => mainWindow,
  showMainWindow,
  showSignInWindows: !BACKGROUND_TEST,
  savePickOn: (machine, name, png) => hosts.machine(machine).savePick(name, png),
  savePickOnThisMac,
  underTest: BACKGROUND_TEST,
  heldElsewhere: () => secretAsks?.pagesHeld() ?? [],
  ownerDriven: (tabId) => relayAttached(tabId)
}

// PLATFORM§8
function allowPageFullscreenWithoutTheWindow(callback: (granted: boolean) => void): void {
  const win = mainWindow
  win?.setFullScreenable(false)
  callback(true)
  setImmediate(() => {
    if (win && !win.isDestroyed()) win.setFullScreenable(true)
  })
}

// ADR-0045
const MACHINE_PAGE_HEADERS = {
  'content-security-policy':
    'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock allow-presentation'
}

async function bytesOfAFileHere(file: string): Promise<Buffer | null> {
  const machine = parseRemoteKey(file)?.host
  if (machine && !workspaceMgr?.remoteTargets().some((t) => t.host === machine)) return null
  return hosts
    .of(file)
    .readBytes(file)
    .catch(() => null)
}

function bodyOf(data: Buffer): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

async function machinePageResponse(request: Request): Promise<Response> {
  const page = machinePageOf(request.url)
  const body = page && (await bytesOfAFileHere(formatRemoteKey(page.host, page.path)))
  if (!page || !body)
    return new Response(fileNotFoundHtml(page?.path ?? request.url), {
      status: 404,
      headers: { ...HTML_HEADERS, ...MACHINE_PAGE_HEADERS }
    })
  return new Response(bodyOf(body), {
    headers: { 'content-type': mimeOf(page.path), ...MACHINE_PAGE_HEADERS }
  })
}

const FRAME_LOADS = new Set(['mainFrame', 'subFrame'])

// ADR-0045
function machinePageRequestRefused(details: Electron.OnBeforeRequestListenerDetails): boolean {
  if (!machinePageOf(details.url) || FRAME_LOADS.has(details.resourceType)) return false
  return !machinePageOf(details.frame?.url ?? '')
}

function fenceRequest(
  details: Electron.OnBeforeRequestListenerDetails,
  callback: (response: Electron.CallbackResponse) => void
): void {
  const guest = details.webContentsId
  const fenced =
    guest !== undefined
      ? guestDrivenFromAnotherMachine(guest)
      : details.initiatorOrigin !== undefined &&
        originDrivenFromAnotherMachine(details.initiatorOrigin)
  if (!fenced) return callback({})
  if (FRAME_LOADS.has(details.resourceType)) notePageOpenedForAMachine(details.url)
  if (details.url.startsWith('file:') || machinePageOf(details.url))
    return callback({ cancel: true })
  void reachesThisMacsServer(details.url).then((cancel) => callback({ cancel }))
}

// ADR-0046 PLATFORM§12 PLATFORM§33
async function loopbackOnTheMachine(
  details: Electron.OnBeforeRequestListenerDetails,
  guest: number,
  machinePort: number,
  host: string
): Promise<Electron.CallbackResponse> {
  if (!aPageOnTheMachineAsks(details.resourceType, details.initiatorOrigin)) return { cancel: true }
  const frame = FRAME_LOADS.has(details.resourceType)
  if (frame && guestDrivenFromAnotherMachine(guest)) notePageOpenedForAMachine(details.url)
  const macPort = await pageForwards.macPortFor(host, machinePort, guest, frame)
  if (!webContents.fromId(guest)) pageForwards.pageGone(guest)
  if (macPort === null) return { cancel: true }
  const there = onMacPort(details.url, macPort)
  if (there === details.url) return {}
  return details.resourceType === 'webSocket' ? { cancel: true } : { redirectURL: there }
}

// ADR-0045 ADR-0046
function setupPageShotPartition(): void {
  const ses = shotSession()
  ses.protocol.handle(MACHINE_PAGE_SCHEME, machinePageResponse)
  ses.webRequest.onBeforeRequest((details, callback) => {
    const page = details.webContentsId
    const host = machineOfShotPage(page)
    const fromMachine = machinePageOf(details.url)
    if (fromMachine && (fromMachine.host !== host || machinePageRequestRefused(details)))
      return callback({ cancel: true })
    const machinePort = loopbackPortOf(details.url)
    if (page === undefined || !host || machinePort === null) return callback({})
    void loopbackOnTheMachine(details, page, machinePort, host).then(callback, () =>
      callback({ cancel: true })
    )
  })
  onShotPageGone((page) => pageForwards.pageGone(page))
}

// PLATFORM§39 PLATFORM§12
function routePageRequest(
  details: Electron.OnBeforeRequestListenerDetails,
  callback: (response: Electron.CallbackResponse) => void
): void {
  if (
    webPageReachesDiscordDesktopApp(details.url, details.initiatorOrigin) ||
    machinePageRequestRefused(details)
  )
    return callback({ cancel: true })
  const guest = details.webContentsId
  const machinePort = loopbackPortOf(details.url)
  if (guest === undefined || machinePort === null || !workspaceMgr?.remoteTargets().length)
    return fenceRequest(details, callback)
  void webPages
    .reportedOwner(guest)
    .then((owner) => {
      const host = owner ? webPages.machineOfOwner(owner) : undefined
      return host ? loopbackOnTheMachine(details, guest, machinePort, host) : null
    })
    .then(
      (answer) => (answer ? callback(answer) : fenceRequest(details, callback)),
      () => callback({ cancel: true })
    )
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
    if (decision?.dest === 'browser') pageRouting.sendOverlayOpen(decision.target, 'background')
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
    pushToPages.open(payload)
    return true
  }
  if (decision.dest === 'preview' && fs.existsSync(decision.target)) {
    const payload: OpenRequest = { tabId, path: decision.target, source, view }
    pushOpenRequest(payload)
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
  const page = routeFor(keyed, 'agent')
  if (page.dest === 'browser') return openInWorkbench(tabId, page, 'agent')
  const payload: OpenRequest = { tabId, path: keyed, source: 'agent', view }
  pushOpenRequest(payload)
  return true
}

async function isRegularFile(file: string): Promise<boolean> {
  const stat = await fs.promises.stat(file).catch(() => null)
  return !!stat?.isFile()
}

function killTabFromMain(tabId: string): void {
  sendToRenderer(CH.tab.killedByMain, tabId)
  void killTabPty(tabId)
}

function killTabPty(tabId: string, restarting = false): Promise<boolean> {
  if (!restarting) cronRunner?.tabClosed(tabId, !!ptyMgr.get(tabId)?.alive)
  const sleeper = sleepers.get(tabId)
  if (sleeper) {
    forgetSleeper(tabId)
    const tree = projectInfoFor(sleeper.cwd).treeRoot
    const resource = restarting ? undefined : sessionBackends.worktreeRecords.at(sleeper.kind, tree)
    if (!restarting) cronRunner?.onTabGone({ treeRoot: tree, sessionId: sleeper.sessionId })
    return (
      resource ? removeUntouchedWorktree({ id: sleeper.kind }, resource) : Promise.resolve()
    ).then(() => true)
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
  tabLifecycle.emit('stopping', tabId, restarting)
  boundSessions.delete(tabId)
  return stopped.then(
    () => true,
    (error) => {
      sendToRenderer(CH.toast.show, String(error))
      return false
    }
  )
}

function archiveSession(id: string): boolean {
  const archived = sessionBackends.archive(id)
  if (archived) {
    koloftInbox.sessionGone(id, 'Its session was deleted')
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

const hostGitOut: GitOut = (dir, ...rest) => hosts.of(dir).gitOut(dir, ...rest)
const mergedHeads: MergedHeads = (dir, branch) => hosts.of(dir).github.mergedHeads(dir, branch)

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

const TAB_HAS_UNSAVED_EDITS = 'its Workbench has unsaved edits'
const TAB_ASKED_A_QUESTION_NOBODY_ANSWERED = 'it asked you a question nobody answered'

async function whatClosingWouldLose(
  target: ClosableSession,
  info: ProjectInfo | undefined,
  waitUntil: number
): Promise<string[]> {
  if (target.tabId && dirtyTabIds.has(target.tabId)) return [TAB_HAS_UNSAVED_EDITS]
  // CODEX§20
  const asked =
    target.tabId && codexSessions?.questionWentUnanswered(target.tabId)
      ? [TAB_ASKED_A_QUESTION_NOBODY_ANSWERED]
      : []
  let left = await leftOnceRemovalsEnd(target, info, waitUntil)
  if (left.length && treeRemovals.has(target.treeRoot))
    left = await leftOnceRemovalsEnd(target, info, waitUntil)
  return [...asked, ...left]
}

async function leftOnceRemovalsEnd(
  target: ClosableSession,
  info: ProjectInfo | undefined,
  waitUntil: number
): Promise<string[]> {
  if (!(await treeRemovals.settledWithin(target.treeRoot, waitUntil - Date.now())))
    return [
      `Koloft is still deleting the worktree ${target.treeRoot}. Close the session again in a minute.`
    ]
  const tree = await closingTree(hostGitOut, info ?? projectInfoFor(target.treeRoot))
  if (!tree) return []
  const sharing = aliveSessionsIn(tree.treeRoot, target.tabId)
  return [
    ...sharing.map((s) => `The session "${s.title}" is still open in ${tree.treeRoot}.`),
    ...leftText(await whatIsLeft(hostGitOut, tree, mergedHeads))
  ]
}

function tellTheOwner(text: string): void {
  sendToRenderer(CH.toast.show, text)
  if (handOver && ownerAway()) void handOver.tell(butlerRecipient(), `[Koloft] ${text}`)
}

async function closeSessionFully(
  target: ClosableSession,
  info?: ProjectInfo,
  tell = tellTheOwner
): Promise<boolean> {
  workspaceMgr?.hideWhileClosing(target.sessionId)
  try {
    await treeRemovals.settled(target.treeRoot)
    const where = info ?? projectInfoFor(target.treeRoot)
    const close = (): Promise<boolean> => endAndRemove(target, where, tell)
    return await (where.worktreeName ? treeRemovals.run(where.treeRoot, close) : close())
  } finally {
    workspaceMgr?.closingEnded(target.sessionId)
  }
}

async function endAndRemove(
  target: ClosableSession,
  info: ProjectInfo,
  tell: (text: string) => void
): Promise<boolean> {
  const tabId = target.tabId ?? sleepers.tabOf(target.sessionId)
  if (tabId) {
    sendToRenderer(CH.tab.killedByMain, tabId)
    await killTabPty(tabId)
  } else if (allSessions().some((s) => s.alive && s.sessionId === target.sessionId)) {
    tell(`${target.title} was opened again, so Koloft did not close it.`)
    return false
  }
  const tree = await closingTree(hostGitOut, info)
  const alreadyRemoved =
    !!tree && !tree.branches.length && !(await hosts.of(info.treeRoot).dirExists(info.treeRoot))
  const leftSinceTheCheck =
    tabId && tree && !alreadyRemoved
      ? leftText(await whatIsLeft(hostGitOut, tree, mergedHeads))
      : []
  if (leftSinceTheCheck.length) {
    tell(
      `Koloft ended ${target.title} but did not close it: it left this after Koloft checked.\n${leftSinceTheCheck.join('\n')}`
    )
    return false
  }
  const problem = tree && !alreadyRemoved && (await removeTree(hostGitOut, tree))
  if (problem) {
    tell(
      `Koloft could not finish closing ${target.title}. ${problem}\nOnce that is dealt with, close the session again.`
    )
    return false
  }
  archiveSession(target.sessionId)
  sessionBackends.worktreeRecords.forgetUnusedAt(info.treeRoot)
  // CC§9
  closedSessionsStoppedUntil.set(
    target.sessionId,
    Date.now() + LEFTOVERS_OF_A_CLOSED_SESSION_STOPPED_FOR_MS
  )
  void refreshLeftovers(() => sharedProcessTable.fresh())
  return true
}

async function removeUntouchedWorktree(
  owner: { readonly id: BackendId } | null | undefined,
  resource: WorktreeResource
): Promise<void> {
  const tree = resource.worktreePath
  if (sleeperTrees().includes(tree) || cronRunner?.tidiesFolder(tree)) return
  if (sessionBackends.occupantOf(tree)) return
  if (!owner || !(await sessionBackends.worktreeRecords.untouched(owner.id, resource))) return
  if (treeRemovals.has(tree)) return
  const problem = await treeRemovals.run(tree, () =>
    removeTree(hostGitOut, {
      root: resource.originalCwd,
      treeRoot: tree,
      worktreeName: resource.worktreeName,
      branches: [`worktree-${resource.worktreeName}`]
    })
  )
  if (problem && (await hosts.of(tree).dirExists(tree))) sendToRenderer(CH.toast.show, problem)
}

function cronRunTree(root: string, worktree?: string): ProjectInfo {
  return worktree
    ? { root, treeRoot: `${worktreeHomeOf(root)}/${worktree}`, worktreeName: worktree }
    : { root, treeRoot: root }
}

const NO_SESSION_FOR_THE_RUN = "Koloft cannot find this run's session."
const NO_SESSION_TO_CLOSE = 'Koloft cannot find this session in the list.'
const ON_ANOTHER_MACHINE =
  'It runs on another machine, where Koloft cannot check what closing it would lose.'
const THE_OWNERS_AI = 'It is your AI helper, which Koloft keeps open.'

function closableInTab(sessionId: string, tabId: string): ClosableSession | string {
  const live = sessionOfTab(tabId)
  if (live?.sessionId && live.sessionId !== sessionId) return NO_SESSION_TO_CLOSE
  const found = live?.sessionId ? live : closableSessions().find((s) => s.sessionId === sessionId)
  if (!found || (found.tabId && found.tabId !== tabId)) return NO_SESSION_TO_CLOSE
  if (hostOfTab(tabId) === 'ssh' || isRemoteKey(found.treeRoot)) return ON_ANOTHER_MACHINE
  if (isButlerNow(tabId)) return THE_OWNERS_AI
  return { ...found, sessionId, tabId }
}

function closeOrTell(target: ClosableSession, tell: (text: string) => void): Promise<boolean> {
  return closeSessionFully(target, undefined, tell).catch((error) => {
    tell(`${target.title}: ${String(error)}`)
    return false
  })
}

async function whatClosingTheRunWouldLose(
  tabId: string,
  root: string,
  worktree?: string
): Promise<string[]> {
  const session = sessionOfTab(tabId)
  if (!session) return [NO_SESSION_FOR_THE_RUN]
  return whatClosingWouldLose(
    session,
    cronRunTree(root, worktree),
    Date.now() + A_REMOVAL_UNDER_WAY_IS_WAITED_FOR_MS
  )
}

async function runOrASessionItStartedStillWorks(tabId: string): Promise<boolean> {
  if (await runtime.stillWorking(tabId)) return true
  const runSession = sessionOfTab(tabId)
  if (!runSession?.sessionId) return false
  const started = allSessions().filter(
    (s) =>
      s.alive &&
      s.tabId !== tabId &&
      !asksTheOwner(s.tabId) &&
      startedSessions.startedBy(s, runSession)
  )
  const working = await Promise.all(started.map((s) => runtime.stillWorking(s.tabId)))
  return working.some(Boolean)
}

const A_RESTART_CUT_THE_RUN_OFF =
  'Koloft restarted while this scheduled run was working, which also stopped any helper or command you had running in the background. Carry on with the task: check what got done, start again what was cut off, and finish it.'

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
  const result = await treeRemovals.run(info.treeRoot, () =>
    tidyTree(hostGitOut, info, (d) => hosts.of(d).dirExistsOrThrow(d), mergedHeads)
  )
  if (result.removed) sessionBackends.worktreeRecords.forgetUnusedAt(info.treeRoot)
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
  more: Pick<SpawnedTab, 'jobId' | 'launch'> = {}
): Promise<string | null> {
  const r = await sessionBackends.create(await withPastedPicturesOnItsMachine(options))
  if (!r.ok) return null
  const spawned: SpawnedTab = { id: r.id, kind: options.kind, cwd: r.cwd, title, ...more }
  sendToRenderer(CH.terminal.spawned, spawned)
  return r.id
}

function forgetShellOnMachine(host: string, tabId: string): void {
  void runSsh(host, remoteShCommand(`rm -f "${remoteShellPidFile('$1')}"`, [tabId]), {
    controlDir: remoteControlDir
  }).catch(() => undefined)
}

const RESUMES_AT_ONCE = 4

function restoreOpenTabs(): string | undefined {
  if (openTabsRestoreStarted || !workspaceMgr) return undefined
  openTabsRestoreStarted = true
  const plan = restorePlan(savedOpenTabs, workspaceMgr.residentIds())
  let activeAsleep: string | undefined
  for (const t of plan.asleep) {
    const id = sleepers.addRestored(t)
    if (t.sessionId === savedOpenTabs.active) activeAsleep = id
  }
  const awake = [...plan.awake.map((t) => t.sessionId), ...plan.keepRunningOnly]
  cronRunner?.expectReopened(awake)
  void resumeAwake(awake, savedOpenTabs.active).finally(() => {
    openTabsRestored = true
    rememberOpenTabs()
    cronRunner?.reopeningOver()
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
    const reopenedTab = resumed?.ok && ptyMgr.get(resumed.tabId)?.alive ? resumed.tabId : undefined
    cronRunner?.reopenedIn(id, reopenedTab)
    if (!resumed?.ok) {
      if (resumed) sendToRenderer(CH.toast.show, resumed.error)
      return
    }
    const ranUnder = savedOpenTabs.tabs.find((t) => t.sessionId === id)?.tabIds
    if (ranUnder && reopenedTab) carryTabIds(reopenedTab, ranUnder)
    if (id === active) pushToSessions.activateTab(resumed.tabId)
    await tabReady(resumed.tabId, RESUMED_TAB_READY_MS, false)
  }
  await mapAtMost(ids, RESUMES_AT_ONCE, resumeOne)
}

function couldNotStart(title: string, reason?: string): string {
  return `Could not start “${title}” — ${reason || 'click it to try again.'}`
}

// CC§11
async function resumeRow(
  row: SessionRow,
  { rebuildGoneWorktree }: { rebuildGoneWorktree: boolean }
): Promise<{ ok: true; tabId: string } | { ok: false; error: string }> {
  const plan = await sessionBackends.resumePlan(row.id)
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
  const res = await sessionBackends.resume({
    sessionId: row.id,
    cwd: plan.action === 'rebuild' ? plan.resumeCwd : plan.cwd,
    mode: plan.action
  })
  if (!res.ok) {
    return { ok: false, error: couldNotStart(row.title, res.code === 'backend' ? res.message : '') }
  }
  const spawned: SpawnedTab = {
    id: res.id,
    kind: row.backendId,
    cwd: res.cwd,
    title: row.title,
    sessionId: row.id
  }
  sendToRenderer(CH.terminal.spawned, spawned)
  return { ok: true, tabId: res.id }
}

function showsPromptBeforeBind(tabId: string): boolean {
  return sessionBackends.showsPromptBeforeBind(tabId)
}

function boundAndSettled(tabId: string, turnEnded: boolean): boolean {
  return (
    !!sessionOfTab(tabId)?.sessionId &&
    runtime.statusOf(tabId) !== undefined &&
    (!turnEnded || runtime.turnOver(tabId))
  )
}

function tabReady(tabId: string, ms: number, turnEnded: boolean): Promise<boolean> {
  return ptyMgr.whenReady(tabId, () => boundAndSettled(tabId, turnEnded), ms)
}

// AGY§8
function tabTypable(tabId: string, ms: number, turnEnded: boolean): Promise<boolean> {
  return ptyMgr.whenReady(
    tabId,
    () => showsPromptBeforeBind(tabId) || boundAndSettled(tabId, turnEnded),
    ms
  )
}

function tabBound(tabId: string, ms: number): Promise<boolean> {
  return ptyMgr.whenReady(tabId, () => !!sessionOfTab(tabId)?.sessionId, ms)
}

async function secretAskerName(tabId: string): Promise<string> {
  if (butler?.isButlerTab(tabId)) return butlerNameNow()
  const s = sessionOfTab(tabId)
  const name = (await discordShownName(s)) ?? s?.title ?? 'A session'
  const workspace = sessionBackends.workspaceOfTab(tabId)
  return workspace ? `${name} · ${scopeName(workspace)}` : name
}

const LOOPBACK_OPEN_TIMEOUT_MS = 15_000

// CODEX§15
async function openSignInEndOn(host: string | undefined, url: string): Promise<string> {
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
    remoteAnswerCommand(
      `curl -sS -o /dev/null -w '%{http_code}' --max-time ${LOOPBACK_OPEN_TIMEOUT_MS / 1000} ${shq(url)}`
    ),
    { controlDir: remoteControlDir, timeoutMs: LOOPBACK_OPEN_TIMEOUT_MS * 2 }
  )
  return r.stdout.trim() || `nothing (${r.stderr.trim()})`
}

function guestPagesOf(tabId: string): (WebPage & { reload(): Promise<void> })[] {
  return webPages.pagesOf(tabId).map((wc) => ({
    guestId: wc.id,
    url: () => wc.getURL(),
    // PLATFORM§10
    run: async (script: string) => {
      await compositionDone()
      return await wc.executeJavaScript(script)
    },
    reload: () =>
      new Promise<void>((resolve) => {
        wc.once('did-stop-loading', () => resolve())
        wc.reload()
      })
  }))
}

function discordHelperBackend(butlerBackend: BackendId): BackendId {
  const methods = loadSettings().sessionMethods
  return methods.enabled[butlerBackend]
    ? butlerBackend
    : effectiveBackend(methods, new Set(SESSION_BACKENDS))
}

function butlerNameNow(): string {
  return loadSettings().butler.name
}

function ownersPermission(): 'bypass' | 'default' {
  return loadSettings().skipPermissions ? 'bypass' : 'default'
}

const OWNER_IS: Record<OwnerWhere, string> = {
  asleep: '(Koloft: the owner is asleep right now.)',
  away: '(Koloft: the owner is away from the Mac right now.)',
  'at-the-mac': '(Koloft: the owner is at the Mac right now.)'
}

function ownerIsWhere(): string {
  return OWNER_IS[presence.where()]
}

const AN_ASK_KOLOFT_READS_SHOWS_WITHIN_MS = 2000

function askUnreadablySoon(tabId: string): void {
  if (!roomOfTab(tabId)) return
  if (storedOwnerOf(tabId)) return discordRelay?.asksUnreadably(tabId)
  setTimeout(() => {
    if (runtime.statusOf(tabId) === 'approval') discordRelay?.asksUnreadably(tabId)
  }, AN_ASK_KOLOFT_READS_SHOWS_WITHIN_MS)
}

const touchedAt = new Map<string, number>()
const ownerTouchedAt = new Map<string, number>()
const questionSeen = new Map<string, { asks: string; at: number }>()

function questionSeenAt(tabId: string): number | undefined {
  const open = storedOwnerOf(tabId)?.openQuestion(tabId)
  if (!open) return undefined
  const asks = JSON.stringify(open.questions)
  const seen = questionSeen.get(tabId)
  if (seen?.asks === asks) return seen.at
  const at = Date.now()
  questionSeen.set(tabId, { asks, at })
  return at
}

// CC§14
function touchesADialog(tabId: string, data: string): boolean {
  if (pressesAKey(data)) return true
  return clicksTheMouse(data) && backendIdOf(ptyMgr.get(tabId)?.kind) === 'claude'
}

function ownerTouchedTheScreen(tabId: string): void {
  questionSeenAt(tabId)
  ownerTouchedAt.set(tabId, Date.now())
}

function ownerTouchedSince(tabId: string, at: number): boolean {
  return (ownerTouchedAt.get(tabId) ?? 0) >= at
}
const TOUCHED_BEFORE_LEAVING_WITHIN_MS = 30 * 60_000

function ownerTouched(tabId: string): void {
  if (!backendIdOf(ptyMgr.get(tabId)?.kind)) return
  touchedAt.set(tabId, Date.now())
  rooms?.handsOn(tabId)
}

function touchedBefore(left: number): string[] {
  return [...touchedAt].flatMap(([tabId, at]) => {
    const title = ptyMgr.get(tabId)?.alive && sessionOfTab(tabId)?.title
    return title && at >= left - TOUCHED_BEFORE_LEAVING_WITHIN_MS && !butlerSide(tabId)
      ? [title]
      : []
  })
}

function rowOfKey(key: string | undefined): SessionRow | undefined {
  return (workspaceMgr?.rows() ?? []).flatMap((w) => w.rows).find((r) => r.id === key)
}

const BUTLER_RECIPIENT = 'butler'

function butlerWhileOpen(): Recipient {
  return {
    ...butlerRecipient(),
    open: async () => {
      const tab = butler?.liveTab()
      if (!tab) throw new Error(`${butlerNameNow()} is closed.`)
      return tab
    }
  }
}

function butlerRecipient(): Recipient {
  return {
    key: BUTLER_RECIPIENT,
    ownerIsWhere,
    name: butlerNameNow(),
    liveTab: () => butler?.liveTab(),
    open: async () => {
      const opened = await butler?.open()
      if (!opened) throw new Error(STILL_STARTING)
      if (!opened.ok) throw new Error(opened.error)
      butler?.firstWordsComing(opened.tabId)
      return opened.tabId
    }
  }
}

function typeCommandInto(t: Target, text: string, to: SlashReplyTo): string {
  const target = (tabId: string): SlashTarget => ({ name: t.name, tabId, overseer: !!t.overseer })
  if (t.tabId) return slash.run(target(t.tabId), text, to)
  void t
    .open()
    .then((tabId) => slash.typeWhenIdle(target(tabId), text, to))
    .catch((error: unknown) => to.say(`⚠ ${errorText(error)}`))
  return `${t.name} is closed; Koloft resumes it, types ${text} once it is ready, and will ${to.where}.`
}

function fromPalette(
  { words, pictures, backend, about, at }: PaletteRequest,
  rules: string | undefined
): string {
  const where = at ? ` (The owner was in the workspace ${at} at the time.)` : ''
  const routed = about ? ` (Koloft took this to be about the workspace ${about}.)` : ''
  const agent = ` (The owner picked ${BACKEND_LABEL[backend]} for it: a session you start for it runs with --backend ${backend}.)`
  const picks = about && rules ? projectRulesForTheButler(about, rules) : ''
  return withPictures(
    `The owner typed this in ⌘P: ${words}${where}${routed}${agent}${picks}`,
    pictures
  )
}

async function startHelper(
  task: (butler: SessionInfo) => HelperTask
): Promise<ConductorOpenResult> {
  // AGY§8
  const opened = await butler?.open(A_HELPER_HAS_IT)
  if (!opened) return { ok: false, error: STILL_STARTING }
  if (!opened.ok) return opened
  const parent = (await tabReady(opened.tabId, cronBindDeadlineMs(), false))
    ? sessionOfTab(opened.tabId)
    : undefined
  if (!parent) return { ok: false, error: `${butlerNameNow()} did not get ready in time.` }
  const tabId = await sessionCommand.startHelper(parent, task(parent))
  return tabId ? { ok: true, tabId } : { ok: false, error: 'Koloft could not start a helper.' }
}

async function handFromPalette(request: PaletteRequest): Promise<ConductorOpenResult> {
  const prompt = fromPalette(request, request.about && (await rulesOf(request.about)))
  return startHelper(() => ({
    prompt,
    name: request.title,
    ownerWords: request.words,
    backend: request.backend
  }))
}

function butlerTarget(ref: string): Target | undefined {
  const all = butler
  if (!all?.isButler(ref)) return undefined
  const tabId = all.liveTab()
  return {
    key: 'butler',
    name: butlerNameNow(),
    backend:
      (tabId && backendIdOf(ptyMgr.get(tabId)?.kind)) || assistRowBackend('butler', loadSettings()),
    remote: false,
    tabId,
    overseer: true,
    open: async () => {
      const opened = await all.open()
      if (!opened.ok) throw new Error(opened.error)
      return opened.tabId
    }
  }
}

async function cronPick(req: LaunchRequest): Promise<OwnPickResolved> {
  const job = { model: req.model, effort: req.effort }
  const filled =
    job.model && job.effort
      ? undefined
      : cronPickFor(req.backend, job, await defaultsOfProjects.of(req.cwd))
  return ownPick(req.backend, filled ?? job)
}

async function launchCronRun(req: LaunchRequest): Promise<LaunchResult> {
  try {
    const { pick, note } = await cronPick(req)
    const options: CreateTabOptions & { kind: BackendId } = {
      kind: req.backend,
      cwd: req.cwd,
      worktree: req.worktree,
      ...pick,
      permission: req.permission,
      firstPrompt: req.firstPrompt,
      name: req.name,
      scheduled: true
    }
    const tabId = await launchQuietTab(options, req.name, { jobId: req.jobId })
    return tabId ? { ok: true, tabId, ...(note && { note }) } : { ok: false }
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
  recorded: (dir) => sessionBackends.worktreeRecords.recorded(dir),
  ...gitProbes(localGitOut)
}

function commitSettings(patch: Partial<Settings>): Settings {
  const s = saveSettings(patch)
  sendToRenderer(CH.settings.update, s)
  updateDockBadge(attention.list())
  setRelayEnabled(s.browserControl, ptyTabIds())
  presence.asleepSinceIs(s.ownerAsleepSince)
  holdMacAwake(s.keepAwake)
  return s
}

function holdMacAwake(keepAwake: boolean): void {
  const asleep = presence.asleep()
  applyKeepAwake(keepAwake || asleep)
  setKeepAwakeChecked(keepAwake || asleep, !asleep)
}

const BAD_GIT_STEP: { ok: false; reason: string } = { ok: false, reason: 'bad request' }

const githubOptions: GithubReposOptions = {
  fixture: parseGithubFixture(process.env.KOLOFT_GITHUB_FIXTURE),
  gh: async (args, root) => {
    await loginEnvReady()
    return (await gitAccounts?.machineGh(root, args)) ?? runGh(args, await gitAccounts?.ghEnv(root))
  }
}

const hosts = new Hosts(
  localHost(new GithubRepos(githubOptions), {
    agentHomes: () => ({
      codexHome: path.dirname(codexSharedConfig())
    })
  }),
  (machine) =>
    new SshHost(machine, {
      run: (cmd, opts) =>
        loginEnvReady().then(() =>
          runSshBytes(machine, cmd, { controlDir: remoteControlDir, ...opts })
        ),
      sshEnvReady: loginEnvReady,
      watch: (p, onChange, reportsWhatChangedWhileUnwatched) =>
        remoteSync?.watch(machine, p, onChange, reportsWhatChangedWhileUnwatched),
      unwatch: (p) => remoteSync?.unwatch(machine, p),
      shell: (dir) => {
        ensureControlDir(remoteControlDir)
        return {
          spawnCwd: os.homedir(),
          shell: POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE,
          launchCommand: (tabId) => {
            const tabDir = tabPackageDir(app.getPath('userData'), tabId)
            writeTabPassFile(tabDir, tabId)
            return utilShellLine({
              host: machine,
              sshOptions: sshOptions(remoteControlDir, false),
              machine: machinePackage(),
              tabId,
              dir,
              tabDir
            })
          }
        }
      },
      github: githubOptions,
      tabs: {
        userData: app.getPath('userData'),
        controlDir: remoteControlDir,
        machinePackage,
        alive: () => remoteSync?.alive(machine) ?? new Set(),
        firstHeartbeatDone: () => remoteSync?.firstRoundDone(machine) ?? Promise.resolve(),
        loginPath: () => gitAccounts?.machineLoginPath(machine) ?? Promise.resolve('')
      }
    })
)

const claudeBackendDeps: PluginStartDeps['sessions']['claude'] = {
  pty: ptyMgr,
  hosts,
  launchHere: {
    writeConductorMarker: (tabId, role) => writeConductorMarker(hookRegDir ?? '', tabId, role),
    handOverOwnerWords: (tabId, words) =>
      seedHandedOverOwnerWords(saidFile(hookRegDir ?? '', tabId), words),
    agentPlugin: () => (agentToolsOn() ? claudeAgentPlugin : undefined),
    docsPlugin: docsPluginWhileOn,
    assistOf: (cwd, resumeKey) => butler?.identityOfLaunch(cwd, resumeKey),
    pastedPicturesDir
  },
  launchOnMachine: {
    realPath: (machine, p) => workspaceMgr?.realRemotePath({ host: machine, path: p }) ?? p,
    settings: loadSettings,
    pickAccount: (launchKey, resumeSessionId) =>
      pickMachineAccount(() => pickForLaunch(launchKey, resumeSessionId)),
    noAccountMessage: () => noAccountNow('claude'),
    agentTools: agentToolsOn,
    docsWritingOn,
    hookSettings: (tabId, dir, allowKoloft) =>
      machineHookSettings(tabId, dir, loadSettings().statuslineBuiltin, allowKoloft)
  },
  remoteTargets: () => workspaceMgr?.remoteTargets() ?? [],
  sessionRebound: (prevId, nextId, source) => workspaceMgr?.onSessionRebind(prevId, nextId, source),
  remoteSync: () => remoteSync,
  projectRules: rulesOf,
  workspaceInstructions: instructionsOf,
  userData: () => app.getPath('userData'),
  setupLine: () => setupLine(playwrightCliBin),
  hookSettings: (tabId, allowKoloft, conductor, playwrightServers) =>
    writeHookSettings?.(tabId, allowKoloft, conductor, playwrightServers),
  playwrightMcp: async (cwd) =>
    loadSettings().browserControl ? ownersClaudePlaywrightMcp(cwd) : [],
  ptysChanged: () => writeRelayEnv(ptyTabIds()),
  resumeProbes,
  events: (tabId, event) => sessionBackends.observe(tabId, event),
  messaged: (tabId, fromSessionId) => sessionCommand.messaged(tabId, fromSessionId),
  error: (message) => sendToRenderer(CH.toast.show, message),
  machineOfTab,
  otherTabOnMachine: (machine, tmuxName, launchTab) =>
    storedSessions()
      .map((s) => s.tabOnMachine?.(machine, tmuxName, launchTab))
      .find(Boolean)
}

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
    CH.terminal.create,
    async (_e, opts: CreateTabOptions): Promise<CreateTabResult> => {
      if (opts.kind !== 'shell')
        return sessionBackends.create(
          await withPastedPicturesOnItsMachine(await withOwnDefaults(opts))
        )
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
        utilMachine: opts.util === true ? parseRemoteKey(requested)?.host : undefined,
        ownerTabId: typeof opts.ownerTabId === 'string' ? opts.ownerTabId : undefined
      })
      if (handle.utilMachine) remoteSync?.typedInto(handle.utilMachine)
      writeRelayEnv(ptyTabIds())
      return { ok: true, id: handle.id, cwd: launch.cwd }
    }
  )

  ipcMain.on(CH.terminal.write, (_e, id: string, data: string) => {
    const live = sleepers.liveTabOf(id)
    if (ownerTyped(data)) void guard?.free(live)
    if (ownerTyped(data) && data.includes('\r')) ownerCameBack()
    if (ownerTyped(data)) ownerTouched(live)
    if (touchesADialog(id, data)) ownerTouchedTheScreen(live)
    sleepers.write(id, data)
  })
  ipcMain.handle(
    CH.machine.free,
    (_e, tabId: string) => guard?.free(sleepers.liveTabOf(tabId)) ?? false
  )
  ipcMain.handle(CH.machine.now, () => guard?.state() ?? null)
  ipcMain.handle(CH.terminal.paste, (_e, id: string, text: string, typedAfter?: string) => {
    const live = sleepers.liveTabOf(id)
    void guard?.free(live)
    if (typedAfter?.includes('\r')) ownerCameBack()
    ownerTouched(live)
    ownerTouchedTheScreen(live)
    if (sleepers.heldPaste(id, text, typedAfter)) return
    return ptyMgr.paste(live, text, typedAfter)
  })
  ipcMain.on(CH.terminal.copy, (_e, text: unknown) => {
    if (typeof text === 'string' && text) clipboard.writeText(text)
  })
  ipcMain.on(CH.terminal.ack, (_e, id: string, ackedUtf16Units: unknown) =>
    terminalOutput.ack(id, ackedUtf16Units)
  )
  ipcMain.on(CH.terminal.attach, (_e, id: string) => terminalOutput.attach(id))
  ipcMain.on(CH.terminal.onScreen, (_e, id: unknown, onScreen: unknown) => {
    if (typeof id === 'string' && typeof onScreen === 'boolean')
      terminalOutput.onScreen(id, onScreen)
  })
  ipcMain.handle(CH.terminal.flowStats, () => terminalOutput.stats())
  ipcMain.on(
    CH.terminal.resize,
    (_e, id: string, cols: number, rows: number, sessionScreen: unknown) => {
      ptyMgr.resize(id, cols, rows)
      const fitted = sessionScreen === true && usableSessionScreen({ cols, rows })
      if (fitted) ptyMgr.sessionScreen = fitted
    }
  )
  ipcMain.on(CH.terminal.sessionScreen, (e) => {
    e.returnValue = ptyMgr.sessionScreen ?? null
  })
  ipcMain.on(
    CH.terminal.kill,
    (_e, id: string, restarting: unknown) => void killTabPty(id, restarting === true)
  )
  ipcMain.on(CH.tabs.moved, (_e, oldTabId: unknown, newTabId: unknown) => {
    if (typeof oldTabId !== 'string' || typeof newTabId !== 'string') return
    ptyMgr.moveOwner(oldTabId, newTabId)
    startedSessions.moved(oldTabId, newTabId)
    sessionCommand.tabMoved(oldTabId, newTabId)
    koloftInbox.rebound(oldTabId, newTabId)
    cronRunner?.tabMoved(oldTabId, newTabId)
    webPages.tabMoved(oldTabId, newTabId)
    secretAsks?.rehome(oldTabId, newTabId)
    instructionAsks?.rehome(oldTabId, newTabId)
    if (!sleepers.has(oldTabId) && sleepers.liveTabOf(oldTabId) === oldTabId) {
      carryTabIds(newTabId, tabIdsOf(oldTabId))
      earlierTabIds.delete(oldTabId)
    }
  })

  ipcMain.handle(CH.tabs.list, (): TabInventoryReply => {
    rendererReady = true
    if (probeOnceTheRendererIsUp) {
      void LAUNCH_PROBES[probeOnceTheRendererIsUp]().catch(() => {})
      probeOnceTheRendererIsUp = null
    }
    const activeAsleep = restoreOpenTabs()
    cronRunner?.onRendererReady()
    const active = activeAsleep ?? activeTabBeforeReload
    activeTabBeforeReload = null
    if (process.env.KOLOFT_TEST_NO_ADOPT === '1') return { tabs: [], activeTabBeforeReload: null }
    // CC§7
    const ptys = ptyMgr.list().filter((h) => !loginWatchers.has(h.id) && !sleepers.has(h.id))
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

  ipcMain.handle(CH.update.check, () => checkForUpdates())
  ipcMain.handle(CH.update.download, () =>
    downloadAndInstall((p) => sendToRenderer(CH.update.progress, p))
  )
  ipcMain.on(CH.update.restart, () => restartApp())
  ipcMain.handle(CH.update.offer, () => currentOffer())
  ipcMain.on(CH.update.openRelease, () => pageRouting.sendOverlayOpen(releasePageUrl(), 'now'))

  ipcMain.handle(CH.accounts.list, () => accountViews())
  ipcMain.handle(
    CH.accounts.add,
    (
      _e,
      name: string,
      kind: AccountKind,
      secret: string,
      endpoint?: { baseUrl: string; model?: string }
    ) => addAccount(name, kind, secret, endpoint)
  )
  ipcMain.handle(CH.accounts.remove, async (_e, name: string, kind: AccountKind) => {
    if (keepsSecretInKeychain(kind) && !(await keychainDelete(kind, name))) return false
    forgetAccount(name, kind)
    return true
  })
  ipcMain.handle(CH.accounts.toggle, (_e, name: string, kind: AccountKind, enabled: boolean) => {
    setAccountEnabled(name, kind, enabled === true)
    pushAccounts()
  })
  ipcMain.handle(CH.accounts.probe, () => probeAllForPanel())
  ipcMain.handle(CH.accounts.startLogin, async (_e, name: string, reauth?: boolean) => {
    const v = reauth
      ? findAccount(name, 'oauth')
        ? 'ok'
        : 'unknown'
      : validateNewAccount(name, 'oauth')
    if (v !== 'ok') return v
    claudeBackend.forgetAvailability()
    const installFirst = !(await claudeBackend.availability()).available
    for (const id of loginWatchers.keys()) cancelGuidedLogin(id)
    startGuidedLogin(name, installFirst)
    return 'ok'
  })
  ipcMain.handle(
    CH.accounts.signIn,
    async (_e, kind: unknown, name: string, again?: boolean): Promise<SignInResult> =>
      isSignInFolderKind(kind)
        ? signInToHome(kind, name, again === true)
        : { ok: false, error: 'invalid-name' }
  )
  ipcMain.handle(CH.accounts.signInFailure, () => signInFailure)
  ipcMain.on(CH.accounts.dismissSignInFailure, () => setSignInFailure(null))
  ipcMain.handle(CH.accounts.codexUseReset, (_e, name: string) => codexUseReset(name))
  ipcMain.on(CH.accounts.cancelLogin, () => {
    for (const id of [...loginWatchers.keys()]) cancelGuidedLogin(id)
  })

  ipcMain.handle(CH.settings.get, () => loadSettings())
  ipcMain.handle(CH.app.version, () => app.getVersion())
  ipcMain.handle(CH.settings.set, (_e, patch) => commitSettings(sanitizeSettingsPatch(patch)))

  const cancellableAssist = async <T>(
    id: number,
    ask: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const run = new AbortController()
    assistRuns.set(id, run)
    try {
      return await ask(run.signal)
    } finally {
      assistRuns.delete(id)
    }
  }
  ipcMain.handle(CH.assist.route, async (_e, id: unknown, message: unknown) => {
    if (typeof id !== 'number' || typeof message !== 'string' || !workspaceMgr) return null
    const mgr = workspaceMgr
    return cancellableAssist(id, (signal) =>
      routeSession(
        { rows: projectRows, worktrees: (p) => mgr.worktrees(p), assist },
        message,
        signal
      )
    )
  })
  ipcMain.handle(CH.assist.nameWorktree, async (_e, id: unknown, task: unknown) => {
    if (typeof id !== 'number' || typeof task !== 'string') return null
    return cancellableAssist(id, (signal) => worktreeNameForTask(task, assist, signal))
  })
  ipcMain.on(CH.assist.cancel, (_e, id: unknown) => {
    if (typeof id === 'number') assistRuns.get(id)?.abort()
  })
  const addWorkspacePath = (p: string): WorkspaceAddResult | undefined => {
    const r = workspaceMgr?.add(p)
    const remote = parseRemoteKey(p)
    if (remote && r?.code === 'added') remoteSync?.pokeNow(remote.host)
    return r
  }
  const historyPartlyUnread = (id: BackendId, error: unknown): void => {
    sendToRenderer(
      CH.toast.show,
      `${BACKEND_LABEL[id]} history could not be read. Showing the rest. ${String(error)}`
    )
  }
  const pinWorkspace = (p: string): WorkspaceAddResult | undefined => {
    const r = addWorkspacePath(p)
    if (r?.code === 'added') void gitAccounts?.autoPickNewWorkspace(p)
    return r
  }
  ipcMain.handle(CH.workspace.add, (_e, p: string) => pinWorkspace(p))
  ipcMain.handle(CH.workspace.pinRecent, async (_e, paths: unknown) => {
    if (!workspaceMgr || !Array.isArray(paths)) return
    const pinned = paths.flatMap((p) => {
      const r = typeof p === 'string' ? pinWorkspace(p) : undefined
      return r && 'path' in r ? [r.path] : []
    })
    await workspaceMgr.whenScanned()
    const now = Date.now()
    const unread = new Map<BackendId, unknown>()
    const lists = await Promise.allSettled(
      pinned.map((p) => sessionBackends.historyRows(p, (id, error) => unread.set(id, error)))
    )
    for (const [id, error] of unread) historyPartlyUnread(id, error)
    sessionBackends.adopt(
      lists.flatMap((l) => (l.status === 'fulfilled' ? rowsToAdopt(l.value, now) : []))
    )
    await workspaceMgr.whenScanned()
    if (lists.some((l) => l.status === 'rejected')) throw new Error('history unread')
  })
  const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const isGitPlatform = (v: unknown): v is GitPlatform => GIT_PLATFORMS.includes(v as GitPlatform)
  ipcMain.handle(CH.gitAccounts.list, () => gitAccounts?.views() ?? [])
  const machineOf = (v: unknown): string | undefined => (isText(v) ? v : undefined)
  ipcMain.handle(
    CH.gitAccounts.loginStart,
    (_e, platform: unknown, url: unknown, machine: unknown) =>
      gitAccounts && isGitPlatform(platform) && typeof url === 'string'
        ? gitAccounts.loginStart(platform, url, machineOf(machine))
        : { ok: false, error: 'bad-url' }
  )
  ipcMain.on(CH.gitAccounts.loginCancel, () => gitAccounts?.loginCancel())
  ipcMain.on(CH.gitAccounts.loginBrowser, () => gitAccounts?.loginBrowser())
  ipcMain.handle(CH.gitAccounts.addToken, (_e, add: Partial<GitTokenAdd> | undefined) =>
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
  ipcMain.handle(CH.gitAccounts.remove, (_e, id: unknown, machine: unknown, anyway: unknown) =>
    isText(id) ? gitAccounts?.remove(id, machineOf(machine), anyway === true) : undefined
  )
  ipcMain.handle(CH.gitAccounts.makeDefault, (_e, id: unknown, machine: unknown) =>
    isText(id) ? gitAccounts?.makeDefault(id, machineOf(machine)) : undefined
  )
  ipcMain.handle(CH.gitAccounts.check, () => gitAccounts?.checkAll())
  ipcMain.handle(CH.gitAccounts.pick, (_e, wsPath: unknown, id: unknown) =>
    isText(wsPath) && (id === null || isText(id))
      ? gitAccounts?.pick(wsPath, id).then(() => void freshness?.fetchNow(wsPath))
      : undefined
  )
  ipcMain.handle(CH.gitAccounts.suggest, (_e, wsPath: unknown, network: unknown) =>
    isText(wsPath) && gitAccounts ? gitAccounts.suggest(wsPath, network === true) : { kind: 'none' }
  )
  ipcMain.handle(CH.gitAccounts.dismiss, (_e, wsPath: unknown) =>
    isText(wsPath) ? gitAccounts?.dismiss(wsPath) : undefined
  )
  ipcMain.handle(CH.gitAccounts.makeSshKey, (_e, wsPath: unknown) =>
    isText(wsPath) ? gitAccounts?.makeSshKey(wsPath) : undefined
  )
  ipcMain.handle(CH.gitAccounts.checkSshKey, (_e, wsPath: unknown) =>
    isText(wsPath) ? gitAccounts?.checkSshKey(wsPath) : undefined
  )
  ipcMain.handle(CH.project.create, (_e, parent: unknown, name: unknown) =>
    typeof parent === 'string' && parent && typeof name === 'string'
      ? createProject(hosts.of(parent), parent, name, addWorkspacePath)
      : { ok: false, reason: 'Pick a folder.' }
  )
  ipcMain.handle(CH.workspace.remove, (_e, p: string) => {
    const marked = markedSessionsOf(p)
    const r = workspaceMgr?.remove(p)
    if (r?.removed) {
      cronRunner?.removeWorkspace(p)
      for (const id of marked) attention.clearSession(id)
    }
    return r
  })
  ipcMain.handle(CH.workspace.removeConfirmed, async (_e, p: string) => {
    await sessionBackends.beforeWorkspaceRemoved(p)
    const marked = markedSessionsOf(p)
    workspaceMgr?.removeConfirmed(p)
    cronRunner?.removeWorkspace(p)
    for (const id of marked) attention.clearSession(id)
  })
  ipcMain.handle(CH.palette.savePicture, (_e, dataUrl: unknown) =>
    typeof dataUrl === 'string' ? savePastedPicture(dataUrl) : null
  )
  ipcMain.handle(CH.workspace.move, (_e, p: string, before: string | null) =>
    workspaceMgr?.move(p, before)
  )
  ipcMain.handle(CH.workspace.rows, async () => {
    await workspaceMgr?.firstScan
    return workspaceMgr?.rows() ?? []
  })
  ipcMain.handle(CH.workspace.discover, () => workspaceMgr?.discover() ?? [])
  ipcMain.handle(CH.workspace.fetchFreshness, (_e, p: string) => freshness?.fetchNow(p) ?? null)
  ipcMain.handle(
    CH.workspace.pull,
    (_e, p: string, expect: { branch: string; head: string }) =>
      freshness?.pull(p, expect) ?? { ok: false, reason: 'state changed' }
  )

  ipcMain.handle(CH.workspace.historyRows, (_e, p: string, opts?: { quiet: boolean }) =>
    sessionBackends.historyRows(p, opts?.quiet ? () => {} : historyPartlyUnread)
  )

  const usageCache = new UsageCache({
    cacheFile: () => path.join(app.getPath('userData'), 'usage-cache-4.json'),
    listFiles: async () => {
      await workspaceMgr?.firstScan
      const userData = app.getPath('userData')
      return listUsageFiles(claudeStore?.transcriptFiles() ?? [], [
        {
          codexHome: path.dirname(codexSharedConfig()),
          geminiDir: ownersGemini()
        },
        ...(workspaceMgr?.remoteTargets() ?? []).map(({ host }) => machineUsageDirs(userData, host))
      ])
    },
    stat: statOf,
    scan: (files, scanned, ended) => {
      // PLATFORM§4
      const worker = createUsageScanWorker({ workerData: { files } })
      worker.on('message', (file: ScannedFile) => scanned(file))
      worker.on('error', (error) => console.error('[koloft] usage read failed', error))
      worker.once('exit', ended)
    },
    codexWorkspaces: (cwds) => codexSessions?.workspacesFor(cwds) ?? cwds,
    sessionPlaces: () => {
      const claude = claudeStore?.sessionPlaces()
      const stored = new Map(storedSessions().map((s) => [s.id, s.sessionPlaces()]))
      return (backend, id, host) =>
        backend === 'claude' ? claude?.get(id) : stored.get(backend)?.(id, host)
    },
    changed: (read) => sendToRenderer(CH.usage.changed, read)
  })
  ipcMain.handle(CH.usage.read, () => usageCache.read())

  ipcMain.on(CH.app.isDev, (e) => {
    e.returnValue = !app.isPackaged
  })

  ipcMain.on(CH.app.quitApproved, () => {
    clearQuitFallback()
    approveAndRun(() => app.quit())
  })
  ipcMain.on(CH.app.quitHeld, () => {
    clearQuitFallback()
    resetQuitGuard()
    if (!mainWindow || mainWindow.isDestroyed() || !hiddenByClose) return
    showMainWindow(mainWindow)
    if (!OFF_SCREEN_TEST) app.focus({ steal: true })
  })
  ipcMain.on(CH.app.quitDeclined, () => {
    clearQuitFallback()
    declineQuit()
  })

  ipcMain.on(CH.shortcut.window, (e, cmd: WindowCommand) => applyWindowCommand(e.sender, cmd))

  ipcMain.on(CH.terminal.screenDone, (_e, answer: unknown) => {
    const a = answer as ScreenAnswer
    if (!a || typeof a.requestId !== 'string') return
    const pending = screenAsks.get(a.requestId)
    if (!pending) return
    screenAsks.delete(a.requestId)
    pending(a)
  })
  ipcMain.on(CH.terminal.unexpectedExit, (_e, screen: unknown) => {
    const s = screen as UnexpectedExitScreen
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.lines)) return
    logUnexpectedExit({ id: s.id, lines: s.lines.map(String) })
  })

  ipcMain.handle(CH.git.commit, (_e, root: unknown, message: unknown) => {
    if (typeof root !== 'string' || !root || typeof message !== 'string') return BAD_GIT_STEP
    const host = hosts.of(root)
    return commitAll((args, network) => host.gitRun(root, args, network), message)
  })
  ipcMain.handle(CH.git.push, (_e, root: unknown) => {
    if (typeof root !== 'string' || !root) return BAD_GIT_STEP
    const host = hosts.of(root)
    return pushBranch((args, network) => host.gitRun(root, args, network))
  })
  ipcMain.handle(CH.git.readiness, (_e, root: unknown) => {
    if (typeof root !== 'string' || !root) return null
    const host = hosts.of(root)
    return readReadiness((args) => host.gitRun(root, args))
  })
  ipcMain.handle(CH.window.isFullScreen, () => mainWindow?.isFullScreen() ?? false)

  ipcMain.handle(CH.workspace.pickFolder, async () => {
    const stub = process.env.KOLOFT_FILE_DIALOG_FILE
    if (stub) return takeStubbedDialogPick(stub)
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.on(CH.os.open, (_e, p: string) => {
    if (typeof p === 'string' && p) hosts.of(p).osOpen(p)
  })
  ipcMain.on(CH.os.reveal, (_e, p: string) => {
    if (typeof p === 'string' && p) hosts.of(p).reveal(p)
  })

  ipcMain.on(CH.app.home, (e) => {
    try {
      e.returnValue = fs.realpathSync(os.homedir())
    } catch {
      e.returnValue = os.homedir()
    }
  })
}

const sessionSearch = new SessionSearch({
  candidates: () => {
    const pins = workspaceMgr?.pinnedPathList() ?? []
    return [
      ...(claudeStore?.searchableRows() ?? []),
      ...storedSessions().flatMap((s) => s.searchable(pins))
    ]
  },
  backendSnippets: async (term, signal) =>
    (await Promise.all(storedSessions().map((s) => s.searchSnippets(term, signal)))).flat(),
  hidden: (id) => sessionBackends.isKoloftsOwnSession(id),
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
  send: (found) => pushToSessions.searchHits(found)
})

async function sessionPorts(tabId: string): Promise<ListeningPort[] | null> {
  const tags = [
    ...tabIdsOf(tabId),
    ...ptyMgr
      .list()
      .filter((h) => h.util && h.alive && h.ownerTabId === tabId)
      .map((h) => h.id)
  ]
  const machine = machineOfTab(tabId)
  if (!machine) return parseSessionPorts(await scanPortsHere(tags))
  const tmuxName = sessionBackends.tmuxOfTab(tabId) ?? ''
  await loginEnvReady()
  return parseSessionPorts(await scanPortsOnMachine(machine, tags, tmuxName, remoteControlDir))
}

const startedPlugins: PluginsStarted = startPlugins(
  PLUGINS,
  PLUGIN_STARTS,
  { commands, moments, ipc: pluginIpc },
  {
    sessions: {
      runtime: runtimeDeps,
      tracker: trackerDeps,
      backendLifecycle,
      backendHooks,
      claude: claudeBackendDeps,
      startedSessionsFile,
      newsJudge: newsJudgeDeps,
      slash: slashDeps,
      sleepers: sleepersDeps,
      sessionSync: sessionSyncDeps,
      attention: attentionDeps,
      session: sessionDeps,
      eachTurn: {
        askBeforeAsksAreMade: showAskOnItsRow,
        askAsItsAgentGaveIt: claudeAskOf
      },
      commands: sessionsCommands,
      eachState: {
        attention: {
          stateChanged: ({ tabId, prev, next }) =>
            attention.onStatusChange(tabId, prev, next, attentionSubjectOf(tabId))
        }
      },
      channels: {
        noteActivity: (tabId) => runtime.noteActivity(tabId),
        installed: installedBackends,
        installTool,
        list: allSessions,
        archive: archiveSession,
        setResident: (id, on) => workspaceMgr?.setResident(id, on),
        killTab: (tabId) => killTabPty(tabId),
        closingLoses: async (id, tabId) => {
          const found = closableInTab(id, tabId)
          if (typeof found === 'string') return [found]
          return whatClosingWouldLose(
            found,
            undefined,
            Date.now() + A_REMOVAL_UNDER_WAY_IS_WAITED_FOR_MS
          )
        },
        closeFully: async (id, tabId) => {
          const found = closableInTab(id, tabId)
          if (typeof found === 'string') return tellTheOwner(found)
          const left = await whatClosingWouldLose(
            found,
            undefined,
            Date.now() + A_REMOVAL_UNDER_WAY_IS_WAITED_FOR_MS
          )
          if (left.length)
            return tellTheOwner(
              `Koloft did not close ${found.title}: closing it now would lose this.\n${left.join('\n')}`
            )
          await closeOrTell(found, tellTheOwner)
        },
        leftovers: () => leftovers,
        stopLeftover: async (sessionId, pid) => {
          const stopped = await stopLeftover(sessionId, pid)
          await refreshLeftovers()
          return stopped
        },
        ports: sessionPorts,
        search: (searchId, term) => sessionSearch.start(searchId, term),
        attention: () => attention.list(),
        lookedAt: (tabId) => {
          uiActiveTabId = tabId
          lastTabTheOwnerLookedAt = tabId ?? lastTabTheOwnerLookedAt
          guard?.lookedAtChanged()
          if (tabId) runtime.noteActivity(tabId)
          if (tabId && windowFocused()) ownerSees(tabId)
          rememberOpenTabs()
        },
        readDefaults: async (workspacePath) => {
          const [defaults, listed] = await Promise.all([
            defaultsOfProjects.read(workspacePath),
            loadSettings().sessionMethods.enabled.agy
              ? listedModelsWithin('agy', THE_DIALOG_WAITS_FOR_THE_ACCOUNTS_MODELS_MS)
              : undefined
          ])
          return { defaults, familyEfforts: familyEfforts('agy', listed) }
        },
        writeDefaults: (workspacePath, raw) =>
          defaultsOfProjects.write(workspacePath, (saved) =>
            savedFromTheDialog(saved, raw, Date.now())
          ),
        saveEveryWorkspace: (text, opened) => {
          const saved = everyWorkspaceSavedByTheOwner(
            everyWorkspaceVersions(),
            text,
            opened,
            Date.now()
          )
          if (!saved.ok) return saved
          saveEveryWorkspaceVersions(saved.versions)
          return { ok: true }
        },
        worktrees: async (p) => (await workspaceMgr?.worktrees(p)) ?? [],
        dirExists: (dir) => hosts.of(dir).dirExists(dir)
      }
    },
    workbench: {
      pages: workbenchPages,
      commands: workbenchCommands,
      readerDocs: workbenchReaderDocs,
      channels: {
        files: (p) => hosts.of(p),
        base: sanitizeBase,
        notesFile: notesFileOfScope,
        pickFile: async () => {
          const stub = process.env.KOLOFT_FILE_DIALOG_FILE
          if (stub) return takeStubbedDialogPick(stub)
          if (!mainWindow) return null
          const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] })
          if (res.canceled || res.filePaths.length === 0) return null
          return res.filePaths[0]
        },
        state: (sessionId) => workspaceMgr?.workbenchState(sessionId),
        setState: (sessionId, state) => {
          if (!workspaceMgr) return
          workspaceMgr.setWorkbenchState(
            sessionId,
            sanitizeSessionWorkbench(
              state,
              isWorkspaceWorkbenchKey(sessionId)
                ? WORKSPACE_WORKBENCH_STARTS_OPEN_WHATEVER_THE_SESSION_DEFAULT
                : workspaceMgr.defaultOpen()
            )
          )
        },
        setAvailable: setWorkbenchAvailable,
        setFindAvailable,
        setSaveAvailable,
        setDirtyTabs: (ids) => {
          dirtyTabIds.clear()
          for (const id of ids) dirtyTabIds.add(id)
        }
      }
    },
    'browser-control': { cdpOps: browserControlOps },
    butler: {
      helperRole: () => helperRoleOf(loadSettings().butler),
      eachTurn: {
        tookTheTurn: (tabId) => startedPlugins.sessions.tookTheTurn(tabId),
        butlerTabChanged: syncAnswerable
      },
      channels: {
        open: () => butler?.open() ?? Promise.resolve({ ok: false, error: STILL_STARTING }),
        startFresh: () =>
          butler?.startFresh() ?? Promise.resolve({ ok: false, error: STILL_STARTING }),
        fromPalette: handFromPalette,
        butler: () => loadSettings().butler,
        save: (butler) => {
          commitSettings({ butler })
        }
      },
      ownerAsleep: ownerAsleepDeps,
      afterSleepChanged: syncAnswerable
    },
    inbox: {
      cards: inboxCards,
      koloft: inboxKoloft,
      tookTheTurn: (tabId) => startedPlugins.sessions.tookTheTurn(tabId),
      toast: (text) => sendToRenderer(CH.toast.show, text)
    },
    'scheduled-tasks': {
      command: cronCommand,
      channels: {
        skills: (workspacePath, backend) =>
          hosts.of(workspacePath).listSkills(workspacePath, backend),
        trusted: (workspacePath, backend) =>
          sessionBackends.get(backend).trustsFolder(workspacePath)
      }
    },
    github: {
      main: githubMain,
      prWorktree: async (root, pr, branch) => {
        if (!GIT_REF_RE.test(branch)) return BAD_GIT_STEP
        const host = hosts.of(root)
        const r = await addPrWorktree(
          (args, network) => host.gitRun(root, args, network),
          pr,
          branch
        )
        if (r.ok) await copyWorktreeIncludes(worktreeHomeRoot(r.dir)!, r.dir, hosts.machineOf(root))
        return r
      }
    },
    discord: {
      butlerSide,
      copyToPhone: {
        butlerName: butlerNameNow,
        machineOf: machineOfTab,
        readBytes: (file) => hosts.of(file).readBytes(file),
        fileDiff: (file) => hosts.of(file).gitFileDiff(file)
      },
      rooms: {
        isButler: isButlerNow,
        butlerFolder: butlerFolderNow
      },
      eachTurn: {
        noTurnsYet: async (key) => !(await sessionBackends.turns(key, 1).catch(() => [])).length,
        pendingAskOf,
        askUnreadablySoon
      },
      stillStarting: STILL_STARTING,
      token: { read: discordTokenRead, write: discordTokenWrite },
      pluginsOn: () => loadSettings().pluginsOn,
      setPluginsOn: (pluginsOn) => commitSettings({ pluginsOn }),
      syncAnswerable,
      rowsChanged: () => workspaceMgr?.refresh(),
      tabIds: () => ptyMgr.list().map(({ id }) => id),
      askAHelper: (prompt, ownerWords) =>
        startHelper((butler) => ({
          prompt,
          ownerWords,
          backend: discordHelperBackend(butler.backendId)
        })),
      pages: guestPagesOf,
      relayAttached: (tabId) => relayAttached(tabId),
      butlerName: butlerNameNow,
      butlerRecipient,
      typeWhenIdle: (target, command, to) => slash.typeWhenIdle(target, command, to),
      alive: (tabId) => !!ptyMgr.get(tabId)?.alive,
      liveTabOfKeys: (keys) =>
        allSessions().find((s) => s.alive && keys.includes(s.sessionId))?.tabId,
      rowOfKey,
      resume: (row) => sessionDeps.resume(row),
      findRow: (ref) => findSessionRow(sessionDeps, ref),
      backendOf: (tabId) => backendIdOf(ptyMgr.get(tabId)?.kind),
      nameOf: (tabId, backend) => sessionOfTab(tabId)?.title || `${BACKEND_LABEL[backend]} session`,
      turns: (key, n) => sessionBackends.turns(key, n),
      status: (tabId) => runtime.statusOf(tabId),
      asksTheOwner
    },
    todo: todoCommand,
    passwords: {
      secretCommand,
      pageCommand
    }
  }
)
const {
  webPages,
  sitePermissions,
  pageDialogs,
  pageRouting,
  pageTools,
  pagesInUse,
  pushOpenRequest,
  pushToPages,
  readerDocs,
  setUpBrowserPartition,
  setUpExtensions,
  compositionDone,
  fileNotFoundHtml,
  HTML_HEADERS
} = startedPlugins.workbench
const {
  cdpOps,
  cdpEnvDir,
  guestDrivenFromAnotherMachine,
  notePageOpenedForAMachine,
  originDrivenFromAnotherMachine,
  relayAttached,
  relayClientEvicted,
  relayEndpoint,
  relayEndpointOnMachine,
  relayTabRebound,
  renewRelayEndpointOnMachine,
  sessionDrivingGuest,
  setRelayEnabled,
  startRelay,
  writeRelayEnv
} = startedPlugins['browser-control']
const {
  runtime,
  tracker,
  sessionBackends,
  claudeBackend,
  subscribeTabSubsystems,
  startedSessions,
  newsJudge,
  slash,
  tabLifecycle,
  sleepers,
  sessionSync,
  attention,
  buildAsks: buildSessionAsks,
  buildInstructionAsks,
  buildHandOver,
  buildWorkspaces,
  buildClaudeStore,
  buildCodexSessions,
  buildAgySessions,
  sessionCommand,
  pushToSessions,
  agyBackend,
  machineHookSettings,
  pickMachineAccount,
  codexBackend,
  trustCodexFolder,
  A_HELPER_HAS_IT,
  writeLineInTurn,
  claudeDialog,
  codexDialog,
  isAskedCall,
  questionsOf,
  everyWorkspaceBlock,
  ownerPartsOf,
  everyWorkspaceSavedByTheOwner,
  forgetAssistMarkers,
  localNotice,
  markAnswerable,
  markOwnerAsleep,
  noteOfWhatKoloftSends,
  noteSent,
  noticeFile,
  pruneStale,
  quotedPrompt,
  saidFile,
  seedHandedOverOwnerWords,
  setupHooks,
  writeConductorMarker,
  writeTabHookSettings,
  resolveWorkspace,
  closingTree,
  leftText,
  machineUnreachable,
  removeTree,
  tidyTree,
  whatIsLeft,
  envMs,
  worktreeNameForTask,
  A_REMOVAL_UNDER_WAY_IS_WAITED_FOR_MS,
  findSessionRow,
  toCaller,
  judgeTurn,
  waitsOnOtherWork,
  savedFromTheDialog,
  workspaceBlock,
  scratchRootsAround,
  sessionsChangedIn
} = startedPlugins.sessions
const { TODO_NEWS } = startedPlugins.todo
const { koloftInbox, flushInbox } = startedPlugins.inbox
const { buildRunner: buildCronRunner, stop: stopScheduledTasks } = startedPlugins['scheduled-tasks']
const {
  buildAsks: buildSecretAsks,
  writeSudoShims,
  SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS
} = startedPlugins.passwords
const { buildButler, buildDigest, ownerAsleep } = startedPlugins.butler
const {
  channels: {
    roomOf: roomOfTab,
    askChannelOf: askChannelOfTab,
    phoneChannelOf,
    turnTakenOnDiscord
  },
  buildDiscordBinding,
  buildDiscordLink,
  buildRooms,
  buildOldThreads,
  buildButlerTyping,
  buildAskButtons,
  buildSecretCards,
  buildInstructionCards,
  buildInteractions,
  buildDiscordRelay,
  discordOn,
  startDiscord,
  followDiscordSwitch,
  discordConnected,
  commandIntoButler,
  roomNoteOfKey,
  withoutTheRelayTag,
  shotSession,
  machineOfShotPage,
  onShotPageGone,
  shootHtml
} = startedPlugins.discord
