export const CH = {
  terminal: {
    data: 'terminal:data',
    create: 'terminal:create',
    write: 'terminal:write',
    paste: 'terminal:paste',
    copy: 'terminal:copy',
    ack: 'terminal:ack',
    attach: 'terminal:attach',
    onScreen: 'terminal:on-screen',
    flowStats: 'terminal:flowStats',
    resize: 'terminal:resize',
    sessionScreen: 'terminal:session-screen',
    kill: 'terminal:kill',
    exit: 'terminal:exit',
    processTitle: 'terminal:processTitle',
    cwd: 'terminal:cwd',
    spawned: 'terminal:spawned',
    screen: 'terminal:screen',
    screenDone: 'terminal:screen-done',
    unexpectedExit: 'terminal:unexpected-exit'
  },
  app: {
    isDev: 'app:isDev',
    home: 'app:home',
    quitRequested: 'app:quit-requested',
    quitApproved: 'app:quit-approved',
    quitHeld: 'app:quit-held',
    quitDeclined: 'app:quit-declined',
    version: 'app:version'
  },
  tabs: {
    list: 'tabs:list',
    moved: 'tabs:moved'
  },
  tab: {
    killedByMain: 'tab:killedByMain',
    slept: 'tab:slept'
  },
  usage: {
    read: 'usage:read',
    changed: 'usage:changed'
  },
  toast: {
    show: 'toast:show'
  },
  machine: {
    state: 'machine:state',
    now: 'machine:now',
    free: 'machine:free'
  },
  palette: {
    savePicture: 'palette:savePicture'
  },
  git: {
    commit: 'github:commit',
    push: 'github:push',
    readiness: 'git:readiness'
  },
  os: {
    open: 'preview:os-open',
    reveal: 'fs:reveal'
  },
  workspace: {
    pickFolder: 'workspace:pickFolder',
    add: 'workspace:add',
    remove: 'workspace:remove',
    removeConfirmed: 'workspace:removeConfirmed',
    move: 'workspace:move',
    historyRows: 'workspace:historyRows',
    rows: 'workspace:rows',
    fetchFreshness: 'workspace:fetchFreshness',
    pull: 'workspace:pull',
    discover: 'workspace:discover',
    pinRecent: 'workspace:pinRecent'
  },
  project: {
    create: 'project:create'
  },
  assist: {
    route: 'assist:route',
    cancel: 'assist:cancel'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    update: 'settings:update'
  },
  accounts: {
    list: 'accounts:list',
    add: 'accounts:add',
    remove: 'accounts:remove',
    toggle: 'accounts:toggle',
    probe: 'accounts:probe',
    startLogin: 'accounts:start-login',
    cancelLogin: 'accounts:cancel-login',
    signIn: 'accounts:sign-in',
    signInFailure: 'accounts:sign-in-failure',
    dismissSignInFailure: 'accounts:dismiss-sign-in-failure',
    codexUseReset: 'accounts:codex-use-reset',
    loginProgress: 'accounts:login-progress',
    update: 'accounts:update'
  },
  gitAccounts: {
    list: 'gitAccounts:list',
    update: 'gitAccounts:update',
    loginStart: 'gitAccounts:login-start',
    loginCancel: 'gitAccounts:login-cancel',
    loginBrowser: 'gitAccounts:login-browser',
    loginProgress: 'gitAccounts:login-progress',
    addToken: 'gitAccounts:add-token',
    remove: 'gitAccounts:remove',
    makeDefault: 'gitAccounts:make-default',
    check: 'gitAccounts:check',
    pick: 'gitAccounts:pick',
    suggest: 'gitAccounts:suggest',
    dismiss: 'gitAccounts:dismiss',
    makeSshKey: 'gitAccounts:make-ssh-key',
    checkSshKey: 'gitAccounts:check-ssh-key'
  },
  update: {
    check: 'update:check',
    download: 'update:download',
    restart: 'update:restart',
    openRelease: 'update:openRelease',
    progress: 'update:progress',
    offer: 'update:offer'
  },
  window: {
    focus: 'window:focus',
    isFullScreen: 'window:isFullScreen',
    fullscreen: 'window:fullscreen'
  },
  shortcut: {
    newTerminalTab: 'shortcut:new-terminal-tab',
    focusNotes: 'shortcut:focus-notes',
    nextWaitingSession: 'shortcut:next-waiting-session',
    toggleSidebar: 'shortcut:toggle-sidebar',
    newSession: 'shortcut:new-session',
    newWorktreeSession: 'shortcut:new-worktree-session',
    closeTab: 'shortcut:close-tab',
    find: 'shortcut:find',
    checkUpdate: 'shortcut:check-update',
    openSettings: 'shortcut:open-settings',
    commandPalette: 'shortcut:command-palette',
    restartSession: 'shortcut:restart-session',
    addWorkspace: 'shortcut:add-workspace',
    save: 'shortcut:save',
    findFiles: 'shortcut:find-files',
    workbench: 'shortcut:workbench',
    browser: 'shortcut:browser',
    window: 'shortcut:window'
  },
  webgl: {
    repair: 'webgl:repair'
  }
} as const

type Leaves<T> = T extends string ? T : { [K in keyof T]: Leaves<T[K]> }[keyof T]

export type Channel = Leaves<typeof CH>
