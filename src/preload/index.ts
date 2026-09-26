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
  TerminalProcessTitle,
  LeftoverProcess,
  SessionInfo,
  SpawnedTab,
  CronState,
  AttentionEvent,
  AccountView,
  LoginProgress,
  Settings,
  UpdateProgress,
  UpdateCheckResult,
  OpenRequest,
  WorkspaceRows
} from '@shared/types'

const api: KoloftApi = {
  isDev: ipcRenderer.sendSync('app:isDev') as boolean,
  domRenderer: process.env.KOLOFT_DOM_RENDERER === '1',
  testMode: process.env.KOLOFT_TEST_BACKGROUND === '1',
  home: ipcRenderer.sendSync('app:home') as string,
  app: {
    onQuitRequested: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('app:quit-requested', handler)
      return () => ipcRenderer.removeListener('app:quit-requested', handler)
    },
    approveQuit: () => ipcRenderer.send('app:quit-approved'),
    holdQuit: () => ipcRenderer.send('app:quit-held'),
    declineQuit: () => ipcRenderer.send('app:quit-declined')
  },
  terminal: {
    create: (opts: CreateTabOptions) => ipcRenderer.invoke('terminal:create', opts),
    write: (id, data) => ipcRenderer.send('terminal:write', id, data),
    ack: (id, utf16Units) => ipcRenderer.send('terminal:ack', id, utf16Units),
    attach: (id) => ipcRenderer.send('terminal:attach', id),
    flowStats: () => ipcRenderer.invoke('terminal:flowStats'),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('terminal:kill', id),
    onData: (cb) => {
      const handler = (_e: unknown, d: TerminalData): void => cb(d)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },
    onExit: (cb) => {
      const handler = (_e: unknown, e: TerminalExit): void => cb(e)
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.removeListener('terminal:exit', handler)
    },
    onProcessTitle: (cb) => {
      const handler = (_e: unknown, t: TerminalProcessTitle): void => cb(t)
      ipcRenderer.on('terminal:processTitle', handler)
      return () => ipcRenderer.removeListener('terminal:processTitle', handler)
    },
    onCwd: (cb) => {
      const handler = (_e: unknown, c: TerminalCwd): void => cb(c)
      ipcRenderer.on('terminal:cwd', handler)
      return () => ipcRenderer.removeListener('terminal:cwd', handler)
    },
    onSpawned: (cb) => {
      const handler = (_e: unknown, t: SpawnedTab): void => cb(t)
      ipcRenderer.on('terminal:spawned', handler)
      return () => ipcRenderer.removeListener('terminal:spawned', handler)
    }
  },
  workbench: {
    get: (sessionId) => ipcRenderer.invoke('workbench:get', sessionId),
    setState: (sessionId, state) => ipcRenderer.send('workbench:setState', sessionId, state),
    setAvailable: (available, terminal) =>
      ipcRenderer.send('workbench:available', available, terminal),
    setFindAvailable: (available) => ipcRenderer.send('workbench:findAvailable', available),
    setSaveAvailable: (available) => ipcRenderer.send('workbench:saveAvailable', available),
    setDirtyTabs: (ids) => ipcRenderer.send('workbench:dirtyTabs', ids)
  },
  tabs: {
    list: () => ipcRenderer.invoke('tabs:list'),
    onKilledByMain: (cb) => {
      const handler = (_e: unknown, tabId: string): void => cb(tabId)
      ipcRenderer.on('tab:killedByMain', handler)
      return () => ipcRenderer.removeListener('tab:killedByMain', handler)
    }
  },
  sessions: {
    backends: () => ipcRenderer.invoke('sessions:backends'),
    onUpdate: (cb) => {
      const handler = (_e: unknown, s: SessionInfo[]): void => cb(s)
      ipcRenderer.on('sessions:update', handler)
      return () => ipcRenderer.removeListener('sessions:update', handler)
    },
    onRelocated: (cb) => {
      const handler = (_e: unknown, x: { tabId: string; dir: string }): void => cb(x)
      ipcRenderer.on('session:relocated', handler)
      return () => ipcRenderer.removeListener('session:relocated', handler)
    },
    noteActivity: (tabId) => ipcRenderer.send('sessions:activity', tabId),
    list: () => ipcRenderer.invoke('sessions:list'),
    resumePlan: (id) => ipcRenderer.invoke('sessions:resumePlan', id),
    resume: (req) => ipcRenderer.invoke('sessions:resume', req),
    archive: (id) => ipcRenderer.invoke('sessions:archive', id),
    forceClose: (id) => ipcRenderer.invoke('sessions:forceClose', id),
    transcriptExists: (id) => ipcRenderer.invoke('sessions:transcriptExists', id),
    leftovers: () => ipcRenderer.invoke('sessions:leftovers'),
    onLeftovers: (cb) => {
      const handler = (_e: unknown, l: Record<string, LeftoverProcess[]>): void => cb(l)
      ipcRenderer.on('sessions:leftovers', handler)
      return () => ipcRenderer.removeListener('sessions:leftovers', handler)
    },
    stopLeftover: (sessionId, pid) => ipcRenderer.invoke('sessions:stopLeftover', sessionId, pid)
  },
  cron: {
    list: () => ipcRenderer.invoke('cron:list'),
    save: (input) => ipcRenderer.invoke('cron:save', input),
    delete: (jobId) => ipcRenderer.invoke('cron:delete', jobId),
    setEnabled: (jobId, on) => ipcRenderer.invoke('cron:setEnabled', { jobId, on }),
    runNow: (jobId) => ipcRenderer.invoke('cron:runNow', jobId),
    skills: (workspacePath) => ipcRenderer.invoke('cron:skills', workspacePath),
    trusted: (workspacePath, backend) => ipcRenderer.invoke('cron:trusted', workspacePath, backend),
    onState: (cb) => {
      const handler = (_e: unknown, s: CronState): void => cb(s)
      ipcRenderer.on('cron:state', handler)
      return () => ipcRenderer.removeListener('cron:state', handler)
    },
    onToast: (cb) => {
      const handler = (_e: unknown, text: string): void => cb(text)
      ipcRenderer.on('cron:toast', handler)
      return () => ipcRenderer.removeListener('cron:toast', handler)
    }
  },
  attention: {
    list: () => ipcRenderer.invoke('attention:list'),
    activeTab: (id) => ipcRenderer.send('attention:active-tab', id),
    visit: (id) => ipcRenderer.send('attention:visit', id),
    onActivateTab: (cb) => {
      const handler = (_e: unknown, p: { tabId: string }): void => cb(p.tabId)
      ipcRenderer.on('attention:activate-tab', handler)
      return () => ipcRenderer.removeListener('attention:activate-tab', handler)
    }
  },
  preview: {
    readText: (p) => ipcRenderer.invoke('preview:readText', p),
    openFileDialog: () => ipcRenderer.invoke('preview:openFileDialog'),
    osOpen: (p) => ipcRenderer.send('preview:os-open', p),
    fileUrl: (p) => `koloft-file://localhost${encodeURI(p)}`,
    onOpenRequest: (cb) => {
      const handler = (_e: unknown, r: OpenRequest): void => cb(r)
      ipcRenderer.on('preview:open-file', handler)
      return () => ipcRenderer.removeListener('preview:open-file', handler)
    }
  },
  browserGuestLimit: ipcRenderer.sendSync('browser:guest-limit') as number,
  browserTabCap: Number(process.env.KOLOFT_BROWSER_TAB_CAP) || 0,
  browser: {
    onOpenRequest: (cb) => {
      const handler = (_e: unknown, r: BrowserOpenRequest): void => cb(r)
      ipcRenderer.on('browser:open', handler)
      return () => ipcRenderer.removeListener('browser:open', handler)
    },
    onDownload: (cb) => {
      const handler = (_e: unknown, d: BrowserDownload): void => cb(d)
      ipcRenderer.on('browser:download', handler)
      return () => ipcRenderer.removeListener('browser:download', handler)
    },
    onDownloadEvent(cb: (e: BrowserDownloadEvent) => void) {
      const handler = (_e: unknown, ev: BrowserDownloadEvent): void => cb(ev)
      ipcRenderer.on('browser:download-event', handler)
      return () => ipcRenderer.removeListener('browser:download-event', handler)
    },
    cancelDownload: (id: string) => ipcRenderer.send('browser:download-cancel', id),
    retryDownload: (id: string) => ipcRenderer.send('browser:download-retry', id),
    onPermissionAsk(cb: (a: BrowserPermissionAsk) => void) {
      const handler = (_e: unknown, a: BrowserPermissionAsk): void => cb(a)
      ipcRenderer.on('browser:permission-ask', handler)
      return () => ipcRenderer.removeListener('browser:permission-ask', handler)
    },
    onPermissionRefused(cb: (r: BrowserPermissionRefusal) => void) {
      const handler = (_e: unknown, r: BrowserPermissionRefusal): void => cb(r)
      ipcRenderer.on('browser:permission-refused', handler)
      return () => ipcRenderer.removeListener('browser:permission-refused', handler)
    },
    onPermissionDrop(cb: (id: string) => void) {
      const handler = (_e: unknown, id: string): void => cb(id)
      ipcRenderer.on('browser:permission-drop', handler)
      return () => ipcRenderer.removeListener('browser:permission-drop', handler)
    },
    answerPermission: (id: string, granted: boolean) =>
      ipcRenderer.send('browser:permission-answer', id, granted),
    cancelPermission: (id: string) => ipcRenderer.send('browser:permission-cancel', id),
    onAudioState(cb: (s: BrowserAudioState) => void) {
      const handler = (_e: unknown, st: BrowserAudioState): void => cb(st)
      ipcRenderer.on('browser:audio-state', handler)
      return () => ipcRenderer.removeListener('browser:audio-state', handler)
    },
    setMuted: (guestId: number, muted: boolean) =>
      ipcRenderer.send('browser:set-muted', guestId, muted),
    copyText: (text: string) => ipcRenderer.send('browser:copy-text', text),
    onFullscreen(cb: (on: boolean) => void) {
      const handler = (_e: unknown, on: boolean): void => cb(on)
      ipcRenderer.on('browser:fullscreen', handler)
      return () => ipcRenderer.removeListener('browser:fullscreen', handler)
    },
    onBlockedScheme: (cb) => {
      const handler = (_e: unknown, url: string): void => cb(url)
      ipcRenderer.on('browser:blocked-scheme', handler)
      return () => ipcRenderer.removeListener('browser:blocked-scheme', handler)
    },
    onAuthChallenge: (cb) => {
      const handler = (_e: unknown, c: BrowserAuthChallenge): void => cb(c)
      ipcRenderer.on('browser:auth-challenge', handler)
      return () => ipcRenderer.removeListener('browser:auth-challenge', handler)
    },
    answerAuthChallenge: (id, answer) => ipcRenderer.send('browser:auth-answer', id, answer),
    onJsDialog: (cb) => {
      const handler = (_e: unknown, d: BrowserJsDialog): void => cb(d)
      ipcRenderer.on('browser:js-dialog', handler)
      return () => ipcRenderer.removeListener('browser:js-dialog', handler)
    },
    answerJsDialog: (id, answer) => ipcRenderer.send('browser:js-dialog-answer', id, answer),
    overlayReady: () => ipcRenderer.send('browser:overlay-ready'),
    onOverlayOpen: (cb) => {
      const handler = (_e: unknown, o: BrowserOverlayOpen): void => cb(o)
      ipcRenderer.on('browser:overlay-open', handler)
      return () => ipcRenderer.removeListener('browser:overlay-open', handler)
    },
    setOverlayGuest: (guestId, on) => ipcRenderer.send('browser:overlay-guest', guestId, on),
    reportStrip: (sessionId, targets) => ipcRenderer.send('browser:strip', sessionId, targets),
    onCdpOp: (cb) => {
      const handler = (_e: unknown, op: BrowserCdpOp): void => cb(op)
      ipcRenderer.on('browser:cdp-op', handler)
      return () => ipcRenderer.removeListener('browser:cdp-op', handler)
    },
    answerCdpOp: (res) => ipcRenderer.send('browser:cdp-op-done', res),
    onCdpAttached: (cb) => {
      const handler = (_e: unknown, a: BrowserCdpAttached): void => cb(a)
      ipcRenderer.on('browser:cdp-attached', handler)
      return () => ipcRenderer.removeListener('browser:cdp-attached', handler)
    },
    certProceed: (url) => ipcRenderer.invoke('browser:cert-proceed', url),
    clearData: () => ipcRenderer.invoke('browser:clear-data'),
    openExternal: (url) => ipcRenderer.send('browser:open-external', url),
    toggleDevTools: (guestId) => ipcRenderer.send('browser:devtools', guestId)
  },
  extensions: {
    list: () => ipcRenderer.invoke('ext:list'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('ext:set-enabled', id, enabled),
    uninstall: (id) => ipcRenderer.invoke('ext:uninstall', id),
    onChanged: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('ext:changed', handler)
      return () => ipcRenderer.removeListener('ext:changed', handler)
    },
    activeGuest: (webContentsId, url) => ipcRenderer.send('ext:active-guest', webContentsId, url),
    openDropped: (url) => ipcRenderer.send('ext:open-dropped', url),
    anchorPopup: (rect) => ipcRenderer.invoke('ext:popup-anchor', rect),
    dismissPopup: () => ipcRenderer.send('ext:dismiss-popup'),
    onPermissionRequest: (cb) => {
      const handler = (_e: unknown, r: ExtensionPermissionRequest): void => cb(r)
      ipcRenderer.on('ext:permission-request', handler)
      return () => ipcRenderer.removeListener('ext:permission-request', handler)
    },
    answerPermissionRequest: (id, granted) => ipcRenderer.send('ext:permission-answer', id, granted)
  },
  fs: {
    listDir: (p, opts) => ipcRenderer.invoke('fs:listDir', p, opts),
    dirExists: (p) => ipcRenderer.invoke('fs:dirExists', p),
    search: (root, q, opts) => ipcRenderer.invoke('fs:search', root, q, opts),
    diffBase: (root) => ipcRenderer.invoke('fs:diffBase', root),
    gitStatus: (root, base) => ipcRenderer.invoke('fs:gitStatus', root, base),
    gitNumstat: (root, base) => ipcRenderer.invoke('fs:gitNumstat', root, base),
    watchDir: (root) => ipcRenderer.invoke('fs:watchDir', root),
    unwatchDir: (root) => ipcRenderer.send('fs:unwatchDir', root),
    onDirChange: (cb) => {
      const handler = (_e: unknown, root: string): void => cb(root)
      ipcRenderer.on('fs:dir-changed', handler)
      return () => ipcRenderer.removeListener('fs:dir-changed', handler)
    },
    watchFile: (p) => ipcRenderer.send('fs:watchFile', p),
    unwatchFile: (p) => ipcRenderer.send('fs:unwatchFile', p),
    onFileChange: (cb) => {
      const handler = (_e: unknown, p: string, fp?: EditFingerprint): void => cb(p, fp)
      ipcRenderer.on('fs:file-changed', handler)
      return () => ipcRenderer.removeListener('fs:file-changed', handler)
    },
    reveal: (p) => ipcRenderer.send('fs:reveal', p),
    gitDiff: (root, base) => ipcRenderer.invoke('fs:gitDiff', root, base),
    gitFileDiff: (p, base, untracked) => ipcRenderer.invoke('fs:gitFileDiff', p, base, untracked),
    gitFileDiffFull: (p, base, untracked) =>
      ipcRenderer.invoke('fs:gitFileDiffFull', p, base, untracked),
    searchContent: (root, q, opts) => ipcRenderer.invoke('fs:searchContent', root, q, opts)
  },
  edit: {
    open: (p) => ipcRenderer.invoke('edit:open', p),
    write: (p, text, expect, opts) => ipcRenderer.invoke('edit:write', p, text, expect, opts),
    create: (dirPath, name) => ipcRenderer.invoke('edit:create', dirPath, name)
  },
  notes: {
    path: (ws) => ipcRenderer.invoke('notes:path', ws)
  },
  github: {
    info: (root, force) => ipcRenderer.invoke('github:info', root, force),
    target: (root, what) => ipcRenderer.invoke('github:target', root, what),
    onInfo: (cb) => {
      const handler = (_e: unknown, root: string, info: GithubInfo): void => cb(root, info)
      ipcRenderer.on('github:info', handler)
      return () => ipcRenderer.removeListener('github:info', handler)
    }
  },
  workspace: {
    pickFolder: () => ipcRenderer.invoke('workspace:pickFolder'),
    add: (p) => ipcRenderer.invoke('workspace:add', p),
    remove: (p) => ipcRenderer.invoke('workspace:remove', p),
    removeConfirmed: (p) => ipcRenderer.invoke('workspace:removeConfirmed', p),
    worktrees: (p) => ipcRenderer.invoke('workspace:worktrees', p),
    historyRows: (p) => ipcRenderer.invoke('workspace:historyRows', p),
    rows: () => ipcRenderer.invoke('workspace:rows'),
    onRows: (cb) => {
      const handler = (_e: unknown, rows: WorkspaceRows[]): void => cb(rows)
      ipcRenderer.on('workspace:rows', handler)
      return () => ipcRenderer.removeListener('workspace:rows', handler)
    },
    fetchFreshness: (p) => ipcRenderer.invoke('workspace:fetchFreshness', p),
    pull: (p, expect) => ipcRenderer.invoke('workspace:pull', p, expect),
    discover: () => ipcRenderer.invoke('workspace:discover')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onUpdate: (cb) => {
      const handler = (_e: unknown, s: Settings): void => cb(s)
      ipcRenderer.on('settings:update', handler)
      return () => ipcRenderer.removeListener('settings:update', handler)
    }
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: (name, kind, secret, endpoint) =>
      ipcRenderer.invoke('accounts:add', name, kind, secret, endpoint),
    remove: (name, kind) => ipcRenderer.invoke('accounts:remove', name, kind),
    toggle: (name, kind, enabled) => ipcRenderer.invoke('accounts:toggle', name, kind, enabled),
    probe: () => ipcRenderer.invoke('accounts:probe'),
    startLogin: (name, reauth) => ipcRenderer.invoke('accounts:start-login', name, reauth),
    cancelLogin: () => ipcRenderer.send('accounts:cancel-login'),
    codexSignIn: (name, again) => ipcRenderer.invoke('accounts:codex-sign-in', name, again),
    onLoginProgress: (cb) => {
      const handler = (_e: unknown, p: LoginProgress): void => cb(p)
      ipcRenderer.on('accounts:login-progress', handler)
      return () => ipcRenderer.removeListener('accounts:login-progress', handler)
    },
    onUpdate: (cb) => {
      const handler = (_e: unknown, a: AccountView[]): void => cb(a)
      ipcRenderer.on('accounts:update', handler)
      return () => ipcRenderer.removeListener('accounts:update', handler)
    }
  },
  update: {
    version: () => ipcRenderer.invoke('app:version'),
    whatsNew: () => ipcRenderer.invoke('update:whatsNew'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    restart: () => ipcRenderer.send('update:restart'),
    openRelease: () => ipcRenderer.send('update:openRelease'),
    onProgress: (cb) => {
      const handler = (_e: unknown, p: UpdateProgress): void => cb(p)
      ipcRenderer.on('update:progress', handler)
      return () => ipcRenderer.removeListener('update:progress', handler)
    },
    offer: () => ipcRenderer.invoke('update:offer'),
    onOffer: (cb) => {
      const handler = (_e: unknown, offer: UpdateCheckResult | null): void => cb(offer)
      ipcRenderer.on('update:offer', handler)
      return () => ipcRenderer.removeListener('update:offer', handler)
    }
  },
  windowFocus: {
    onChange: (cb) => {
      const handler = (_e: unknown, focused: boolean): void => cb(focused)
      ipcRenderer.on('window:focus', handler)
      return () => ipcRenderer.removeListener('window:focus', handler)
    }
  },
  shortcuts: {
    onNewTerminalTab: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:new-terminal-tab', handler)
      return () => ipcRenderer.removeListener('shortcut:new-terminal-tab', handler)
    },
    onFocusNotes: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:focus-notes', handler)
      return () => ipcRenderer.removeListener('shortcut:focus-notes', handler)
    },
    onNewSession: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:new-session', handler)
      return () => ipcRenderer.removeListener('shortcut:new-session', handler)
    },
    onNewWorktreeSession: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:new-worktree-session', handler)
      return () => ipcRenderer.removeListener('shortcut:new-worktree-session', handler)
    },
    onCloseTab: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:close-tab', handler)
      return () => ipcRenderer.removeListener('shortcut:close-tab', handler)
    },
    onFind: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:find', handler)
      return () => ipcRenderer.removeListener('shortcut:find', handler)
    },
    onCheckUpdate: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:check-update', handler)
      return () => ipcRenderer.removeListener('shortcut:check-update', handler)
    },
    onOpenSettings: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:open-settings', handler)
      return () => ipcRenderer.removeListener('shortcut:open-settings', handler)
    },
    onRestartSession: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:restart-session', handler)
      return () => ipcRenderer.removeListener('shortcut:restart-session', handler)
    },
    onAddWorkspace: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:add-workspace', handler)
      return () => ipcRenderer.removeListener('shortcut:add-workspace', handler)
    },
    onSave: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:save', handler)
      return () => ipcRenderer.removeListener('shortcut:save', handler)
    },
    onFindFiles: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('shortcut:find-files', handler)
      return () => ipcRenderer.removeListener('shortcut:find-files', handler)
    },
    onWorkbenchShortcut: (cb) => {
      const handler = (_e: unknown, cmd: WorkbenchShortcut): void => cb(cmd)
      ipcRenderer.on('shortcut:workbench', handler)
      return () => ipcRenderer.removeListener('shortcut:workbench', handler)
    },
    onBrowserCommand: (cb) => {
      const handler = (_e: unknown, cmd: BrowserCommand): void => cb(cmd)
      ipcRenderer.on('shortcut:browser', handler)
      return () => ipcRenderer.removeListener('shortcut:browser', handler)
    },
    windowCommand: (cmd) => ipcRenderer.send('shortcut:window', cmd)
  },
  webgl: {
    onRepair: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('webgl:repair', handler)
      return () => ipcRenderer.removeListener('webgl:repair', handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

injectBrowserAction()
