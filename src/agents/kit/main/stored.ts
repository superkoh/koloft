import type { ResumePlan } from '@shared/types'
import { isRemoteKey } from '@shared/remoteKey'
import type { SessionBackend } from '@core/agent/sessionBackends'
import type { HistoryEntry, StoredRun, StoredSessions } from './storedSessions'
import { planResume, ResumeRefused, type ResumeProbes } from '../../../main/resumePlan'
import { errorText } from '@core/errorText'
import { rowsKeptInMemory } from './rowsKeptInMemory'

export function storedBackend<R extends StoredRun, H extends HistoryEntry, P>(
  sessions: StoredSessions<R, H, P>,
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
    adopt: (keys) => sessions.adopt(keys),
    worktreeRecords: sessions.worktrees.records,
    transcriptExists: (key) => sessions.transcriptExists(key),
    transcriptPlaces: (key) => sessions.transcriptPlaces(key),
    observe: (tabId, event) => sessions.observe(tabId, event),
    occupantOf: (dir) => sessions.occupantOf(dir),
    workStillRunning: async () => false,
    tabExited: ({ tabId, exitCode, signal }) => sessions.stop(tabId, signal ? -1 : exitCode),
    quitWaitsForIt: () => sessions.hasProcesses(),
    endBeforeQuit: () => sessions.stopAll(),
    flushSync: () => sessions.store.flushSync(),
    beforeWorkspaceRemoved: async (workspace) => {
      const tabs = new Set(
        sessions
          .rows(workspace)
          .filter((r) => r.running || r.pending)
          .map((r) => (r.pending ? r.id : sessions.aliveTabFor(r.id)))
          .filter((id): id is string => !!id)
      )
      await Promise.all([...tabs].map((id) => sessions.stop(id)))
    },
    showsPromptBeforeBind: (tabId) => sessions.showsPromptBeforeBind(tabId),
    sessionGone: (key) => sessions.threadGone(key),
    noticeRemoteExits: (host, sessionIds) => sessions.noticeRemoteExits(host, sessionIds),
    mirrorPulled: (host) => sessions.mirrorPulled(host),
    foldersToMirrorFrom: (host, landing) => sessions.foldersToMirrorFrom(host, landing),
    tmuxOfTab: (tabId) => sessions.tmuxOfTab(tabId),
    ...rowsKeptInMemory(sessions),
    // ADR-0028
    permissionClass: (tabId) => (sessions.launchedBypassingChecks(tabId) ? 'bypass' : 'prompting'),
    ...own
  }
}
