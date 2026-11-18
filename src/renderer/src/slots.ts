// ADR-0051
import { slot } from '@core/ui'
import type { LandingAfterClose } from './store'
import type { Icon } from './icons'
import type { Settings } from '@shared/types'

export const LANDING_AFTER_CLOSE = slot<LandingAfterClose>('landing-after-close')

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

export interface SettingsPageIcon {
  page: string
  Icon: Icon
}

export const SETTINGS_PAGE_ICON = slot<SettingsPageIcon>('settings-page-icon')
