// ADR-0051
import type { PluginUi } from '@core/ui'
import { ui as butler } from './butler/renderer/ui'
import { ui as inbox } from './inbox/renderer/ui'
import { ui as scheduledTasks } from './scheduled-tasks/renderer/ui'
import { ui as discord } from './discord/renderer/ui'
import { ui as browserControl } from './browser-control/renderer/ui'
import { ui as github } from './github/renderer/ui'
import { ui as passwords } from './passwords/renderer/ui'

export const PLUGIN_UIS: Readonly<Record<string, PluginUi>> = {
  'browser-control': browserControl,
  butler,
  inbox,
  'scheduled-tasks': scheduledTasks,
  discord,
  github,
  passwords
}
