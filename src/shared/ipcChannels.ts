export const CH = {
  terminal: {
    data: 'terminal:data',
    create: 'terminal:create',
    write: 'terminal:write',
    paste: 'terminal:paste',
    ack: 'terminal:ack',
    attach: 'terminal:attach',
    flowStats: 'terminal:flowStats',
    resize: 'terminal:resize',
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
  workbench: {
    get: 'workbench:get',
    setState: 'workbench:setState',
    available: 'workbench:available',
    findAvailable: 'workbench:findAvailable',
    saveAvailable: 'workbench:saveAvailable',
    dirtyTabs: 'workbench:dirtyTabs'
  },
  tabs: {
    list: 'tabs:list',
    moved: 'tabs:moved'
  },
  tab: {
    killedByMain: 'tab:killedByMain',
    slept: 'tab:slept'
  },
  sessions: {
    backends: 'sessions:backends',
    installTool: 'sessions:installTool',
    toolsChanged: 'sessions:toolsChanged',
    update: 'sessions:update',
    activity: 'sessions:activity',
    list: 'sessions:list',
    resumePlan: 'sessions:resumePlan',
    resume: 'sessions:resume',
    archive: 'sessions:archive',
    setResident: 'sessions:setResident',
    forceClose: 'sessions:forceClose',
    transcriptExists: 'sessions:transcriptExists',
    noAccountToResume: 'sessions:noAccountToResume',
    leftovers: 'sessions:leftovers',
    stopLeftover: 'sessions:stopLeftover',
    search: 'sessions:search',
    searchHits: 'sessions:search-hits'
  },
  session: {
    relocated: 'session:relocated'
  },
  usage: {
    read: 'usage:read',
    changed: 'usage:changed'
  },
  cron: {
    list: 'cron:list',
    save: 'cron:save',
    delete: 'cron:delete',
    setEnabled: 'cron:setEnabled',
    runNow: 'cron:runNow',
    skills: 'cron:skills',
    trusted: 'cron:trusted',
    state: 'cron:state',
    toast: 'cron:toast'
  },
  machine: {
    state: 'machine:state',
    now: 'machine:now',
    free: 'machine:free',
    drop: 'machine:drop'
  },
  conductors: {
    bind: 'conductors:bind',
    bindNewChannel: 'conductors:bindNewChannel',
    unbind: 'conductors:unbind',
    open: 'conductors:open',
    startFresh: 'conductors:startFresh',
    fromPalette: 'conductors:fromPalette'
  },
  discord: {
    status: 'discord:status',
    pair: 'discord:pair',
    channels: 'discord:channels',
    setUpWithButler: 'discord:setUpWithButler'
  },
  attention: {
    list: 'attention:list',
    activeTab: 'attention:active-tab',
    activateTab: 'attention:activate-tab',
    changed: 'attention:changed'
  },
  preview: {
    readText: 'preview:readText',
    openFileDialog: 'preview:openFileDialog',
    osOpen: 'preview:os-open',
    openFile: 'preview:open-file'
  },
  browser: {
    guestLimit: 'browser:guest-limit',
    open: 'browser:open',
    download: 'browser:download',
    downloadEvent: 'browser:download-event',
    downloadCancel: 'browser:download-cancel',
    downloadRetry: 'browser:download-retry',
    permissionAsk: 'browser:permission-ask',
    permissionRefused: 'browser:permission-refused',
    permissionDrop: 'browser:permission-drop',
    permissionAnswer: 'browser:permission-answer',
    permissionCancel: 'browser:permission-cancel',
    audioState: 'browser:audio-state',
    setMuted: 'browser:set-muted',
    copyText: 'browser:copy-text',
    fullscreen: 'browser:fullscreen',
    blockedScheme: 'browser:blocked-scheme',
    authChallenge: 'browser:auth-challenge',
    authAnswer: 'browser:auth-answer',
    jsDialog: 'browser:js-dialog',
    jsDialogAnswer: 'browser:js-dialog-answer',
    overlayReady: 'browser:overlay-ready',
    overlayOpen: 'browser:overlay-open',
    overlayGuest: 'browser:overlay-guest',
    guestOwner: 'browser:guest-owner',
    strip: 'browser:strip',
    hostComposing: 'browser:host-composing',
    cdpOp: 'browser:cdp-op',
    cdpOpDone: 'browser:cdp-op-done',
    cdpAttached: 'browser:cdp-attached',
    certProceed: 'browser:cert-proceed',
    clearData: 'browser:clear-data',
    openExternal: 'browser:open-external',
    devtools: 'browser:devtools',
    pickElement: 'browser:pick-element',
    pickStop: 'browser:pick-stop',
    permissionUndecided: 'browser:permission-undecided',
    linkBlocked: 'browser:link-blocked',
    openBackground: 'browser:open-background'
  },
  ext: {
    list: 'ext:list',
    setEnabled: 'ext:set-enabled',
    uninstall: 'ext:uninstall',
    changed: 'ext:changed',
    activeGuest: 'ext:active-guest',
    openDropped: 'ext:open-dropped',
    popupAnchor: 'ext:popup-anchor',
    dismissPopup: 'ext:dismiss-popup',
    permissionRequest: 'ext:permission-request',
    permissionAnswer: 'ext:permission-answer'
  },
  fs: {
    listDir: 'fs:listDir',
    dirExists: 'fs:dirExists',
    search: 'fs:search',
    gitChanges: 'fs:gitChanges',
    watchDir: 'fs:watchDir',
    unwatchDir: 'fs:unwatchDir',
    dirChanged: 'fs:dir-changed',
    watchFile: 'fs:watchFile',
    unwatchFile: 'fs:unwatchFile',
    fileChanged: 'fs:file-changed',
    reveal: 'fs:reveal',
    gitDiff: 'fs:gitDiff',
    gitFileDiff: 'fs:gitFileDiff',
    gitFileDiffFull: 'fs:gitFileDiffFull',
    searchContent: 'fs:searchContent'
  },
  edit: {
    open: 'edit:open',
    write: 'edit:write',
    create: 'edit:create'
  },
  notes: {
    path: 'notes:path'
  },
  github: {
    info: 'github:info',
    target: 'github:target',
    checks: 'github:checks',
    failingChecksText: 'github:failing-checks-text',
    commit: 'github:commit',
    push: 'github:push',
    openItems: 'github:open-items',
    prWorktree: 'github:pr-worktree'
  },
  workspace: {
    pickFolder: 'workspace:pickFolder',
    add: 'workspace:add',
    remove: 'workspace:remove',
    removeConfirmed: 'workspace:removeConfirmed',
    move: 'workspace:move',
    worktrees: 'workspace:worktrees',
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
