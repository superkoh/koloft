// ADR-0051
import type { PluginUi } from '@core/ui'
import { ui as butler } from './butler/renderer/ui'
import { ui as inbox } from './inbox/renderer/ui'
import { ui as discord } from './discord/renderer/ui'

export const PLUGIN_UIS: Readonly<Record<string, PluginUi>> = { butler, inbox, discord }
