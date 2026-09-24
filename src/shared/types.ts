export interface ProjectInfo {
  root: string
  treeRoot: string
  worktreeName?: string
}

// CC§7 CODEX§15
export type AccountKind = 'oauth' | 'apikey' | 'custom' | 'codex-home'

export type AccountStatus = 'ok' | 'expired' | 'unverified'

// CC§7
export type FableCapability = 'yes' | 'no' | 'unknown'

export const ACCOUNT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

// PLATFORM§3
export function keychainNamespace(appName: string): string {
  return /^koloft-[a-z0-9-]+$/.test(appName) ? appName : 'koloft'
}

export function keychainService(appName: string, kind: AccountKind): string {
  return keychainNamespace(appName) + keychainServiceSuffix(kind)
}

export function keychainServiceSuffix(kind: AccountKind): string {
  if (kind === 'oauth') return '-claude-oauth'
  if (kind === 'codex-home') return '-codex-home'
  return kind === 'apikey' ? '-anthropic-api' : '-custom-endpoint'
}

export interface AccountMeta {
  name: string
  kind: AccountKind
  enabled: boolean
  fable: FableCapability
  status: AccountStatus
  addedAt: number
  fableCheckedAt?: number
  baseUrl?: string
  model?: string
}

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

const SHELL_EXPORT_SAFE_MODEL_ID_RE = /^[A-Za-z0-9._:@/\-[\]]{1,64}$/

export function sanitizeAccountList(raw: unknown): AccountMeta[] {
  if (!Array.isArray(raw)) return []
  const out: AccountMeta[] = []
  const seen = new Set<string>()
  for (const a of raw as Partial<AccountMeta>[]) {
    if (!a || typeof a.name !== 'string' || !ACCOUNT_NAME_RE.test(a.name)) continue
    if (a.kind !== 'oauth' && a.kind !== 'apikey' && a.kind !== 'custom' && a.kind !== 'codex-home')
      continue
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
            model:
              typeof a.model === 'string' && SHELL_EXPORT_SAFE_MODEL_ID_RE.test(a.model)
                ? a.model
                : undefined
          }
        : {})
    })
  }
  return out
}

// PLATFORM§27
export type ProbeErrorKind = 'expired' | 'network' | 'model-unavailable' | 'unknown'

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
  // CC§7
  hasOi: boolean
  at: number
}

// CODEX§15
export interface CodexLimitWindow {
  minutes: number
  used: number
  resetsAt: number
}

export interface CodexLimits {
  windows: CodexLimitWindow[]
  at: number
}

export interface AccountView extends AccountMeta {
  usage?: UsageSnapshot
  limits?: CodexLimits
  probeError?: ProbeErrorKind
}

export type CodexSignInResult =
  | { ok: true; tabId: string; cwd: string }
  | { ok: false; error: 'invalid-name' | 'duplicate' | 'unavailable' }

export interface LoginProgress {
  phase: 'starting' | 'browser' | 'saved' | 'failed'
  name: string
  url?: string
  tail?: string
  tabId?: string
  cwd?: string
}

export interface AccountAddResult {
  ok: boolean
  error?: 'invalid-name' | 'duplicate' | 'invalid-endpoint' | ProbeErrorKind
  account?: AccountView
}

export interface Settings {
  sessionMethods: SessionMethods
  fontFamily: string
  fontSize: number
  workbenchWidth: number
  filePaneWidth: number
  browserPaneWidth: number
  fileTreeHeight: number
  sidebarWidth: number
  multiAccount: boolean
  skipPermissions: boolean
  fablePriority: boolean
  accounts: AccountMeta[]
  notifyTurnDone: boolean
  notifyApproval: boolean
  notifyExited: boolean
  notifyApprovalSound: boolean
  dockBadge: boolean
  showUsage: boolean
  // CC§6
  statuslineBuiltin: boolean
  gitAutoFetch: boolean
  // PLATFORM§17
  browserControl: boolean
  notesHeight: number
  notesFolded: boolean
  keepAwake: boolean
  worldClocks: string[]
  onboardingSeen: boolean
  hintsSeen: string[]
  hintsOff: boolean
  lastSeenVersion: string
}

