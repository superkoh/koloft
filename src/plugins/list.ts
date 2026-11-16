// ADR-0051
import type { PluginManifest } from '@core/plugin'
import { plugin as sessions } from './sessions/plugin'
import { plugin as workbench } from './workbench/plugin'
import { plugin as browserControl } from './browser-control/plugin'
import { plugin as butler } from './butler/plugin'
import { plugin as inbox } from './inbox/plugin'
import { plugin as scheduledTasks } from './scheduled-tasks/plugin'
import { plugin as discord } from './discord/plugin'
import { plugin as github } from './github/plugin'
import { plugin as todo } from './todo/plugin'
import { plugin as passwords } from './passwords/plugin'
import { plugin as docsWriting } from './docs-writing/plugin'

export const PLUGINS: readonly PluginManifest[] = [
  sessions,
  workbench,
  browserControl,
  butler,
  inbox,
  scheduledTasks,
  github,
  discord,
  todo,
  passwords,
  docsWriting
]
