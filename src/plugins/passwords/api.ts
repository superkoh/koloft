import { pluginStateOf } from '@core/switches'
import { plugin } from './plugin'

export const passwordsOn = (): boolean => pluginStateOf(plugin.id).on
