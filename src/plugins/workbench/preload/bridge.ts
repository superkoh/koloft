import type { PreloadIpc } from '@core/ipc'
import type {
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
  }
})
