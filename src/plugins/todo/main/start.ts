import type { PluginStart } from '@core/pluginStart'
import { TODO_NEWS } from '../api'
import { listTodoPulls } from './pulls'
import { registerTodoCommand } from './todoVerb'

type PullsOf = Parameters<typeof listTodoPulls>

export type TodoStartDeps = Omit<Parameters<typeof registerTodoCommand>[1], 'pulls'> & {
  ghOfRepo(workspace: string): Promise<{ gh: PullsOf[0]; repo: PullsOf[1] } | null>
}

export const start: PluginStart<TodoStartDeps, { TODO_NEWS: typeof TODO_NEWS }> = (
  { commands },
  { ghOfRepo, ...d }
) => {
  registerTodoCommand(commands, {
    ...d,
    pulls: async (wsPath) => {
      const at = await ghOfRepo(wsPath)
      return at && listTodoPulls(at.gh, at.repo)
    }
  })
  return { TODO_NEWS }
}
