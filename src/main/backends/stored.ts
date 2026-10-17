import type { ResumePlan } from '@shared/types'
import { parseRemoteKey } from '@shared/remoteKey'
import type { SessionBackend } from '../sessionBackends'
import type { CodexSessions } from '../codexSessions'
import type { MuseSessions } from '../museSessions'
import { dirExistsSync, planResume, type ResumeProbes } from '../resumePlan'

export function storedBackend(
  sessions: CodexSessions | MuseSessions,
  resumeProbes: ResumeProbes,
  own: Pick<SessionBackend, 'accountUsable' | 'trustsFolder' | 'turns'>
): SessionBackend {
  return {
    id: sessions.id,
    recoversWorktrees: true,
    availability: () => sessions.availability(),
    forgetAvailability: () => sessions.forgetAvailability(),
    list: () => sessions.list(),
    historyRows: async (workspacePath) =>
      parseRemoteKey(workspacePath) || !(await sessions.availability()).available
        ? []
        : sessions.historyRows(workspacePath),
    create: async (spec) => ({ ok: true, ...(await sessions.launch(spec)) }),
    resume: async (req) => {
      try {
        return { ok: true, kind: sessions.id, ...(await sessions.resume(req)) }
      } catch (error) {
        return {
          ok: false,
          code: 'backend',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    },
    resumePlan: async (key): Promise<ResumePlan> => {
      if ('runningElsewhere' in sessions && sessions.runningElsewhere(key))
        return { action: 'unavailable', reason: 'running' }
      const row = sessions.findRow(key)
      if (row && !row.worktreeState && !dirExistsSync(row.cwd)) {
        return { action: 'unavailable', reason: 'no-cwd' }
      }
      return planResume(row, resumeProbes, row?.worktreeState?.worktreePath)
    },
    hasTab: (tabId) => sessions.hasTab(tabId),
    workspaceOfTab: (tabId) => sessions.workspaceOfTab(tabId),
    aliveTabFor: (key) => sessions.aliveTabFor(key),
    stop: (tabId, restarting) => sessions.stop(tabId, undefined, restarting),
    archive: (key) => sessions.archive(key),
    transcriptExists: (key) => sessions.transcriptExists(key),
    observe: (tabId, event) => sessions.observe(tabId, event),
    occupantOf: (dir) => sessions.occupantOf(dir),
    // ADR-0028
    permissionClass: (tabId) => (sessions.launchedBypassingChecks(tabId) ? 'bypass' : 'prompting'),
    ...own
  }
}
