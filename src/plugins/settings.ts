// ADR-0051
import type { SettingValues } from '@core/settings'
import { SETTINGS as butler } from './butler/shared/settings'
import { SETTINGS as discord } from './discord/shared/settings'

export const PLUGIN_SETTINGS = { butler, discord }

export type PluginSettingValues = SettingValues<typeof butler> & SettingValues<typeof discord>
