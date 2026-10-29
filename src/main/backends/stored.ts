import type { ResumePlan } from '@shared/types'
import { isRemoteKey } from '@shared/remoteKey'
import type { SessionBackend } from '../sessionBackends'
import type { CodexSessions } from '../codexSessions'
import type { MuseSessions } from '../museSessions'
import type { AgySessions } from '../agySessions'
import { planResume, ResumeRefused, type ResumeProbes } from '../resumePlan'
import { errorText } from '../agentRequests'

export function storedBackend(
  sessions: CodexSessions | MuseSessions | AgySessions,
  resumeProbes: ResumeProbes,
  own: Pick<
    SessionBackend,
    'accountUsable' | 'trustsFolder' | 'turns' | 'peerNames' | 'runningElsewhere'
  >,
  machineProbes?: (cwd: string) => ResumeProbes
): SessionBackend {
  return {
    id: sessions.id,
    recoversWorktrees: true,
    availability: () => sessions.availability(),
    forgetAvailability: () => sessions.forgetAvailability(),
    list: () => sessions.list(),
    historyRows: async (workspacePath) =>
      !(await sessions.availability()).available ? [] : sessions.historyRows(workspacePath),
    create: async (spec) => ({ ok: true, ...(await sessions.launch(spec)) }),
    resume: async (req) => {
      try {
        return { ok: true, kind: sessions.id, ...(await sessions.resume(req)) }
      } catch (error) {
        if (error instanceof ResumeRefused) return { ok: false, code: error.code }
        return { ok: false, code: 'backend', message: errorText(error) }
      }
    },
    resumePlan: async (key): Promise<ResumePlan> => {
      if (await own.runningElsewhere(key)) return { action: 'unavailable', reason: 'running' }
      const row = sessions.findRow(key)
      const onMachine = !!row && isRemoteKey(row.cwd)
      const probes = onMachine ? machineProbes?.(row.cwd) : resumeProbes
      if (!probes) return { action: 'unavailable', reason: 'not-found' }
      return planResume(row, probes, row?.worktreeState?.worktreePath)
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
