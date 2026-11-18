import type { PreloadIpc } from '@core/ipc'
import type {
  BackendId,
  CronRunNowResult,
  CronSaveInput,
  CronSaveResult,
  CronState,
  SkillSuggestion
} from '@shared/types'
import { CHANNELS } from '../shared/channels'

export interface CronBridge {
  cron: {
    list(): Promise<CronState>
    save(input: CronSaveInput): Promise<CronSaveResult>
    delete(jobId: string): Promise<void>
    setEnabled(jobId: string, on: boolean): Promise<void>
    runNow(jobId: string): Promise<CronRunNowResult>
    skills(workspacePath: string, backend: BackendId): Promise<SkillSuggestion[]>
    // CC§9
    trusted(workspacePath: string, backend: BackendId): Promise<boolean>
    onState(cb: (s: CronState) => void): () => void
  }
}

export const bridge = (ipc: PreloadIpc): CronBridge => ({
  cron: {
    list: () => ipc.invoke(CHANNELS.list),
    save: (input) => ipc.invoke(CHANNELS.save, input),
    delete: (jobId) => ipc.invoke(CHANNELS.delete, jobId),
    setEnabled: (jobId, on) => ipc.invoke(CHANNELS.setEnabled, { jobId, on }),
    runNow: (jobId) => ipc.invoke(CHANNELS.runNow, jobId),
    skills: (workspacePath, backend) => ipc.invoke(CHANNELS.skills, workspacePath, backend),
    trusted: (workspacePath, backend) => ipc.invoke(CHANNELS.trusted, workspacePath, backend),
    onState: (cb) => ipc.listen(CHANNELS.state, cb)
  }
})
