// ADR-0051
import type { AllSettingValues } from '@core/settings'
import { SETTINGS as browserControl } from './browser-control/shared/settings'
import { SETTINGS as butler } from './butler/shared/settings'
import { SETTINGS as discord } from './discord/shared/settings'
import { SETTINGS as sessions } from './sessions/shared/settings'
import { SETTINGS as todo } from './todo/shared/settings'

export const PLUGIN_SETTINGS = {
  'browser-control': browserControl,
  butler,
  discord,
  sessions,
  todo
}

export type PluginSettingValues = AllSettingValues<typeof PLUGIN_SETTINGS>
