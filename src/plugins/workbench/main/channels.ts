import type { MainIpc } from '@core/ipc'
import type {
  BaseChoice,
  DirChangeListener,
  OpenRequest,
  SessionWorkbenchState
} from '@shared/types'
import { isAbsoluteOnHost } from '@shared/remoteKey'
import { CHANNELS } from '../shared/channels'

interface ShowIgnored {
  showIgnored?: boolean
}

export interface Files {
  listDir(dir: string, opts?: ShowIgnored): Promise<unknown>
  dirExistsOrThrow(dir: string): Promise<boolean>
  fileExists(file: string): Promise<boolean>
  search(root: string, q: string, opts?: ShowIgnored): Promise<unknown>
  searchContent(root: string, q: string, opts?: ShowIgnored): Promise<unknown>
  gitChanges(root: string, base: BaseChoice): Promise<unknown>
  gitDiff(root: string, base?: string): Promise<unknown>
  gitFileDiff(file: string, base?: string, untracked?: boolean): Promise<unknown>
  gitFileDiffFull(file: string, base?: string, untracked?: boolean): Promise<unknown>
  readText(file: string): Promise<string>
  openForEdit(file: string): Promise<unknown>
  writeText(
    file: string,
    text: string,
    expect: unknown,
    opts?: { force?: unknown; eol?: unknown }
  ): Promise<unknown>
  createFile(dir: string, name: string): Promise<unknown>
  watchDir(
    root: string,
    onChange: DirChangeListener,
    reportsWhatChangedWhileUnwatched?: boolean
  ): Promise<boolean>
  unwatchDir(root: string): void
  watchFile(
    file: string,
    onChange: (file: string, fp: { mtimeMs: number; size: number }) => void
  ): void
  unwatchFile(file: string): void
  reveal(p: string): void
  osOpen(p: string): void
}

export interface ChannelDeps {
  files(p: string): Files
  base(b: unknown): string | undefined
  gitHeadLog(root: string): Promise<string | null>
  notesFile(scope: string): string | undefined
  pickFile(): Promise<string | null>
  state(sessionId: string): unknown
  setState(sessionId: string, state: SessionWorkbenchState): void
  setAvailable(available: boolean, terminal: boolean): void
  setFindAvailable(available: boolean): void
  setSaveAvailable(available: boolean): void
  setDirtyTabs(ids: string[]): void
}

