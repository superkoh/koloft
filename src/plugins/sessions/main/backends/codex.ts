import { hasUsableAccount } from '@shared/accountUsage'
import { listAccounts } from '../../../../main/accounts'
import type { SessionBackend } from '@core/agent/sessionBackends'
import type { CodexSessions } from '../codexSessions'
import { acceptCodexTrust, codexConfigFile } from '../../../../main/codexTrust'
import type { ResumeProbes } from '../../../../main/resumePlan'
import { storedBackend } from '@agents/kit/main/stored'

export function trustCodexFolder(root: string, env: NodeJS.ProcessEnv | undefined): void {
  try {
    acceptCodexTrust(codexConfigFile(env), root)
  } catch (err) {
    console.error('[koloft] could not record Codex trust for', root, err)
  }
}

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
      runningElsewhere: () => false
    },
    machineProbes
  )
}
