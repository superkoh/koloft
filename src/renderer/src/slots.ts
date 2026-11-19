// ADR-0051
import type { ComponentType } from 'react'
import { slot } from '@core/ui'
import type { ConductorOpenResult, PaletteRequest, SessionRow } from '@shared/types'
import type { PluginPaletteAction } from '@shared/paletteFeatures'
import type { PluginRouteKind } from '@shared/sessionRoute'
import type { ClaimsWorkspace, LandingAfterClose } from './store'
import type { Settings } from '@shared/types'

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
  label: (butlerName: string) => string
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