export function registerChannels(ipc: MainIpc, deps: ChannelDeps): void {
  const { files } = deps
  ipc.handle(CHANNELS.get, (sessionId: string) => deps.state(sessionId))
  ipc.on(CHANNELS.setState, (sessionId: string, state: SessionWorkbenchState) => {
    if (typeof sessionId !== 'string' || !sessionId) return
    if (!state || typeof state !== 'object' || !Array.isArray(state.tabs)) return
    deps.setState(sessionId, state)
  })
  ipc.on(CHANNELS.available, (available: unknown, terminal: unknown) => {
    deps.setAvailable(available === true, terminal === true)
  })
  ipc.on(CHANNELS.findAvailable, (available: unknown) => {
    deps.setFindAvailable(available === true)
  })
  ipc.on(CHANNELS.saveAvailable, (available: unknown) => {
    deps.setSaveAvailable(available === true)
  })
  ipc.on(CHANNELS.dirtyTabs, (ids: unknown) => {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) return
    deps.setDirtyTabs(ids as string[])
  })

  ipc.handle(CHANNELS.readText, async (p: string): Promise<string> => {
    if (typeof p !== 'string' || !p) throw new Error('KOLOFT_READ_FAILED')
    return files(p).readText(p)
  })
  ipc.handle(CHANNELS.listDir, (p: string, opts?: ShowIgnored) => files(p).listDir(p, opts))
  ipc.handle(CHANNELS.dirExists, (p: string) =>
    typeof p === 'string' && p ? files(p).dirExistsOrThrow(p) : false
  )
  ipc.handle(CHANNELS.fileExists, (p: string) =>
    typeof p === 'string' && p ? files(p).fileExists(p) : false
  )
  ipc.handle(CHANNELS.search, (p: string, q: string, opts?: ShowIgnored) =>
    files(p).search(p, q, opts)
  )
  const untrackedArg = (u: unknown): boolean => u === true
  ipc.handle(CHANNELS.gitChanges, (root: string, base?: unknown) =>
    typeof root === 'string' && root
      ? files(root).gitChanges(root, base === 'head' ? 'head' : 'merge-base')
      : { base: null, status: {}, numstat: {}, missing: false }
  )
  ipc.handle(CHANNELS.gitHeadLog, (root: string) =>
    typeof root !== 'string' || !root ? null : deps.gitHeadLog(root)
  )
  ipc.handle(CHANNELS.gitDiff, (root: string, base?: unknown) =>
    typeof root === 'string' && root
      ? files(root).gitDiff(root, deps.base(base))
      : { text: '', truncated: false, notRepo: true, toplevel: null }
  )
  ipc.handle(CHANNELS.gitFileDiff, (p: string, base?: unknown, untracked?: unknown) =>
    typeof p === 'string' && p
      ? files(p).gitFileDiff(p, deps.base(base), untrackedArg(untracked))
      : { text: '', truncated: false }
  )
  ipc.handle(CHANNELS.gitFileDiffFull, (p: string, base?: unknown, untracked?: unknown) =>
    typeof p === 'string' && p
      ? files(p).gitFileDiffFull(p, deps.base(base), untrackedArg(untracked))
      : { text: '', truncated: false }
  )
  ipc.handle(CHANNELS.searchContent, (root: string, q: string, opts?: ShowIgnored) =>
    typeof root === 'string' && root
      ? files(root).searchContent(root, q, opts)
      : { hits: [], truncated: false }
  )
  ipc.handle(CHANNELS.watchDir, (root: string, reportsWhatChangedWhileUnwatched: unknown) =>
    typeof root === 'string' && root
      ? files(root).watchDir(
          root,
          (r, changes) => ipc.push(CHANNELS.dirChanged, r, changes),
          reportsWhatChangedWhileUnwatched === true
        )
      : false
  )
  ipc.on(CHANNELS.unwatchDir, (root: string) => {
    if (typeof root === 'string' && root) files(root).unwatchDir(root)
  })
  ipc.on(CHANNELS.watchFile, (p: string) => {
    if (typeof p === 'string' && isAbsoluteOnHost(p))
      files(p).watchFile(p, (fp, st) => ipc.push(CHANNELS.fileChanged, fp, st))
  })
  ipc.on(CHANNELS.unwatchFile, (p: string) => {
    if (typeof p === 'string' && p) files(p).unwatchFile(p)
  })
  ipc.on(CHANNELS.reveal, (p: string) => {
    if (typeof p === 'string' && p) files(p).reveal(p)
  })
  ipc.handle(CHANNELS.editOpen, (p: unknown) => files(p as string).openForEdit(p as string))
  ipc.handle(CHANNELS.editWrite, (p: unknown, text: unknown, expect: unknown, opts: unknown) =>
    files(p as string).writeText(
      p as string,
      text as string,
      expect,
      (opts ?? undefined) as { force?: unknown; eol?: unknown } | undefined
    )
  )
  ipc.handle(CHANNELS.editCreate, (dirPath: unknown, name: unknown) =>
    files(dirPath as string).createFile(dirPath as string, name as string)
  )
  ipc.handle(CHANNELS.notesPath, (ws: unknown) => {
    if (typeof ws !== 'string' || !ws) return null
    return deps.notesFile(ws) ?? null
  })
  ipc.handle(CHANNELS.openFileDialog, () => deps.pickFile())
  ipc.on(CHANNELS.osOpen, (p: string) => {
    if (typeof p === 'string' && p) files(p).osOpen(p)
  })
}

export const pushOpenFile =
  (ipc: MainIpc) =>
  (request: OpenRequest): void =>
    ipc.push(CHANNELS.openFile, request)
