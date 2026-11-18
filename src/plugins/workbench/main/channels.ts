import path from 'path'
import type { MainIpc } from '@core/ipc'
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
import { barePath, isAbsoluteOnHost } from '@shared/remoteKey'
import { CHANNELS } from '../shared/channels'

interface ShowIgnored {
  showIgnored?: boolean
}

interface Diff {
  text: string
  truncated: boolean
}

export interface Files {
  listDir(dir: string, opts?: ShowIgnored): Promise<DirEntry[]>
  dirExistsOrThrow(dir: string): Promise<boolean>
  fileExists(file: string): Promise<boolean>
  search(
    root: string,
    q: string,
    opts?: ShowIgnored
  ): Promise<{ hits: SearchHit[]; truncated: boolean }>
  searchContent(
    root: string,
    q: string,
    opts?: ShowIgnored
  ): Promise<{ hits: ContentHit[]; truncated: boolean }>
  gitChanges(root: string, base: BaseChoice): Promise<GitChanges>
  gitDiff(
    root: string,
    base?: string
  ): Promise<Diff & { notRepo: boolean; toplevel: string | null }>
  gitFileDiff(file: string, base?: string, untracked?: boolean): Promise<Diff>
  gitFileDiffFull(file: string, base?: string, untracked?: boolean): Promise<Diff>
  gitOut(dir: string, args: string[]): Promise<string | null>
  keyed(p: string): string
  readText(file: string): Promise<string>
  openForEdit(file: string): Promise<EditOpenResult>
  writeText(
    file: string,
    text: string,
    expect: unknown,
    opts?: { force?: unknown; eol?: unknown }
  ): Promise<EditWriteResult>
  createFile(dir: string, name: string): Promise<EditCreateResult>
  watchDir(
    root: string,
    onChange: DirChangeListener,
    reportsWhatChangedWhileUnwatched?: boolean
  ): Promise<boolean>
  unwatchDir(root: string): void
  watchFile(file: string, onChange: (file: string, fp: EditFingerprint) => void): void
  unwatchFile(file: string): void
}

export interface ChannelDeps {
  files(p: string): Files
  base(b: unknown): string | undefined
  notesFile(scope: string): string | undefined
  pickFile(): Promise<string | null>
  state(sessionId: string): SessionWorkbenchState | undefined
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
  // PLATFORM§30
  ipc.handle(CHANNELS.gitHeadLog, async (root: string) => {
    if (typeof root !== 'string' || !root) return null
    const host = files(root)
    const gitDir = (await host.gitOut(root, ['rev-parse', '--git-dir']))?.trim()
    return gitDir ? host.keyed(path.posix.resolve(barePath(root), gitDir, 'logs', 'HEAD')) : null
  })
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
}

export const pushOpenFile =
  (ipc: MainIpc) =>
  (request: OpenRequest): void =>
    ipc.push(CHANNELS.openFile, request)
