import { contextBridge, ipcRenderer } from 'electron'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'
import type {
  WorkbenchShortcut,
  BrowserCommand,
  CreateTabOptions,
  TerminalData,
  TerminalExit,
  TerminalCwd,
  ScreenRequest,
  ScreenSize,
  TerminalProcessTitle,
  SpawnedTab,
  UsageRead,
  MachineState,
  AccountView,
  GitAccountView,
  GitLoginProgress,
  LoginProgress,
  SignInFailure,
  Settings,
  UpdateProgress,
  UpdateCheckResult,
  WorkspaceRows
} from '@shared/types'
import { CH } from '@shared/ipcChannels'
import type { PreloadIpc } from '@core/ipc'
import { pluginBridges, type KoloftApi } from '@plugins/bridges'
import { TerminalDataSinks } from './terminalDataSinks'

const terminalDataSinks = new TerminalDataSinks()
ipcRenderer.on(CH.terminal.data, (_e, d: TerminalData) => terminalDataSinks.deliver(d.id, d.data))

const pluginIpc: PreloadIpc = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
  listen: (channel, listener) => {
    const handler = (_e: unknown, ...args: Parameters<typeof listener>): void => listener(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

const api: KoloftApi = {
  ...pluginBridges(pluginIpc),
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
    copy: (text) => ipcRenderer.send(CH.terminal.copy, text),
    ack: (id, utf16Units) => ipcRenderer.send(CH.terminal.ack, id, utf16Units),
    attach: (id) => ipcRenderer.send(CH.terminal.attach, id),
    onScreen: (id, onScreen) => ipcRenderer.send(CH.terminal.onScreen, id, onScreen),
    flowStats: () => ipcRenderer.invoke(CH.terminal.flowStats),
    resize: (id, cols, rows, sessionScreen) =>
      ipcRenderer.send(CH.terminal.resize, id, cols, rows, sessionScreen),
    kill: (id, restarting) => ipcRenderer.send(CH.terminal.kill, id, restarting),
    onData: (id, cb) => terminalDataSinks.listen(id, cb),
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
  toast: {
    onShow: (cb) => {
      const handler = (_e: unknown, text: string): void => cb(text)
      ipcRenderer.on(CH.toast.show, handler)
      return () => ipcRenderer.removeListener(CH.toast.show, handler)
    }
  },
  machine: {
    onState: (cb) => {
      const handler = (_e: unknown, s: MachineState): void => cb(s)
      ipcRenderer.on(CH.machine.state, handler)
      return () => ipcRenderer.removeListener(CH.machine.state, handler)
    },
    now: () => ipcRenderer.invoke(CH.machine.now),
    free: (tabId) => ipcRenderer.invoke(CH.machine.free, tabId)
  },
  palette: {
    savePicture: (dataUrl) => ipcRenderer.invoke(CH.palette.savePicture, dataUrl)
  },
  sessionScreenAtLoad: ipcRenderer.sendSync(CH.terminal.sessionScreen) as ScreenSize | null,
  browserTabCap: Number(process.env.KOLOFT_BROWSER_TAB_CAP) || 0,
  git: {
    commit: (root, message) => ipcRenderer.invoke(CH.git.commit, root, message),
    push: (root) => ipcRenderer.invoke(CH.git.push, root),
    readiness: (root) => ipcRenderer.invoke(CH.git.readiness, root)
  },
  os: {
    open: (p) => ipcRenderer.send(CH.os.open, p),
    reveal: (p) => ipcRenderer.send(CH.os.reveal, p)
  },
  workspace: {
    pickFolder: () => ipcRenderer.invoke(CH.workspace.pickFolder),
    add: (p) => ipcRenderer.invoke(CH.workspace.add, p),
    remove: (p) => ipcRenderer.invoke(CH.workspace.remove, p),
    removeConfirmed: (p) => ipcRenderer.invoke(CH.workspace.removeConfirmed, p),
    move: (p, before) => ipcRenderer.invoke(CH.workspace.move, p, before),
    historyRows: (p, opts) => ipcRenderer.invoke(CH.workspace.historyRows, p, opts),
    rows: () => ipcRenderer.invoke(CH.workspace.rows),
    onRows: (cb) => {
      const handler = (_e: unknown, rows: WorkspaceRows[]): void => cb(rows)
      ipcRenderer.on(CH.workspace.rows, handler)
      return () => ipcRenderer.removeListener(CH.workspace.rows, handler)
    },
    fetchFreshness: (p) => ipcRenderer.invoke(CH.workspace.fetchFreshness, p),
    pull: (p, expect) => ipcRenderer.invoke(CH.workspace.pull, p, expect),
    discover: () => ipcRenderer.invoke(CH.workspace.discover),
    pinRecent: (paths) => ipcRenderer.invoke(CH.workspace.pinRecent, paths),
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
    remove: (id, machine, anyway) => ipcRenderer.invoke(CH.gitAccounts.remove, id, machine, anyway),
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
    onCloseSession: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(CH.shortcut.closeSession, handler)
      return () => ipcRenderer.removeListener(CH.shortcut.closeSession, handler)
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