export const HINT_IDS = ['workbench', 'approval', 'agent-web', 'worktree', 'github'] as const
export type HintId = (typeof HINT_IDS)[number]

export const WORLD_CLOCK_MAX = 3

export const DEFAULT_SETTINGS: Settings = {
  sessionMethods: { defaultBackend: 'claude', enabled: { claude: true, codex: true } },
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
export type HostId = 'local' | 'ssh'
export interface SessionMethods {
  defaultBackend: BackendId
  enabled: Record<BackendId, boolean>
}
export type TabKind = 'shell' | BackendId

export interface BackendAvailability {
  id: BackendId
  available: boolean
  reason?: string
  version?: string
  verified?: boolean
}

export type LaunchPermission = 'default' | 'acceptEdits' | 'bypass'

export interface CreateTabOptions {
  worktreeResourceId?: string
  kind: TabKind
  cwd?: string
  cols?: number
  rows?: number
  resumeSessionId?: string
  // CC§3
  worktree?: string
  permission?: LaunchPermission
  model?: string
  effort?: CronEffort
  firstPrompt?: string
  name?: string
  // ADR-0026
  scheduled?: boolean
  util?: boolean
  ownerTabId?: string
}

export type CreateTabResult =
  | {
      ok: true
      id: string
      sessionId?: string
      cwd: string
    }
  | { ok: false; code: 'invalid-args' }

export interface AdoptableTab {
  id: string
  kind: TabKind
  cwd: string
  sessionId?: string
  resumeSessionId?: string
  title?: string
}

export interface TabInventoryReply {
  tabs: AdoptableTab[]
  activeTabBeforeReload: string | null
}

export type PreviewKind = 'markdown' | 'image' | 'pdf'

export type FileAccess = 'read' | 'wrote'

export interface PreviewItem {
  kind?: PreviewKind
  src: string
  label: string
  access?: FileAccess
  added?: number
  removed?: number
}

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflict'

export type GitStatusMap = Record<string, GitFileStatus>

export type GitNumstatMap = Record<string, { added: number; removed: number }>

export const HIDDEN_BY_DEFAULT_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git'])

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  ignored?: boolean
}

// PLATFORM§3
export interface EditFingerprint {
  mtimeMs: number
  size: number
}

export interface EditOpenResult {
  text: string
  mtimeMs: number
  size: number
  eol: 'lf' | 'crlf'
  readOnly: null | 'notUtf8' | 'mixedEol' | 'noPerm' | 'dirNotWritable'
}

export type EditWriteResult =
  | { ok: true; mtimeMs: number; size: number }
  | {
      ok: false
      code: 'stale'
      mtimeMs: number
      size: number
      text: string | null
    }

export interface EditCreateResult {
  path: string
  mtimeMs: number
  size: number
}

export interface SearchHit {
  name: string
  path: string
  rel: string
  ignored?: boolean
}

export interface ContentHit {
  path: string
  rel: string
  line: number
  text: string
}

export type AttentionKind = 'turn-done' | 'approval' | 'exited'

export interface AttentionEvent {
  tabId: string
  kind: AttentionKind
  at: number
  title?: string
  resurrected?: boolean
}

export interface FlowStats {
  tabId: string
  sentUnits: number
  ackedUnits: number
  blocked: boolean
  paused: boolean
  inflight: number
  attached: boolean
}

// CC§8
export type SessionStatus = 'working' | 'waiting' | 'approval' | 'idle'

export interface LeftoverProcess {
  pid: number
  command: string
}

export interface BackgroundItem {
  id: string
  kind: 'agent' | 'command' | 'server' | 'monitor' | 'teammate'
  label: string
  state: 'working' | 'waiting' | 'unknown'
  ageMs?: number
}

export interface SessionUsage {
  inTok: number
  outTok: number
  cacheWriteTok: number
  cacheReadTok: number
  costUsd?: number
  todayCostUsd?: number
  todayDayKey?: string
  model?: string
  ccVersion?: string
  ctxTokens?: number
  ctxPct?: number
}

export const PLACEHOLDER_SESSION_TITLE = 'Claude session'

export const PENDING_SESSION_TITLE = 'Starting…'

