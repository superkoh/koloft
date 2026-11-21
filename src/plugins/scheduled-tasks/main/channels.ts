import type { MainIpc } from '@core/ipc'
import type {
  BackendId,
  CronRunNowResult,
  CronSaveInput,
  CronSaveResult,
  CronState,
  SkillSuggestion
} from '@shared/types'
import { CRON_SAVE_MESSAGES } from '@shared/cronMessages'
import { CHANNELS, type RunStartedNews } from '../shared/ipc'

export interface Runner {
  state(): CronState
  save(input: CronSaveInput): CronSaveResult
  delete(jobId: string): void
  setEnabled(jobId: string, on: boolean): void
  runNow(jobId: string): Promise<CronRunNowResult>
}

export interface ChannelDeps {
  runner(): Runner | null
  skills(workspacePath: string, backend: BackendId): Promise<SkillSuggestion[]>
  trusted(workspacePath: string, backend: BackendId): boolean | Promise<boolean>
}

export function registerChannels(ipc: MainIpc, deps: ChannelDeps): void {
  ipc.handle(
    CHANNELS.list,
    () => deps.runner()?.state() ?? { jobs: [], live: [], folders: {}, notes: {} }
  )
  ipc.handle(
    CHANNELS.save,
    (input: CronSaveInput) =>
      deps.runner()?.save(input) ?? { ok: false, errors: [CRON_SAVE_MESSAGES.workspace] }
  )
  ipc.handle(CHANNELS.delete, (jobId: string) => deps.runner()?.delete(jobId))
  ipc.handle(CHANNELS.setEnabled, (arg: { jobId: string; on: boolean }) =>
    deps.runner()?.setEnabled(arg.jobId, arg.on)
  )
  ipc.handle(
    CHANNELS.runNow,
    (jobId: string) => deps.runner()?.runNow(jobId) ?? { ok: false, reason: 'not-ready' }
  )
  ipc.handle(CHANNELS.skills, (workspacePath: string, backend: BackendId) =>
    deps.skills(workspacePath, backend)
  )
  ipc.handle(CHANNELS.trusted, (workspacePath: string, backend: BackendId) =>
    deps.trusted(workspacePath, backend)
  )
}

export const pushState =
  (ipc: MainIpc) =>
  (state: CronState): boolean =>
    ipc.push(CHANNELS.state, state)

export const pushRunStarted =
  (ipc: MainIpc) =>
  (news: RunStartedNews): boolean =>
    ipc.push(CHANNELS.runStarted, news)
