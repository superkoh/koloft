import { hasUsableAccount } from '@shared/accountUsage'
import { listAccounts } from '../../../main/accounts'
import type { SessionBackend } from '@core/agent/sessionBackends'
import type { CodexSessions } from './codexSessions'
import type { ResumeProbes } from '../../../main/resumePlan'
import { storedBackend } from '@agents/kit/main/stored'

export function codexBackend(
  sessions: CodexSessions,
  resumeProbes: ResumeProbes,
  machineProbes: (cwd: string) => ResumeProbes
): SessionBackend {
  return storedBackend(
    sessions,
    resumeProbes,
    {
      accountUsable: () => hasUsableAccount(listAccounts(), 'codex'),
      trustsFolder: (dir) => sessions.trustsFolder(dir),
      turns: async (key, n) => sessions.turnsOf(key, n) ?? sessions.readTurns(key, n),
      peerNames: () => async () => null,
      runningElsewhere: () => false,
      // CODEX§6
      worktreeExitWatch: () => undefined
    },
    machineProbes
  )
}
