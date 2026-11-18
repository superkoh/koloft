// ADR-0051
import type { SettingValuesOf } from '@core/settings'
import { SETTINGS as butler } from './butler/shared/settings'
import { SETTINGS as discord } from './discord/shared/settings'

export const PLUGIN_SETTINGS = { butler, discord }

export type PluginSettingValues = SettingValuesOf<typeof PLUGIN_SETTINGS>
