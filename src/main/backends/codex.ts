import type { ResumePlan } from '@shared/types'
import { parseRemoteKey } from '@shared/remoteKey'
import type { SessionBackend } from '../sessionBackends'
import type { CodexSessions } from '../codexSessions'
import { dirExistsSync, planResume, type ResumeProbes } from '../resumePlan'

export function codexBackend(sessions: CodexSessions, resumeProbes: ResumeProbes): SessionBackend {
  return {
    id: 'codex',
    availability: () => sessions.availability(),
    list: () => sessions.list(),
    historyRows: async (workspacePath) =>
      parseRemoteKey(workspacePath) || !(await sessions.availability()).available
        ? []
        : sessions.historyRows(workspacePath),
    create: async (spec) => ({ ok: true, ...(await sessions.launch(spec)) }),
    resume: async (req) => {
      try {
        return { ok: true, kind: 'codex', ...(await sessions.resume(req)) }
      } catch (error) {
        return {
          ok: false,
          code: 'backend',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    },
    resumePlan: async (key): Promise<ResumePlan> => {
      const row = sessions.findRow(key)
      if (row && !row.worktreeState && !dirExistsSync(row.cwd)) {
        return { action: 'unavailable', reason: 'no-cwd' }
      }
      return planResume(row, resumeProbes, row?.worktreeState?.worktreePath)
    },
    hasTab: (tabId) => sessions.hasTab(tabId),
    aliveTabFor: (key) => sessions.aliveTabFor(key),
    stop: (tabId) => sessions.stop(tabId),
    archive: (key) => sessions.archive(key),
    transcriptExists: (key) => sessions.transcriptExists(key),
    observe: (tabId, event) => sessions.observe(tabId, event)
  }
}
