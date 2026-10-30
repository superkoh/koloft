import { contextBridge, ipcRenderer } from 'electron'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'
import type {
  WorkbenchShortcut,
  BrowserAuthChallenge,
  BrowserCommand,
  BrowserAudioState,
  BrowserDownload,
  BrowserDownloadEvent,
  BrowserPermissionAsk,
  BrowserPermissionRefusal,
  BrowserCdpAttached,
  BrowserCdpOp,
  BrowserJsDialog,
  BrowserOverlayOpen,
  BrowserOpenRequest,
  EditFingerprint,
  ExtensionPermissionRequest,
  GithubInfo,
  KoloftApi,
  CreateTabOptions,
  TerminalData,
  TerminalExit,
  TerminalCwd,
  ScreenRequest,
  TerminalProcessTitle,
  LeftoverProcess,
  SessionInfo,
  SessionSearchHits,
  SpawnedTab,
  UsageRead,
  CronState,
  MachineState,
  DiscordStatus,
  AttentionEvent,
  AccountView,
  GitAccountView,
  GitLoginProgress,
  LoginProgress,
  SignInFailure,
  Settings,
  UpdateProgress,
  UpdateCheckResult,
  OpenRequest,
  WorkspaceRows
} from '@shared/types'
import { CH } from '@shared/ipcChannels'

const terminalDataSinks = new Map<string, (data: string) => void>()
ipcRenderer.on(CH.terminal.data, (_e, d: TerminalData) => terminalDataSinks.get(d.id)?.(d.data))

