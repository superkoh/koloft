import { hasUsableAccount } from '@shared/accountUsage'
import { listAccounts } from '../accounts'
import type { SessionBackend } from '../sessionBackends'
import type { MuseSessions } from '../museSessions'
import type { ResumeProbes } from '../resumePlan'
import { storedBackend } from './stored'

export function museBackend(
  sessions: MuseSessions,
  resumeProbes: ResumeProbes,
  machineProbes: (cwd: string) => ResumeProbes
): SessionBackend {
  return storedBackend(
    sessions,
    resumeProbes,
    {
      accountUsable: () => hasUsableAccount(listAccounts(), 'muse'),
      trustsFolder: (dir) => sessions.trustsFolder(dir),
      turns: (key, n) => sessions.readTurns(key, n),
      peerNames: () => async (key) => sessions.peerName(key),
      runningElsewhere: (key) => sessions.runningElsewhere(key)
    },
    machineProbes
  )
}
