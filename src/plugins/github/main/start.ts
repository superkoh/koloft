import type { PluginStart } from '@core/pluginStart'
import { registerChannels } from './channels'
import { startGithubMain, type GithubMain, type GithubMainDeps } from './githubMain'

export interface GithubStartDeps {
  main: Omit<GithubMainDeps, 'commands'>
  prWorktree: Parameters<typeof registerChannels>[1]['prWorktree']
}

export const start: PluginStart<GithubStartDeps, GithubMain> = ({ commands, ipc }, d) => {
  const github = startGithubMain({ ...d.main, commands })
  registerChannels(ipc, { lookup: github.lookup, prWorktree: d.prWorktree })
  return github
}