export interface SessionInfo {
  cliVersion?: string
  background?: BackgroundItem[]
  backendId: BackendId
  host: HostId
  nativeSessionId?: string
  tabId: string
  sessionId: string
  title: string
  cwd: string
  treeRoot: string
  worktree?: string
  // CC§1
  relocated?: boolean
  // CC§2
  details?: {
    claude?: { jsonlPath: string | null; scratchpadDir?: string }
    codex?: { observation: 'live' | 'degraded' }
  }
  files?: PreviewItem[]
  lastTouched?: string
  lastWritten?: string
  liveWrites?: number
  account?: string
  pickedAccount?: string
  alive: boolean
  // ADR-0025
  remote?: { host: string }
  status?: SessionStatus
  usage?: SessionUsage
  updatedAt: number
}

export interface ClaudeSessionInfo extends SessionInfo {
  jsonlPath: string | null
  // CC§2
  scratchpadDir?: string
  files: PreviewItem[]
}

export interface ReleaseNotes {
  version: string
  notes: string
}

export interface DiscoveredFolder {
  path: string
  sessions: number
  mtime: number
}

export interface WhatsNew {
  current: string
  releases: ReleaseNotes[]
  omittedReleases: number
}

export interface UpdateCheckResult {
  status: 'available' | 'current' | 'restart-required'
  current: string
  latest?: string
  installed?: string
  releases?: ReleaseNotes[]
  omittedReleases?: number
  htmlUrl?: string
}

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
}

export interface OpenRequest {
  tabId: string
  path: string
  source: 'agent' | 'user'
}

export interface BrowserOpenRequest {
  tabId: string
  url: string
  source: 'agent' | 'user'
  osFallback?: string
}

export const BROWSER_PARTITION = 'persist:koloft-browser'

export const CHROME_WEB_STORE_URL = 'https://chromewebstore.google.com/'

export interface GithubInfo {
  repoUrl: string
  pullsUrl: string
  branch: string | null
  pr: number | null
  pending: boolean
  failed: boolean
}

export type GithubTarget = 'repo' | 'pulls' | 'pr'

// PLATFORM§15
export interface ExtensionInfo {
  id: string
  name: string
  version: string
  enabled: boolean
}

export interface ExtensionPopupAnchor {
  x: number
  y: number
  width: number
  height: number
}

export interface ExtensionPermissionRequest {
  kind: 'permission' | 'install'
  id: string
  name: string
  version?: string
  permissions: string[]
  origins: string[]
}

export interface BrowserDownload {
  name: string
  path: string
}

export interface BrowserPermissionAsk {
  id: string
  origin: string
  permission: string
}

export interface BrowserPermissionRefusal {
  origin: string
  permission: string
}

export type BrowserDownloadEvent =
  | { id: string; kind: 'started'; name: string; total: number }
  | { id: string; kind: 'progress'; received: number }
  | { id: string; kind: 'retrying' }
  | { id: string; kind: 'done'; state: 'completed' | 'cancelled' | 'interrupted'; path?: string }

export interface BrowserAudioState {
  guestId: number
  audible: boolean
  muted: boolean
}

export interface BrowserAuthChallenge {
  id: string
  kind: 'auth'
  origin: string
  realm: string
}

export interface BrowserJsDialog {
  id: string
  kind: 'alert' | 'confirm' | 'prompt'
  origin: string
  message: string
  defaultValue: string
  guestId: number
  overlay: boolean
}

export interface BrowserStripTarget {
  targetId: string
  url: string
  title: string
  guestId: number | null
}

