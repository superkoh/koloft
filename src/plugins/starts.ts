// ADR-0051
import type { StartDeps, Started } from '@core/pluginStart'
import { start as sessions } from './sessions/main/start'
import { start as workbench } from './workbench/main/start'
import { start as browserControl } from './browser-control/main/start'
import { start as butler } from './butler/main/start'
import { start as inbox } from './inbox/main/start'
import { start as scheduledTasks } from './scheduled-tasks/main/start'
import { start as github } from './github/main/start'
import { start as discord } from './discord/main/start'
import { start as todo } from './todo/main/start'
import { start as passwords } from './passwords/main/start'

export const PLUGIN_STARTS = {
  sessions,
  workbench,
  'browser-control': browserControl,
  butler,
  inbox,
  'scheduled-tasks': scheduledTasks,
  github,
  discord,
  todo,
  passwords
}

export type PluginStartDeps = StartDeps<typeof PLUGIN_STARTS>

export type PluginsStarted = Started<typeof PLUGIN_STARTS>
