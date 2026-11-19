// ADR-0051
import type { ComponentType, ReactNode } from 'react'
import { slot } from '@core/ui'
import type { ConductorOpenResult, PaletteRequest, SessionInfo, SessionRow } from '@shared/types'
import type { PluginPaletteAction } from '@shared/paletteFeatures'
import type { PluginRouteKind } from '@shared/sessionRoute'
import type { ClaimsWorkspace, LandingAfterClose } from './store'
import type { HintWords } from './components/hintPic'
import type { LaunchSeed, WorktreeItem } from './newSession'
import type { Settings, WorkspaceRows } from '@shared/types'

export const LANDING_AFTER_CLOSE = slot<LandingAfterClose>('landing-after-close')

export const WORKSPACE_CLAIM = slot<ClaimsWorkspace>('workspace-claim')

export type UseShowsGlobalNote = (tabId: string | null, rowId: string | null) => boolean

export const GLOBAL_NOTE = slot<UseShowsGlobalNote>('global-note')

export interface RowMenuEntry {
  label: string
  run: () => void
  danger?: true
}

export interface RowExtras {
  menu: readonly RowMenuEntry[]
  where: string
}

export interface RowExtrasFill {
  row: string
  useExtras: () => RowExtras
}

export const ROW_EXTRAS = slot<RowExtrasFill>('row-extras')

export interface RowSetUpFill {
  row: string
  setUp: (settings: Settings) => boolean
}

export const ROW_SET_UP = slot<RowSetUpFill>('row-set-up')

export interface PluginSetUp {
  plugin: string
  useLabel: () => string
  run: () => Promise<string | null>
}

export const PLUGIN_SET_UP = slot<PluginSetUp>('plugin-set-up')

export type MarkOf = (
  wsPath: string,
  row: SessionRow,
  tabId: string | undefined
) => string | undefined

export interface RowMark {
  at: 'title' | 'sub'
  useMarkOf: () => MarkOf
  Mark: ComponentType<{ label: string }>
}

export const ROW_MARK = slot<RowMark>('row-mark')

export interface WorkspaceLine {
  useWatch: () => void
  Line: ComponentType<{ wsPath: string; now: Date; dismissMenu: () => void }>
}

export const WORKSPACE_LINE = slot<WorkspaceLine>('workspace-line')

export interface PartHint {
  id: string
  part: string
  selector: string
  words: HintWords
}

export const PART_HINT = slot<PartHint>('part-hint')

export interface WorkspaceGitPart {
  shows: (ws: WorkspaceRows['workspace']) => boolean
  Mark: ComponentType<{ path: string; reachable: boolean; closeCards: () => void }>
  fit: (heads: Iterable<HTMLElement>) => void
  Section: ComponentType<{
    ws: WorkspaceRows['workspace']
    offline: boolean
    account: string | undefined
    onClose: () => void
  }>
}

export const WORKSPACE_GIT_PART = slot<WorkspaceGitPart>('workspace-git-part')

export interface WorkbenchPartContext {
  visible: boolean
  treeRoot: string | null
  session: SessionInfo | null
  onReturnFocus: () => void
  reread: () => void
  openWeb: (url: string) => void
  closeNewTabMenu: () => void
  closeDownloads: () => void
}

export interface WorkbenchPartView {
  button: ReactNode
  layer: ReactNode
  menuOpen: boolean
  closeMenu: () => void
}

export type UseWorkbenchPart = (ctx: WorkbenchPartContext) => WorkbenchPartView

export interface WorktreeItemsView {
  items: readonly WorktreeItem[]
  pickWhat: string
  box: (draw: { loaded: boolean; row: (item: WorktreeItem) => ReactNode }) => ReactNode
}

export type UseWorktreeItems = (wsPath: string, isGit: boolean) => WorktreeItemsView

export const WORKTREE_ITEMS = slot<UseWorktreeItems>('worktree-items')

export type IssueLaunch = (wsPath: string, issue: number) => Promise<LaunchSeed | null>

export const ISSUE_LAUNCH = slot<IssueLaunch>('issue-launch')

export const WORKBENCH_PART = slot<UseWorkbenchPart>('workbench-part')

export interface WorkspaceMenuEntry {
  label: string
  run: (wsPath: string) => void
}

export const WORKSPACE_MENU = slot<WorkspaceMenuEntry>('workspace-menu')

export interface PaletteRun {
  key: PluginPaletteAction
  run: (currentWs: string | null) => void
  disabled: (currentWs: string | null) => boolean
}

export const PALETTE_RUN = slot<PaletteRun>('palette-run')

export interface PaletteRoute {
  kind: PluginRouteKind
  run: (prompt: string) => Promise<string | null>
}

export const PALETTE_ROUTE = slot<PaletteRoute>('palette-route')

export type PaletteHandOff = (request: PaletteRequest) => Promise<ConductorOpenResult>

export const PALETTE_HAND_OFF = slot<PaletteHandOff>('palette-hand-off')

export type WindowFeed = (adopted: Promise<void>) => () => void

export const WINDOW_FEED = slot<WindowFeed>('window-feed')

export interface WorkspaceRemovalLoss {
  countIn: (wsPath: string) => number
  willGo: (count: number) => string
  goneForGood: string
}

export const WORKSPACE_REMOVAL_LOSS = slot<WorkspaceRemovalLoss>('workspace-removal-loss')
