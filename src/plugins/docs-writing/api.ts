import { pluginStateOf } from '@core/switches'
import { plugin } from './plugin'

export const docsWritingOn = (): boolean => pluginStateOf(plugin.id).on
