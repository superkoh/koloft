import type {
  ContentHit,
  CronEffort,
  DirEntry,
  EditCreateResult,
  EditOpenResult,
  EditWriteResult,
  GitNumstatMap,
  GitStatusMap,
  LaunchPermission,
  SearchHit
} from '@shared/types'
import type { DiffResult, GitDiffResult } from '../gitStatus'
import type { GithubLookup } from '../github'
import type { RemoteTab } from '../sessionTracker'

export interface ShowIgnored {
  showIgnored?: boolean
}

export interface ShellLaunch {
  spawnCwd: string
  cwd: string
  shell?: string
  launchCommand?: (tabId: string) => string
}

export interface ClaudeLaunch {
  root: string
  cwd?: string
  fallbackCwd?: string
  resumeSessionId?: string
  worktree?: string
  model?: string
  effort?: CronEffort
  permission?: LaunchPermission
  firstPrompt?: string
  name?: string
}

export interface MachineTab {
  tracking: RemoteTab
  cwd: string
  root: string
  hookMirror: string
  attachTo?: string
  picked?: string
}

export type ClaudeLaunchPlan =
  | { ok: false; code: 'invalid-args' }
  | {
      ok: true
      spawnCwd: string
      cwd: string
      shell?: string
      launchCommand: (tabId: string) => string
      extraEnv?: { KOLOFT_FIRST_PROMPT?: string; KOLOFT_SESSION_NAME?: string }
      machine?: MachineTab
    }

export interface Host {
  listDir(dir: string, opts?: ShowIgnored): Promise<DirEntry[]>
  dirExists(dir: string): Promise<boolean>
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
  diffBase(root: string): Promise<string | null>
  gitStatus(root: string, base?: string): Promise<GitStatusMap>
  gitNumstat(root: string, base?: string): Promise<GitNumstatMap>
  gitDiff(root: string, base?: string): Promise<GitDiffResult>
  gitFileDiff(file: string, base?: string, untracked?: boolean): Promise<DiffResult>
  gitFileDiffFull(file: string, base?: string, untracked?: boolean): Promise<DiffResult>
  readText(file: string): Promise<string>
  openForEdit(file: string): Promise<EditOpenResult>
  writeText(
    file: string,
    text: string,
    expect: unknown,
    opts?: { force?: unknown; eol?: unknown }
  ): Promise<EditWriteResult>
  createFile(dir: string, name: string): Promise<EditCreateResult>
  watchDir(root: string, onChange: (root: string) => void): boolean
  unwatchDir(root: string): void
  watchFile(
    file: string,
    onChange: (file: string, fp: { mtimeMs: number; size: number }) => void
  ): void
  unwatchFile(file: string): void
  shell(cwd: string): ShellLaunch
  launch(spec: ClaudeLaunch): Promise<ClaudeLaunchPlan>
  trustFolder(dir: string): Promise<void>
  trustsFolder(dir: string): Promise<boolean>
  keyed(p: string): string
  gitOut(root: string, args: string[]): Promise<string | null>
  reveal(p: string): void
  osOpen(p: string): void
  github: GithubLookup
}
