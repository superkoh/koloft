import type { PluginStart } from '@core/pluginStart'
import { registerTodoCommand } from './todoVerb'

export const start: PluginStart<Parameters<typeof registerTodoCommand>[1]> = ({ commands }, d) =>
  registerTodoCommand(commands, d)
