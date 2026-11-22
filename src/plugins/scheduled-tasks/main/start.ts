import fs from 'fs'
import type { BuildLater, PluginStart, StopOnQuit } from '@core/pluginStart'
import { pushRunStarted, pushState, registerChannels } from './channels'
import { CronRunner, type RunnerDeps } from './cronRunner'
import { cronFilePath, loadCron, saveCron } from './cronStore'
import { registerCronCommand } from './cronVerb'
import { followEachRun } from './sessionHooks'

export type CronRunnerDeps = Omit<RunnerDeps, 'store' | 'push'> & {
  userData: string
  pinnedPaths(): string[]
}

export interface ScheduledTasksStartDeps {
  command: Omit<Parameters<typeof registerCronCommand>[1], 'runner'>
  channels: Omit<Parameters<typeof registerChannels>[1], 'runner'>
}

export const start: PluginStart<
  ScheduledTasksStartDeps,
  { buildRunner: BuildLater<CronRunnerDeps, CronRunner>; stop: StopOnQuit }
> = ({ commands, moments, ipc }, d) => {
  let runner: CronRunner | null = null
  const built = (): CronRunner | null => runner
  registerCronCommand(commands, { ...d.command, runner: built })
  followEachRun(moments, built, pushRunStarted(ipc))
  registerChannels(ipc, { ...d.channels, runner: built })
  return {
    buildRunner: ({ userData, pinnedPaths, ...deps }) => {
      const cronFile = cronFilePath(userData)
      const cronFs = {
        readFile: (p: string) => fs.readFileSync(p, 'utf8'),
        writeFile: (p: string, s: string) => fs.writeFileSync(p, s),
        rename: (a: string, b: string) => fs.renameSync(a, b)
      }
      runner = new CronRunner({
        ...deps,
        store: {
          load: () => loadCron(cronFs, cronFile, pinnedPaths()),
          save: (jobs) => saveCron(cronFs, cronFile, jobs)
        },
        push: pushState(ipc)
      })
      runner.start()
      return runner
    },
    stop: () => {
      runner?.quitSweep()
      runner?.stop()
    }
  }
}