export interface BrowserCdpOp {
  opId: string
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

export interface BrowserCdpAttached {
  sessionId: string
  targetIds: string[]
}

export interface BrowserOverlayOpen {
  url: string
  presentation: 'now' | 'background'
}

export interface BrowserDialogAnswer {
  ok: boolean
  value?: string
  username?: string
  password?: string
}

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

export interface TerminalProcessTitle {
  id: string
  name: string
}

export interface TerminalCwd {
  id: string
  cwd: string
}

export interface KoloftApi {
  isDev: boolean
  domRenderer: boolean
  testMode: boolean
  home: string
  // PLATFORM§5
  app: {
    onQuitRequested(cb: () => void): () => void
    approveQuit(): void
    holdQuit(): void
    declineQuit(): void
  }
  terminal: {
    create(opts: CreateTabOptions): Promise<CreateTabResult>
    write(id: string, data: string): void
    ack(id: string, utf16Units: number): void
    attach(id: string): void
    flowStats(): Promise<FlowStats[]>
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(cb: (d: TerminalData) => void): () => void
    onExit(cb: (e: TerminalExit) => void): () => void
    onProcessTitle(cb: (t: TerminalProcessTitle) => void): () => void
    onCwd(cb: (c: TerminalCwd) => void): () => void
    onSpawned(cb: (t: SpawnedTab) => void): () => void
  }
  workbench: {
    get(sessionId: string): Promise<SessionWorkbenchState>
    setState(sessionId: string, state: SessionWorkbenchState): void
    setAvailable(available: boolean, terminal: boolean): void
    setFindAvailable(available: boolean): void
    setSaveAvailable(available: boolean): void
    setDirtyTabs(ids: string[]): void
  }
  tabs: {
    list(): Promise<TabInventoryReply>
    onKilledByMain(cb: (tabId: string) => void): () => void
  }
  sessions: {
    backends(): Promise<BackendAvailability[]>
    onUpdate(cb: (sessions: SessionInfo[]) => void): () => void
    onRelocated(cb: (e: { tabId: string; dir: string }) => void): () => void
    noteActivity(tabId: string): void
    list(): Promise<SessionInfo[]>
    resumePlan(sessionId: string): Promise<ResumePlan>
    resume(req: SessionResumeRequest): Promise<SessionResumeResult>
    archive(id: string): Promise<boolean>
    forceClose(id: string): Promise<{ ok: boolean }>
    // CC§2
    transcriptExists(sessionId: string): Promise<boolean>
    leftovers(): Promise<Record<string, LeftoverProcess[]>>
    onLeftovers(cb: (leftovers: Record<string, LeftoverProcess[]>) => void): () => void
    stopLeftover(sessionId: string, pid: number): Promise<boolean>
  }
  attention: {
    list(): Promise<AttentionEvent[]>
    activeTab(id: string | null): void
    visit(id: string): void
    onActivateTab(cb: (tabId: string) => void): () => void
  }
  preview: {
    readText(path: string): Promise<string>
    openFileDialog(): Promise<string | null>
    osOpen(path: string): void
    fileUrl(path: string): string
    onOpenRequest(cb: (r: OpenRequest) => void): () => void
  }
  browserGuestLimit: number
  browserTabCap: number
  browser: {
    onOpenRequest(cb: (r: BrowserOpenRequest) => void): () => void
    onDownload(cb: (d: BrowserDownload) => void): () => void
    onDownloadEvent(cb: (e: BrowserDownloadEvent) => void): () => void
    cancelDownload(id: string): void
    retryDownload(id: string): void
    onPermissionAsk(cb: (a: BrowserPermissionAsk) => void): () => void
    onPermissionRefused(cb: (r: BrowserPermissionRefusal) => void): () => void
    onPermissionDrop(cb: (id: string) => void): () => void
    answerPermission(id: string, granted: boolean): void
    cancelPermission(id: string): void
    onAudioState(cb: (s: BrowserAudioState) => void): () => void
    setMuted(guestId: number, muted: boolean): void
    copyText(text: string): void
    onFullscreen(cb: (on: boolean) => void): () => void
    onBlockedScheme(cb: (url: string) => void): () => void
    onAuthChallenge(cb: (c: BrowserAuthChallenge) => void): () => void
    answerAuthChallenge(id: string, answer: BrowserDialogAnswer): void
    onJsDialog(cb: (d: BrowserJsDialog) => void): () => void
    answerJsDialog(id: string, answer: BrowserDialogAnswer): void
    onOverlayOpen(cb: (o: BrowserOverlayOpen) => void): () => void
    overlayReady(): void
    setOverlayGuest(guestId: number, on: boolean): void
    reportStrip(sessionId: string, targets: BrowserStripTarget[]): void
    onCdpOp(cb: (op: BrowserCdpOp) => void): () => void
    answerCdpOp(res: BrowserCdpOpResult): void
    onCdpAttached(cb: (a: BrowserCdpAttached) => void): () => void
    certProceed(url: string): Promise<void>
    clearData(): Promise<void>
    openExternal(url: string): void
    toggleDevTools(guestId: number): void
  }
  extensions: {
    list(): Promise<ExtensionInfo[]>
    setEnabled(id: string, enabled: boolean): Promise<void>
    uninstall(id: string): Promise<void>
    onChanged(cb: () => void): () => void
    activeGuest(webContentsId: number, url: string): void
    openDropped(url: string): void
    // PLATFORM§15
    anchorPopup(rect: ExtensionPopupAnchor): Promise<void>
    dismissPopup(): void
    onPermissionRequest(cb: (r: ExtensionPermissionRequest) => void): () => void
    answerPermissionRequest(id: string, granted: boolean): void
  }
  fs: {
    listDir(path: string, opts?: { showIgnored?: boolean }): Promise<DirEntry[]>
    dirExists(path: string): Promise<boolean>
    search(
      path: string,
      query: string,
      opts?: { showIgnored?: boolean }
    ): Promise<{ hits: SearchHit[]; truncated: boolean }>
    diffBase(root: string): Promise<string | null>
    gitStatus(root: string, base?: string): Promise<GitStatusMap>
    gitNumstat(root: string, base?: string): Promise<GitNumstatMap>
    watchDir(root: string): Promise<boolean>
    unwatchDir(root: string): void
    onDirChange(cb: (root: string) => void): () => void
    watchFile(path: string): void
    unwatchFile(path: string): void
    // PLATFORM§28
    onFileChange(cb: (path: string, fp?: EditFingerprint) => void): () => void
    reveal(path: string): void
    gitDiff(
      root: string,
      base?: string
    ): Promise<{ text: string; truncated: boolean; notRepo: boolean; toplevel: string | null }>
    gitFileDiff(
      path: string,
      base?: string,
      untracked?: boolean
    ): Promise<{ text: string; truncated: boolean }>
    gitFileDiffFull(
      path: string,
      base?: string,
      untracked?: boolean
    ): Promise<{ text: string; truncated: boolean }>
    searchContent(
      root: string,
      query: string,
      opts?: { showIgnored?: boolean }
    ): Promise<{ hits: ContentHit[]; truncated: boolean }>
  }
  // PLATFORM§6
  edit: {
    open(path: string): Promise<EditOpenResult>
    write(
      path: string,
      text: string,
      expect: EditFingerprint,
      opts?: { force?: boolean; eol?: 'lf' | 'crlf' }
    ): Promise<EditWriteResult>
    create(dirPath: string, name: string): Promise<EditCreateResult>
  }
  notes: {
    path(ws: string): Promise<string | null>
  }
  github: {
    info(root: string, force?: boolean): Promise<GithubInfo | null>
    target(root: string, what: GithubTarget): Promise<string | null>
    onInfo(cb: (root: string, info: GithubInfo) => void): () => void
  }
  workspace: {
    pickFolder(): Promise<string | null>
    add(path: string): Promise<WorkspaceAddResult>
    remove(path: string): Promise<WorkspaceRemoveResult>
    removeConfirmed(path: string): Promise<void>
    worktrees(path: string): Promise<WorktreeInfo[]>
    historyRows(path: string): Promise<SessionRow[]>
    rows(): Promise<WorkspaceRows[]>
    onRows(cb: (rows: WorkspaceRows[]) => void): () => void
    fetchFreshness(path: string): Promise<WorkspaceFreshness | null>
    pull(path: string, expect: { branch: string; head: string }): Promise<WorkspacePullResult>
    discover(): Promise<DiscoveredFolder[]>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    onUpdate(cb: (s: Settings) => void): () => void
  }
  accounts: {
    list(): Promise<AccountView[]>
    add(
      name: string,
      kind: AccountKind,
      secret: string,
      endpoint?: { baseUrl: string; model?: string }
    ): Promise<AccountAddResult>
    remove(name: string, kind: AccountKind): Promise<void>
    toggle(name: string, kind: AccountKind, enabled: boolean): Promise<void>
    probe(): Promise<AccountView[]>
    // CC§7
    startLogin(
      name: string,
      reauth?: boolean
    ): Promise<'ok' | 'invalid-name' | 'duplicate' | 'unknown'>
    cancelLogin(): void
    // CODEX§15
    codexSignIn(name: string, again?: boolean): Promise<CodexSignInResult>
    onLoginProgress(cb: (p: LoginProgress) => void): () => void
    onUpdate(cb: (accounts: AccountView[]) => void): () => void
  }
  // ADR-0006
  update: {
    version(): Promise<string>
    check(): Promise<UpdateCheckResult>
    download(): Promise<UpdateCheckResult | undefined>
    restart(): void
    openRelease(): void
    onProgress(cb: (p: UpdateProgress) => void): () => void
    whatsNew(): Promise<WhatsNew | null>
    offer(): Promise<UpdateCheckResult | null>
    onOffer(cb: (offer: UpdateCheckResult | null) => void): () => void
  }
  // PLATFORM§10
  windowFocus: {
    onChange(cb: (focused: boolean) => void): () => void
  }
  shortcuts: {
    onNewTerminalTab(cb: () => void): () => void
    onFocusNotes(cb: () => void): () => void
    onNewSession(cb: () => void): () => void
    onNewWorktreeSession(cb: () => void): () => void
    onCloseTab(cb: () => void): () => void
    onFind(cb: () => void): () => void
    onCheckUpdate(cb: () => void): () => void
    onOpenSettings(cb: () => void): () => void
    onRestartSession(cb: () => void): () => void
    onAddWorkspace(cb: () => void): () => void
    onSave(cb: () => void): () => void
    onFindFiles(cb: () => void): () => void
    // PLATFORM§7
    onBrowserCommand(cb: (cmd: BrowserCommand) => void): () => void
    // PLATFORM§7
    onWorkbenchShortcut(cb: (cmd: WorkbenchShortcut) => void): () => void
    windowCommand(cmd: WindowCommand): void
  }
  webgl: {
    // PLATFORM§20
    onRepair(cb: () => void): () => void
  }
  cron: {
    list(): Promise<CronState>
    save(input: CronSaveInput): Promise<CronSaveResult>
    delete(jobId: string): Promise<void>
    setEnabled(jobId: string, on: boolean): Promise<void>
    runNow(jobId: string): Promise<CronRunNowResult>
    skills(workspacePath: string): Promise<SkillSuggestion[]>
    // CC§9
    trusted(workspacePath: string, backend: BackendId): Promise<boolean>
    onState(cb: (s: CronState) => void): () => void
    onToast(cb: (text: string) => void): () => void
  }
}

export type Schedule =
  | { kind: 'daily'; at: string }
  | { kind: 'weekly'; days: number[]; at: string }
  | { kind: 'every'; n: number; unit: 'minutes' | 'hours' }

export type CronPermission = 'same' | 'acceptEdits' | 'skipAll'
// CC§9
export const CRON_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type CronEffort = (typeof CRON_EFFORTS)[number]
export function isCronEffort(v: unknown): v is CronEffort {
  return (CRON_EFFORTS as readonly unknown[]).includes(v)
}

export interface CronJob {
  id: string
  workspacePath: string
  name: string
  task: string
  schedule: Schedule
  backend?: BackendId
  model?: string
  effort?: CronEffort
  permission: CronPermission
  enabled: boolean
  createdAt: number
  history: HistoryLine[]
}

export type HistoryState = 'closed' | 'failed' | 'ended' | 'skipped' | 'missed'

export interface HistoryLine {
  dueAt: number
  manual?: true
  state: HistoryState
  count?: number
  until?: number
  worktree?: string
  note?: string
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

export interface CronState {
  jobs: CronJob[]
  live: LiveRun[]
  folders: Record<string, number>
  notes: Record<string, string>
}

export interface SkillSuggestion {
  name: string
  description?: string
  source: 'project' | 'home'
}

export interface SpawnedTab {
  id: string
  kind: BackendId
  cwd: string
  title: string
  jobId: string
}

export type CronSaveInput = Omit<CronJob, 'history' | 'createdAt' | 'id'> & { id?: string }
export type CronSaveResult = { ok: true; job: CronJob } | { ok: false; errors: string[] }
export type CronRunNowResult =
  | { ok: true }
  | {
      ok: false
      reason: 'skipped' | 'failed' | 'folder-missing' | 'no-account' | 'not-ready' | 'unknown-job'
    }

export type AuxMode = 'preview' | 'browser' | null

export const DEFAULT_TERMINAL_TITLE = 'zsh'

export interface BrowserTabState {
  url: string
  title: string
}

export interface SessionBrowserState {
  tabs: BrowserTabState[]
}

export interface SessionAuxState {
  auxMode: AuxMode
  browser?: SessionBrowserState
}

export type WorkbenchTabKind = 'files' | 'web' | 'file' | 'terminal'

export type ArtifactView = 'render' | 'diff' | 'source'

export interface PersistedTab {
  kind: Exclude<WorkbenchTabKind, 'files' | 'terminal'>
  title: string
  url?: string
  path?: string
  view?: ArtifactView
}

export interface SessionWorkbenchState {
  open: boolean
  tabs: PersistedTab[]
}

export interface LayoutV2 {
  version: 2
  workspaces: { path: string }[]
  aux: {
    defaultMode: AuxMode
  }
  sessions: Record<string, SessionAuxState>
}

export interface LayoutV4 {
  version: 4
  workspaces: { path: string }[]
  workbench: {
    defaultOpen: boolean
  }
  sessions: Record<string, SessionWorkbenchState>
}

export type LayoutV3 = Omit<LayoutV4, 'version'> & { version: 3 }

// CC§2
export interface WorktreeStateMeta {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch: string
  originalHeadCommit: string
}

export interface SessionRow {
  backendId: BackendId
  host: HostId
  nativeSessionId?: string
  createdAt?: number
  id: string
  title: string
  // CC§2
  worktree: string
  cwd: string
  running: boolean
  invalidCwd: boolean
  mtime: number
  pending?: boolean
  worktreeState?: WorktreeStateMeta
  revealDir?: string
}

export interface WorkspaceFreshness {
  state: 'ok' | 'none' | 'error'
  behind: number
  ahead: number
  branch: string
  head: string
  defRef: string
  onDefault: boolean
  dirty: boolean
  linked: boolean
  hasSubmodules: boolean
  fetchedAt: number | null
  lastAttemptAt: number | null
}

export interface WorkspacePullSummary {
  count: number
  from: string
  to: string
}

export type WorkspacePullResult =
  { ok: true; summary: WorkspacePullSummary } | { ok: false; reason: string }

export interface WorkspaceRows {
  workspace: {
    path: string
    missing: boolean
    isGit: boolean
    hasHistory: boolean
    freshness?: WorkspaceFreshness
    remote?: { host: string; path: string; connected: boolean }
  }
  rows: SessionRow[]
}

export interface WorktreeInfo {
  recoveryResourceId?: string
  name: string
  dir: string
  branch?: string
}

export type WorkspaceAddResult =
  | { code: 'added'; path: string }
  | { code: 'exists'; path: string }
  | { code: 'rejected-worktree' }
  | { code: 'not-found' }

export interface WorkspaceRemoveResult {
  running: number
  jobs: number
  removed: boolean
}

export interface SessionResumeRequest {
  sessionId: string
  cwd: string
  cols?: number
  rows?: number
  // CC§3
  mode?: 'direct' | 'rebuild' | 'renamed' | 'main'
  worktree?: string
  rebuild?: { worktreePath: string; branch: string; baseRef: string }
}

export type SessionResumeResult =
  | { ok: true; id: string; cwd: string; kind?: TabKind }
  | { ok: false; code: 'cwd-missing' | 'invalid-args' | 'rebuild-failed' }
  | { ok: false; code: 'backend'; message: string }

export interface ResumeEvidence {
  worktreePath: string
  worktreeName: string
  expectedBranch: string
  currentBranch: string | null
  branchMatches: boolean
  dirty: boolean
  occupiedBy: string | null
}

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
  | { action: 'unavailable'; reason: 'no-cwd' | 'not-found' | 'running' }