const api: KoloftApi = {
  isDev: ipcRenderer.sendSync(CH.app.isDev) as boolean,
  domRenderer: process.env.KOLOFT_DOM_RENDERER === '1',
  testMode: process.env.KOLOFT_TEST_BACKGROUND === '1',
  home: ipcRenderer.sendSync(CH.app.home) as string,
  app: {
    onQuitRequested: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.app.quitRequested, handler)
      return () => ipcRenderer.removeListener(CH.app.quitRequested, handler)
    },
    approveQuit: () => ipcRenderer.send(CH.app.quitApproved),
    holdQuit: () => ipcRenderer.send(CH.app.quitHeld),
    declineQuit: () => ipcRenderer.send(CH.app.quitDeclined)
  },
  terminal: {
    create: (opts: CreateTabOptions) => ipcRenderer.invoke(CH.terminal.create, opts),
    write: (id, data) => ipcRenderer.send(CH.terminal.write, id, data),
    paste: (id, text, typedAfter) => ipcRenderer.invoke(CH.terminal.paste, id, text, typedAfter),
    ack: (id, utf16Units) => ipcRenderer.send(CH.terminal.ack, id, utf16Units),
    attach: (id) => ipcRenderer.send(CH.terminal.attach, id),
    flowStats: () => ipcRenderer.invoke(CH.terminal.flowStats),
    resize: (id, cols, rows) => ipcRenderer.send(CH.terminal.resize, id, cols, rows),
    kill: (id, restarting) => ipcRenderer.send(CH.terminal.kill, id, restarting),
    onData: (id, cb) => {
      terminalDataSinks.set(id, cb)
      return () => terminalDataSinks.delete(id)
    },
    onExit: (cb) => {
      const handler = (_e: unknown, e: TerminalExit): void => cb(e)
      ipcRenderer.on(CH.terminal.exit, handler)
      return () => ipcRenderer.removeListener(CH.terminal.exit, handler)
    },
    onProcessTitle: (cb) => {
      const handler = (_e: unknown, t: TerminalProcessTitle): void => cb(t)
      ipcRenderer.on(CH.terminal.processTitle, handler)
      return () => ipcRenderer.removeListener(CH.terminal.processTitle, handler)
    },
    onCwd: (cb) => {
      const handler = (_e: unknown, c: TerminalCwd): void => cb(c)
      ipcRenderer.on(CH.terminal.cwd, handler)
      return () => ipcRenderer.removeListener(CH.terminal.cwd, handler)
    },
    onSpawned: (cb) => {
      const handler = (_e: unknown, t: SpawnedTab): void => cb(t)
      ipcRenderer.on(CH.terminal.spawned, handler)
      return () => ipcRenderer.removeListener(CH.terminal.spawned, handler)
    },
    onScreenRequest: (cb) => {
      const handler = (_e: unknown, r: ScreenRequest): void => cb(r)
      ipcRenderer.on(CH.terminal.screen, handler)
      return () => ipcRenderer.removeListener(CH.terminal.screen, handler)
    },
    answerScreen: (a) => ipcRenderer.send(CH.terminal.screenDone, a),
    logUnexpectedExit: (s) => ipcRenderer.send(CH.terminal.unexpectedExit, s)
  },
  workbench: {
    get: (sessionId) => ipcRenderer.invoke(CH.workbench.get, sessionId),
    setState: (sessionId, state) => ipcRenderer.send(CH.workbench.setState, sessionId, state),
    setAvailable: (available, terminal) =>
      ipcRenderer.send(CH.workbench.available, available, terminal),
    setFindAvailable: (available) => ipcRenderer.send(CH.workbench.findAvailable, available),
    setSaveAvailable: (available) => ipcRenderer.send(CH.workbench.saveAvailable, available),
    setDirtyTabs: (ids) => ipcRenderer.send(CH.workbench.dirtyTabs, ids)
  },
  tabs: {
    list: () => ipcRenderer.invoke(CH.tabs.list),
    moved: (oldTabId, newTabId) => ipcRenderer.send(CH.tabs.moved, oldTabId, newTabId),
    onKilledByMain: (cb) => {
      const handler = (_e: unknown, tabId: string): void => cb(tabId)
      ipcRenderer.on(CH.tab.killedByMain, handler)
      return () => ipcRenderer.removeListener(CH.tab.killedByMain, handler)
    },
    onSlept: (cb) => {
      const handler = (_e: unknown, tabId: string): void => cb(tabId)
      ipcRenderer.on(CH.tab.slept, handler)
      return () => ipcRenderer.removeListener(CH.tab.slept, handler)
    }
  },
  sessions: {
    backends: (recheck) => ipcRenderer.invoke(CH.sessions.backends, recheck === true),
    installTool: (backend) => ipcRenderer.invoke(CH.sessions.installTool, backend),
    onToolsChanged: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.sessions.toolsChanged, handler)
      return () => ipcRenderer.removeListener(CH.sessions.toolsChanged, handler)
    },
    onUpdate: (cb) => {
      const handler = (_e: unknown, s: SessionInfo[]): void => cb(s)
      ipcRenderer.on(CH.sessions.update, handler)
      return () => ipcRenderer.removeListener(CH.sessions.update, handler)
    },
    onRelocated: (cb) => {
      const handler = (_e: unknown, x: { tabId: string; dir: string }): void => cb(x)
      ipcRenderer.on(CH.session.relocated, handler)
      return () => ipcRenderer.removeListener(CH.session.relocated, handler)
    },
    noteActivity: (tabId) => ipcRenderer.send(CH.sessions.activity, tabId),
    list: () => ipcRenderer.invoke(CH.sessions.list),
    resumePlan: (id) => ipcRenderer.invoke(CH.sessions.resumePlan, id),
    resume: (req) => ipcRenderer.invoke(CH.sessions.resume, req),
    archive: (id) => ipcRenderer.invoke(CH.sessions.archive, id),
    setResident: (id, on) => ipcRenderer.send(CH.sessions.setResident, id, on),
    forceClose: (id) => ipcRenderer.invoke(CH.sessions.forceClose, id),
    transcriptExists: (id) => ipcRenderer.invoke(CH.sessions.transcriptExists, id),
    noAccountToResume: (id) => ipcRenderer.invoke(CH.sessions.noAccountToResume, id),
    leftovers: () => ipcRenderer.invoke(CH.sessions.leftovers),
    onLeftovers: (cb) => {
      const handler = (_e: unknown, l: Record<string, LeftoverProcess[]>): void => cb(l)
      ipcRenderer.on(CH.sessions.leftovers, handler)
      return () => ipcRenderer.removeListener(CH.sessions.leftovers, handler)
    },
    stopLeftover: (sessionId, pid) => ipcRenderer.invoke(CH.sessions.stopLeftover, sessionId, pid),
    search: (searchId, term) => ipcRenderer.send(CH.sessions.search, searchId, term),
    onSearchHits: (cb) => {
      const handler = (_e: unknown, found: SessionSearchHits): void => cb(found)
      ipcRenderer.on(CH.sessions.searchHits, handler)
      return () => ipcRenderer.removeListener(CH.sessions.searchHits, handler)
    }
  },
  cron: {
    list: () => ipcRenderer.invoke(CH.cron.list),
    save: (input) => ipcRenderer.invoke(CH.cron.save, input),
    delete: (jobId) => ipcRenderer.invoke(CH.cron.delete, jobId),
    setEnabled: (jobId, on) => ipcRenderer.invoke(CH.cron.setEnabled, { jobId, on }),
    runNow: (jobId) => ipcRenderer.invoke(CH.cron.runNow, jobId),
    skills: (workspacePath) => ipcRenderer.invoke(CH.cron.skills, workspacePath),
    trusted: (workspacePath, backend) =>
      ipcRenderer.invoke(CH.cron.trusted, workspacePath, backend),
    onState: (cb) => {
      const handler = (_e: unknown, s: CronState): void => cb(s)
      ipcRenderer.on(CH.cron.state, handler)
      return () => ipcRenderer.removeListener(CH.cron.state, handler)
    },
    onToast: (cb) => {
      const handler = (_e: unknown, text: string): void => cb(text)
      ipcRenderer.on(CH.cron.toast, handler)
      return () => ipcRenderer.removeListener(CH.cron.toast, handler)
    }
  },
  machine: {
    onState: (cb) => {
      const handler = (_e: unknown, s: MachineState): void => cb(s)
      ipcRenderer.on(CH.machine.state, handler)
      return () => ipcRenderer.removeListener(CH.machine.state, handler)
    },
    now: () => ipcRenderer.invoke(CH.machine.now),
    free: (tabId) => ipcRenderer.invoke(CH.machine.free, tabId),
    drop: (tabId) => ipcRenderer.invoke(CH.machine.drop, tabId)
  },
  conductors: {
    bind: (channel) => ipcRenderer.invoke(CH.conductors.bind, channel),
    bindNewChannel: () => ipcRenderer.invoke(CH.conductors.bindNewChannel),
    unbind: () => ipcRenderer.invoke(CH.conductors.unbind),
    open: () => ipcRenderer.invoke(CH.conductors.open),
    startFresh: () => ipcRenderer.invoke(CH.conductors.startFresh),
    fromPalette: (request) => ipcRenderer.invoke(CH.conductors.fromPalette, request)
  },
  discord: {
    status: () => ipcRenderer.invoke(CH.discord.status),
    onStatus: (cb) => {
      const handler = (_e: unknown, s: DiscordStatus): void => cb(s)
      ipcRenderer.on(CH.discord.status, handler)
      return () => ipcRenderer.removeListener(CH.discord.status, handler)
    },
    pair: (isMe) => ipcRenderer.invoke(CH.discord.pair, isMe),
    channels: () => ipcRenderer.invoke(CH.discord.channels),
    setUpWithButler: (ownerWords) => ipcRenderer.invoke(CH.discord.setUpWithButler, ownerWords)
  },
  attention: {
    list: () => ipcRenderer.invoke(CH.attention.list),
    activeTab: (id) => ipcRenderer.send(CH.attention.activeTab, id),
    onActivateTab: (cb) => {
      const handler = (_e: unknown, p: { tabId: string }): void => cb(p.tabId)
      ipcRenderer.on(CH.attention.activateTab, handler)
      return () => ipcRenderer.removeListener(CH.attention.activateTab, handler)
    },
    onChanged: (cb) => {
      const handler = (_e: unknown, pending: AttentionEvent[]): void => cb(pending)
      ipcRenderer.on(CH.attention.changed, handler)
      return () => ipcRenderer.removeListener(CH.attention.changed, handler)
    }
  },
  preview: {
    readText: (p) => ipcRenderer.invoke(CH.preview.readText, p),
    openFileDialog: () => ipcRenderer.invoke(CH.preview.openFileDialog),
    osOpen: (p) => ipcRenderer.send(CH.preview.osOpen, p),
    fileUrl: (p) => `koloft-file://localhost${encodeURI(p)}`,
    onOpenRequest: (cb) => {
      const handler = (_e: unknown, r: OpenRequest): void => cb(r)
      ipcRenderer.on(CH.preview.openFile, handler)
      return () => ipcRenderer.removeListener(CH.preview.openFile, handler)
    }
  },
  browserGuestLimit: ipcRenderer.sendSync(CH.browser.guestLimit) as number,
  browserTabCap: Number(process.env.KOLOFT_BROWSER_TAB_CAP) || 0,
  browser: {
    onOpenRequest: (cb) => {
      const handler = (_e: unknown, r: BrowserOpenRequest): void => cb(r)
      ipcRenderer.on(CH.browser.open, handler)
      return () => ipcRenderer.removeListener(CH.browser.open, handler)
    },
    onDownload: (cb) => {
      const handler = (_e: unknown, d: BrowserDownload): void => cb(d)
      ipcRenderer.on(CH.browser.download, handler)
      return () => ipcRenderer.removeListener(CH.browser.download, handler)
    },
    onDownloadEvent(cb: (e: BrowserDownloadEvent) => void) {
      const handler = (_e: unknown, ev: BrowserDownloadEvent): void => cb(ev)
      ipcRenderer.on(CH.browser.downloadEvent, handler)
      return () => ipcRenderer.removeListener(CH.browser.downloadEvent, handler)
    },
    cancelDownload: (id: string) => ipcRenderer.send(CH.browser.downloadCancel, id),
    retryDownload: (id: string) => ipcRenderer.send(CH.browser.downloadRetry, id),
    onPermissionAsk(cb: (a: BrowserPermissionAsk) => void) {
      const handler = (_e: unknown, a: BrowserPermissionAsk): void => cb(a)
      ipcRenderer.on(CH.browser.permissionAsk, handler)
      return () => ipcRenderer.removeListener(CH.browser.permissionAsk, handler)
    },
    onPermissionRefused(cb: (r: BrowserPermissionRefusal) => void) {
      const handler = (_e: unknown, r: BrowserPermissionRefusal): void => cb(r)
      ipcRenderer.on(CH.browser.permissionRefused, handler)
      return () => ipcRenderer.removeListener(CH.browser.permissionRefused, handler)
    },
    onPermissionDrop(cb: (id: string) => void) {
      const handler = (_e: unknown, id: string): void => cb(id)
      ipcRenderer.on(CH.browser.permissionDrop, handler)
      return () => ipcRenderer.removeListener(CH.browser.permissionDrop, handler)
    },
    answerPermission: (id: string, granted: boolean) =>
      ipcRenderer.send(CH.browser.permissionAnswer, id, granted),
    cancelPermission: (id: string) => ipcRenderer.send(CH.browser.permissionCancel, id),
    onAudioState(cb: (s: BrowserAudioState) => void) {
      const handler = (_e: unknown, st: BrowserAudioState): void => cb(st)
      ipcRenderer.on(CH.browser.audioState, handler)
      return () => ipcRenderer.removeListener(CH.browser.audioState, handler)
    },
    setMuted: (guestId: number, muted: boolean) =>
      ipcRenderer.send(CH.browser.setMuted, guestId, muted),
    copyText: (text: string) => ipcRenderer.send(CH.browser.copyText, text),
    onFullscreen(cb: (on: boolean) => void) {
      const handler = (_e: unknown, on: boolean): void => cb(on)
      ipcRenderer.on(CH.browser.fullscreen, handler)
      return () => ipcRenderer.removeListener(CH.browser.fullscreen, handler)
    },
    onBlockedScheme: (cb) => {
      const handler = (_e: unknown, url: string): void => cb(url)
      ipcRenderer.on(CH.browser.blockedScheme, handler)
      return () => ipcRenderer.removeListener(CH.browser.blockedScheme, handler)
    },
    onAuthChallenge: (cb) => {
      const handler = (_e: unknown, c: BrowserAuthChallenge): void => cb(c)
      ipcRenderer.on(CH.browser.authChallenge, handler)
      return () => ipcRenderer.removeListener(CH.browser.authChallenge, handler)
    },
    answerAuthChallenge: (id, answer) => ipcRenderer.send(CH.browser.authAnswer, id, answer),
    onJsDialog: (cb) => {
      const handler = (_e: unknown, d: BrowserJsDialog): void => cb(d)
      ipcRenderer.on(CH.browser.jsDialog, handler)
      return () => ipcRenderer.removeListener(CH.browser.jsDialog, handler)
    },
    answerJsDialog: (id, answer) => ipcRenderer.send(CH.browser.jsDialogAnswer, id, answer),
    overlayReady: () => ipcRenderer.send(CH.browser.overlayReady),
    onOverlayOpen: (cb) => {
      const handler = (_e: unknown, o: BrowserOverlayOpen): void => cb(o)
      ipcRenderer.on(CH.browser.overlayOpen, handler)
      return () => ipcRenderer.removeListener(CH.browser.overlayOpen, handler)
    },
    setOverlayGuest: (guestId, on) => ipcRenderer.send(CH.browser.overlayGuest, guestId, on),
    setGuestOwner: (guestId, ownerTabId) =>
      ipcRenderer.send(CH.browser.guestOwner, guestId, ownerTabId),
    reportStrip: (sessionId, targets) => ipcRenderer.send(CH.browser.strip, sessionId, targets),
    reportComposing: (on) => ipcRenderer.send(CH.browser.hostComposing, on),
    onCdpOp: (cb) => {
      const handler = (_e: unknown, op: BrowserCdpOp): void => cb(op)
      ipcRenderer.on(CH.browser.cdpOp, handler)
      return () => ipcRenderer.removeListener(CH.browser.cdpOp, handler)
    },
    answerCdpOp: (res) => ipcRenderer.send(CH.browser.cdpOpDone, res),
    onCdpAttached: (cb) => {
      const handler = (_e: unknown, a: BrowserCdpAttached): void => cb(a)
      ipcRenderer.on(CH.browser.cdpAttached, handler)
      return () => ipcRenderer.removeListener(CH.browser.cdpAttached, handler)
    },
    certProceed: (url) => ipcRenderer.invoke(CH.browser.certProceed, url),
    clearData: () => ipcRenderer.invoke(CH.browser.clearData),
    openExternal: (url) => ipcRenderer.send(CH.browser.openExternal, url),
    toggleDevTools: (guestId) => ipcRenderer.send(CH.browser.devtools, guestId)
  },
  extensions: {
    list: () => ipcRenderer.invoke(CH.ext.list),
    setEnabled: (id, enabled) => ipcRenderer.invoke(CH.ext.setEnabled, id, enabled),
    uninstall: (id) => ipcRenderer.invoke(CH.ext.uninstall, id),
    onChanged: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.ext.changed, handler)
      return () => ipcRenderer.removeListener(CH.ext.changed, handler)
    },
    activeGuest: (webContentsId, url) => ipcRenderer.send(CH.ext.activeGuest, webContentsId, url),
    openDropped: (url) => ipcRenderer.send(CH.ext.openDropped, url),
    anchorPopup: (rect) => ipcRenderer.invoke(CH.ext.popupAnchor, rect),
    dismissPopup: () => ipcRenderer.send(CH.ext.dismissPopup),
    onPermissionRequest: (cb) => {
      const handler = (_e: unknown, r: ExtensionPermissionRequest): void => cb(r)
      ipcRenderer.on(CH.ext.permissionRequest, handler)
      return () => ipcRenderer.removeListener(CH.ext.permissionRequest, handler)
    },
    answerPermissionRequest: (id, granted) => ipcRenderer.send(CH.ext.permissionAnswer, id, granted)
  },
  fs: {
    listDir: (p, opts) => ipcRenderer.invoke(CH.fs.listDir, p, opts),
    dirExists: (p) => ipcRenderer.invoke(CH.fs.dirExists, p),
    search: (root, q, opts) => ipcRenderer.invoke(CH.fs.search, root, q, opts),
    gitChanges: (root, base) => ipcRenderer.invoke(CH.fs.gitChanges, root, base),
    watchDir: (root) => ipcRenderer.invoke(CH.fs.watchDir, root),
    unwatchDir: (root) => ipcRenderer.send(CH.fs.unwatchDir, root),
    onDirChange: (cb) => {
      const handler = (_e: unknown, root: string): void => cb(root)
      ipcRenderer.on(CH.fs.dirChanged, handler)
      return () => ipcRenderer.removeListener(CH.fs.dirChanged, handler)
    },
    watchFile: (p) => ipcRenderer.send(CH.fs.watchFile, p),
    unwatchFile: (p) => ipcRenderer.send(CH.fs.unwatchFile, p),
    onFileChange: (cb) => {
      const handler = (_e: unknown, p: string, fp?: EditFingerprint): void => cb(p, fp)
      ipcRenderer.on(CH.fs.fileChanged, handler)
      return () => ipcRenderer.removeListener(CH.fs.fileChanged, handler)
    },
    reveal: (p) => ipcRenderer.send(CH.fs.reveal, p),
    gitDiff: (root, base) => ipcRenderer.invoke(CH.fs.gitDiff, root, base),
    gitFileDiff: (p, base, untracked) => ipcRenderer.invoke(CH.fs.gitFileDiff, p, base, untracked),
    gitFileDiffFull: (p, base, untracked) =>
      ipcRenderer.invoke(CH.fs.gitFileDiffFull, p, base, untracked),
    searchContent: (root, q, opts) => ipcRenderer.invoke(CH.fs.searchContent, root, q, opts)
  },
  edit: {
    open: (p) => ipcRenderer.invoke(CH.edit.open, p),
    write: (p, text, expect, opts) => ipcRenderer.invoke(CH.edit.write, p, text, expect, opts),
    create: (dirPath, name) => ipcRenderer.invoke(CH.edit.create, dirPath, name)
  },
  notes: {
    path: (ws) => ipcRenderer.invoke(CH.notes.path, ws)
  },
  github: {
    info: (root, force) => ipcRenderer.invoke(CH.github.info, root, force),
    target: (root, what) => ipcRenderer.invoke(CH.github.target, root, what),
    onInfo: (cb) => {
      const handler = (_e: unknown, root: string, info: GithubInfo): void => cb(root, info)
      ipcRenderer.on(CH.github.info, handler)
      return () => ipcRenderer.removeListener(CH.github.info, handler)
    },
    checks: (root, pr) => ipcRenderer.invoke(CH.github.checks, root, pr),
    failingChecksText: (root, pr) => ipcRenderer.invoke(CH.github.failingChecksText, root, pr),
    commit: (root, message) => ipcRenderer.invoke(CH.github.commit, root, message),
    push: (root) => ipcRenderer.invoke(CH.github.push, root),
    openItems: (root) => ipcRenderer.invoke(CH.github.openItems, root),
    prWorktree: (root, pr, branch) => ipcRenderer.invoke(CH.github.prWorktree, root, pr, branch)
  },
  workspace: {
    pickFolder: () => ipcRenderer.invoke(CH.workspace.pickFolder),
    add: (p) => ipcRenderer.invoke(CH.workspace.add, p),
    remove: (p) => ipcRenderer.invoke(CH.workspace.remove, p),
    removeConfirmed: (p) => ipcRenderer.invoke(CH.workspace.removeConfirmed, p),
    move: (p, before) => ipcRenderer.invoke(CH.workspace.move, p, before),
    worktrees: (p) => ipcRenderer.invoke(CH.workspace.worktrees, p),
    historyRows: (p) => ipcRenderer.invoke(CH.workspace.historyRows, p),
    rows: () => ipcRenderer.invoke(CH.workspace.rows),
    onRows: (cb) => {
      const handler = (_e: unknown, rows: WorkspaceRows[]): void => cb(rows)
      ipcRenderer.on(CH.workspace.rows, handler)
      return () => ipcRenderer.removeListener(CH.workspace.rows, handler)
    },
    fetchFreshness: (p) => ipcRenderer.invoke(CH.workspace.fetchFreshness, p),
    pull: (p, expect) => ipcRenderer.invoke(CH.workspace.pull, p, expect),
    discover: () => ipcRenderer.invoke(CH.workspace.discover),
    createProject: (parent, name) => ipcRenderer.invoke(CH.project.create, parent, name)
  },
  assist: {
    route: (id, message) => ipcRenderer.invoke(CH.assist.route, id, message),
    cancel: (id) => ipcRenderer.send(CH.assist.cancel, id)
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settings.get),
    set: (patch) => ipcRenderer.invoke(CH.settings.set, patch),
    onUpdate: (cb) => {
      const handler = (_e: unknown, s: Settings): void => cb(s)
      ipcRenderer.on(CH.settings.update, handler)
      return () => ipcRenderer.removeListener(CH.settings.update, handler)
    }
  },
  usage: {
    read: () => ipcRenderer.invoke(CH.usage.read),
    onChanged: (cb) => {
      const handler = (_e: unknown, read: UsageRead): void => cb(read)
      ipcRenderer.on(CH.usage.changed, handler)
      return () => ipcRenderer.removeListener(CH.usage.changed, handler)
    }
  },
  accounts: {
    list: () => ipcRenderer.invoke(CH.accounts.list),
    add: (name, kind, secret, endpoint) =>
      ipcRenderer.invoke(CH.accounts.add, name, kind, secret, endpoint),
    remove: (name, kind) => ipcRenderer.invoke(CH.accounts.remove, name, kind),
    toggle: (name, kind, enabled) => ipcRenderer.invoke(CH.accounts.toggle, name, kind, enabled),
    probe: () => ipcRenderer.invoke(CH.accounts.probe),
    startLogin: (name, reauth) => ipcRenderer.invoke(CH.accounts.startLogin, name, reauth),
    cancelLogin: () => ipcRenderer.send(CH.accounts.cancelLogin),
    signIn: (kind, name, again) => ipcRenderer.invoke(CH.accounts.signIn, kind, name, again),
    signInFailure: () => ipcRenderer.invoke(CH.accounts.signInFailure),
    dismissSignInFailure: () => ipcRenderer.send(CH.accounts.dismissSignInFailure),
    onSignInFailure: (cb) => {
      const handler = (_e: unknown, f: SignInFailure | null): void => cb(f)
      ipcRenderer.on(CH.accounts.signInFailure, handler)
      return () => ipcRenderer.removeListener(CH.accounts.signInFailure, handler)
    },
    codexUseReset: (name) => ipcRenderer.invoke(CH.accounts.codexUseReset, name),
    onLoginProgress: (cb) => {
      const handler = (_e: unknown, p: LoginProgress): void => cb(p)
      ipcRenderer.on(CH.accounts.loginProgress, handler)
      return () => ipcRenderer.removeListener(CH.accounts.loginProgress, handler)
    },
    onUpdate: (cb) => {
      const handler = (_e: unknown, a: AccountView[]): void => cb(a)
      ipcRenderer.on(CH.accounts.update, handler)
      return () => ipcRenderer.removeListener(CH.accounts.update, handler)
    }
  },
  gitAccounts: {
    list: () => ipcRenderer.invoke(CH.gitAccounts.list),
    onUpdate: (cb) => {
      const handler = (_e: unknown, a: GitAccountView[]): void => cb(a)
      ipcRenderer.on(CH.gitAccounts.update, handler)
      return () => ipcRenderer.removeListener(CH.gitAccounts.update, handler)
    },
    loginStart: (platform, url, machine) =>
      ipcRenderer.invoke(CH.gitAccounts.loginStart, platform, url, machine),
    loginCancel: () => ipcRenderer.send(CH.gitAccounts.loginCancel),
    loginBrowser: () => ipcRenderer.send(CH.gitAccounts.loginBrowser),
    onLoginProgress: (cb) => {
      const handler = (_e: unknown, p: GitLoginProgress): void => cb(p)
      ipcRenderer.on(CH.gitAccounts.loginProgress, handler)
      return () => ipcRenderer.removeListener(CH.gitAccounts.loginProgress, handler)
    },
    addToken: (add) => ipcRenderer.invoke(CH.gitAccounts.addToken, add),
    remove: (id, machine) => ipcRenderer.invoke(CH.gitAccounts.remove, id, machine),
    makeDefault: (id, machine) => ipcRenderer.invoke(CH.gitAccounts.makeDefault, id, machine),
    check: () => ipcRenderer.invoke(CH.gitAccounts.check),
    pick: (wsPath, id) => ipcRenderer.invoke(CH.gitAccounts.pick, wsPath, id),
    suggest: (wsPath, network) => ipcRenderer.invoke(CH.gitAccounts.suggest, wsPath, network),
    dismiss: (wsPath) => ipcRenderer.invoke(CH.gitAccounts.dismiss, wsPath),
    makeSshKey: (wsPath) => ipcRenderer.invoke(CH.gitAccounts.makeSshKey, wsPath),
    checkSshKey: (wsPath) => ipcRenderer.invoke(CH.gitAccounts.checkSshKey, wsPath)
  },
  update: {
    version: () => ipcRenderer.invoke(CH.app.version),
    whatsNew: () => ipcRenderer.invoke(CH.update.whatsNew),
    check: () => ipcRenderer.invoke(CH.update.check),
    download: () => ipcRenderer.invoke(CH.update.download),
    restart: () => ipcRenderer.send(CH.update.restart),
    openRelease: () => ipcRenderer.send(CH.update.openRelease),
    onProgress: (cb) => {
      const handler = (_e: unknown, p: UpdateProgress): void => cb(p)
      ipcRenderer.on(CH.update.progress, handler)
      return () => ipcRenderer.removeListener(CH.update.progress, handler)
    },
    offer: () => ipcRenderer.invoke(CH.update.offer),
    onOffer: (cb) => {
      const handler = (_e: unknown, offer: UpdateCheckResult | null): void => cb(offer)
      ipcRenderer.on(CH.update.offer, handler)
      return () => ipcRenderer.removeListener(CH.update.offer, handler)
    }
  },
  windowFocus: {
    onChange: (cb) => {
      const handler = (_e: unknown, focused: boolean): void => cb(focused)
      ipcRenderer.on(CH.window.focus, handler)
      return () => ipcRenderer.removeListener(CH.window.focus, handler)
    }
  },
  windowFullscreen: {
    get: () => ipcRenderer.invoke(CH.window.isFullScreen),
    onChange: (cb) => {
      const handler = (_e: unknown, on: boolean): void => cb(on)
      ipcRenderer.on(CH.window.fullscreen, handler)
      return () => ipcRenderer.removeListener(CH.window.fullscreen, handler)
    }
  },
  shortcuts: {
    onNewTerminalTab: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.newTerminalTab, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.newTerminalTab, handler)
    },
    onFocusNotes: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.focusNotes, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.focusNotes, handler)
    },
    onNextWaitingSession: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.nextWaitingSession, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.nextWaitingSession, handler)
    },
    onToggleSidebar: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.toggleSidebar, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.toggleSidebar, handler)
    },
    onNewSession: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.newSession, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.newSession, handler)
    },
    onNewWorktreeSession: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.newWorktreeSession, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.newWorktreeSession, handler)
    },
    onCloseTab: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.closeTab, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.closeTab, handler)
    },
    onFind: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.find, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.find, handler)
    },
    onCheckUpdate: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.checkUpdate, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.checkUpdate, handler)
    },
    onOpenSettings: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.openSettings, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.openSettings, handler)
    },
    onCommandPalette: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.commandPalette, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.commandPalette, handler)
    },
    onRestartSession: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.restartSession, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.restartSession, handler)
    },
    onAddWorkspace: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.addWorkspace, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.addWorkspace, handler)
    },
    onSave: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.save, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.save, handler)
    },
    onFindFiles: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.findFiles, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.findFiles, handler)
    },
    onWorkbenchShortcut: (cb) => {
      const handler = (_e: unknown, cmd: WorkbenchShortcut): void => cb(cmd)
      ipcRenderer.on(CH.shortcut.workbench, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.workbench, handler)
    },
    onBrowserCommand: (cb) => {
      const handler = (_e: unknown, cmd: BrowserCommand): void => cb(cmd)
      ipcRenderer.on(CH.shortcut.browser, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.browser, handler)
    },
    windowCommand: (cmd) => ipcRenderer.send(CH.shortcut.window, cmd)
  },
  webgl: {
    onRepair: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.webgl.repair, handler)
      return () => ipcRenderer.removeListener(CH.webgl.repair, handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

injectBrowserAction()
