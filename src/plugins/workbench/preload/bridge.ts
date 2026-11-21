import type { PreloadIpc } from '@core/ipc'
import type {
  BrowserAudioState,
  BrowserAuthChallenge,
  BrowserDialogAnswer,
  BrowserDownload,
  BrowserDownloadEvent,
  BrowserJsDialog,
  BrowserOpenRequest,
  BrowserOverlayOpen,
  BrowserPagesInUse,
  BrowserPermissionAsk,
  BrowserPermissionRefusal,
  ExtensionInfo,
  ExtensionPermissionRequest,
  ExtensionPopupAnchor,
  BaseChoice,
  ContentHit,
  DirChangeListener,
  DirEntry,
  EditCreateResult,
  EditFingerprint,
  EditOpenResult,
  EditWriteResult,
  GitChanges,
  OpenRequest,
  SearchHit,
  SessionWorkbenchState
} from '@shared/types'
import { CHANNELS } from '../shared/ipc'

export interface WorkbenchBridge {
  workbench: {
    get(sessionId: string): Promise<SessionWorkbenchState>
    setState(sessionId: string, state: SessionWorkbenchState): void
    setAvailable(available: boolean, terminal: boolean): void
    setFindAvailable(available: boolean): void
    setSaveAvailable(available: boolean): void
    setDirtyTabs(ids: string[]): void
  }
  preview: {
    readText(path: string): Promise<string>
    openFileDialog(): Promise<string | null>
    onOpenRequest(cb: (r: OpenRequest) => void): () => void
  }
  fs: {
    listDir(path: string, opts?: { showIgnored?: boolean }): Promise<DirEntry[]>
    dirExists(path: string): Promise<boolean>
    fileExists(path: string): Promise<boolean>
    search(
      path: string,
      query: string,
      opts?: { showIgnored?: boolean }
    ): Promise<{ hits: SearchHit[]; truncated: boolean }>
    gitChanges(root: string, base: BaseChoice): Promise<GitChanges>
    gitHeadLog(root: string): Promise<string | null>
    watchDir(root: string, reportsWhatChangedWhileUnwatched?: boolean): Promise<boolean>
    unwatchDir(root: string): void
    onDirChange(cb: DirChangeListener): () => void
    watchFile(path: string): void
    unwatchFile(path: string): void
    // PLATFORM§28
    onFileChange(cb: (path: string, fp?: EditFingerprint) => void): () => void
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
  browserGuestLimit: number
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
    setGuestOwner(guestId: number, ownerTabId: string): void
    reportComposing(on: boolean): void
    onMemoryCritical(cb: (inUse: BrowserPagesInUse) => void): () => void
    certProceed(url: string): Promise<void>
    clearData(): Promise<void>
    openExternal(url: string): void
    toggleDevTools(guestId: number): void
    pickElement(guestId: number, sessionTabId: string): Promise<string | null>
    stopPick(guestId: number): void
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
}

export const bridge = (ipc: PreloadIpc): WorkbenchBridge => ({
  workbench: {
    get: (sessionId) => ipc.invoke(CHANNELS.get, sessionId),
    setState: (sessionId, state) => ipc.send(CHANNELS.setState, sessionId, state),
    setAvailable: (available, terminal) => ipc.send(CHANNELS.available, available, terminal),
    setFindAvailable: (available) => ipc.send(CHANNELS.findAvailable, available),
    setSaveAvailable: (available) => ipc.send(CHANNELS.saveAvailable, available),
    setDirtyTabs: (ids) => ipc.send(CHANNELS.dirtyTabs, ids)
  },
  preview: {
    readText: (p) => ipc.invoke(CHANNELS.readText, p),
    openFileDialog: () => ipc.invoke(CHANNELS.openFileDialog),
    onOpenRequest: (cb) => ipc.listen(CHANNELS.openFile, cb)
  },
  fs: {
    listDir: (p, opts) => ipc.invoke(CHANNELS.listDir, p, opts),
    dirExists: (p) => ipc.invoke(CHANNELS.dirExists, p),
    fileExists: (p) => ipc.invoke(CHANNELS.fileExists, p),
    search: (root, q, opts) => ipc.invoke(CHANNELS.search, root, q, opts),
    gitChanges: (root, base) => ipc.invoke(CHANNELS.gitChanges, root, base),
    gitHeadLog: (root) => ipc.invoke(CHANNELS.gitHeadLog, root),
    watchDir: (root, reportsWhatChangedWhileUnwatched) =>
      ipc.invoke(CHANNELS.watchDir, root, reportsWhatChangedWhileUnwatched),
    unwatchDir: (root) => ipc.send(CHANNELS.unwatchDir, root),
    onDirChange: (cb) => ipc.listen(CHANNELS.dirChanged, cb),
    watchFile: (p) => ipc.send(CHANNELS.watchFile, p),
    unwatchFile: (p) => ipc.send(CHANNELS.unwatchFile, p),
    onFileChange: (cb) => ipc.listen(CHANNELS.fileChanged, cb),
    gitDiff: (root, base) => ipc.invoke(CHANNELS.gitDiff, root, base),
    gitFileDiff: (p, base, untracked) => ipc.invoke(CHANNELS.gitFileDiff, p, base, untracked),
    gitFileDiffFull: (p, base, untracked) =>
      ipc.invoke(CHANNELS.gitFileDiffFull, p, base, untracked),
    searchContent: (root, q, opts) => ipc.invoke(CHANNELS.searchContent, root, q, opts)
  },
  edit: {
    open: (p) => ipc.invoke(CHANNELS.editOpen, p),
    write: (p, text, expect, opts) => ipc.invoke(CHANNELS.editWrite, p, text, expect, opts),
    create: (dirPath, name) => ipc.invoke(CHANNELS.editCreate, dirPath, name)
  },
  notes: {
    path: (ws) => ipc.invoke(CHANNELS.notesPath, ws)
  },
  browserGuestLimit: ipc.sendSync(CHANNELS.guestLimit),
  browser: {
    onOpenRequest: (cb) => ipc.listen(CHANNELS.pageOpen, cb),
    onDownload: (cb) => ipc.listen(CHANNELS.download, cb),
    onDownloadEvent: (cb) => ipc.listen(CHANNELS.downloadEvent, cb),
    cancelDownload: (id) => ipc.send(CHANNELS.downloadCancel, id),
    retryDownload: (id) => ipc.send(CHANNELS.downloadRetry, id),
    onPermissionAsk: (cb) => ipc.listen(CHANNELS.permissionAsk, cb),
    onPermissionRefused: (cb) => ipc.listen(CHANNELS.permissionRefused, cb),
    onPermissionDrop: (cb) => ipc.listen(CHANNELS.permissionDrop, cb),
    answerPermission: (id, granted) => ipc.send(CHANNELS.permissionAnswer, id, granted),
    cancelPermission: (id) => ipc.send(CHANNELS.permissionCancel, id),
    onAudioState: (cb) => ipc.listen(CHANNELS.audioState, cb),
    setMuted: (guestId, muted) => ipc.send(CHANNELS.setMuted, guestId, muted),
    copyText: (text) => ipc.send(CHANNELS.copyText, text),
    onFullscreen: (cb) => ipc.listen(CHANNELS.fullscreen, cb),
    onBlockedScheme: (cb) => ipc.listen(CHANNELS.blockedScheme, cb),
    onAuthChallenge: (cb) => ipc.listen(CHANNELS.authChallenge, cb),
    answerAuthChallenge: (id, answer) => ipc.send(CHANNELS.authAnswer, id, answer),
    onJsDialog: (cb) => ipc.listen(CHANNELS.jsDialog, cb),
    answerJsDialog: (id, answer) => ipc.send(CHANNELS.jsDialogAnswer, id, answer),
    onOverlayOpen: (cb) => ipc.listen(CHANNELS.overlayOpen, cb),
    overlayReady: () => ipc.send(CHANNELS.overlayReady),
    setOverlayGuest: (guestId, on) => ipc.send(CHANNELS.overlayGuest, guestId, on),
    setGuestOwner: (guestId, ownerTabId) => ipc.send(CHANNELS.guestOwner, guestId, ownerTabId),
    reportComposing: (on) => ipc.send(CHANNELS.hostComposing, on),
    onMemoryCritical: (cb) => ipc.listen(CHANNELS.memoryCritical, cb),
    certProceed: (url) => ipc.invoke(CHANNELS.certProceed, url),
    clearData: () => ipc.invoke(CHANNELS.clearData),
    openExternal: (url) => ipc.send(CHANNELS.openExternal, url),
    toggleDevTools: (guestId) => ipc.send(CHANNELS.devtools, guestId),
    pickElement: (guestId, sessionTabId) => ipc.invoke(CHANNELS.pickElement, guestId, sessionTabId),
    stopPick: (guestId) => ipc.send(CHANNELS.pickStop, guestId)
  },
  extensions: {
    list: () => ipc.invoke(CHANNELS.extList),
    setEnabled: (id, enabled) => ipc.invoke(CHANNELS.extSetEnabled, id, enabled),
    uninstall: (id) => ipc.invoke(CHANNELS.extUninstall, id),
    onChanged: (cb) => ipc.listen(CHANNELS.extChanged, () => cb()),
    activeGuest: (webContentsId, url) => ipc.send(CHANNELS.extActiveGuest, webContentsId, url),
    openDropped: (url) => ipc.send(CHANNELS.extOpenDropped, url),
    anchorPopup: (rect) => ipc.invoke(CHANNELS.extPopupAnchor, rect),
    dismissPopup: () => ipc.send(CHANNELS.extDismissPopup),
    onPermissionRequest: (cb) => ipc.listen(CHANNELS.extPermissionRequest, cb),
    answerPermissionRequest: (id, granted) => ipc.send(CHANNELS.extPermissionAnswer, id, granted)
  }
})
