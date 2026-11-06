import { hasUsableAccount } from '@shared/accountUsage'
import { listAccounts } from '../accounts'
import type { SessionBackend } from '../sessionBackends'
import type { AgySessions } from '../agySessions'
import type { ResumeProbes } from '../resumePlan'
import { storedBackend } from './stored'

export function agyBackend(
  sessions: AgySessions,
  resumeProbes: ResumeProbes,
  machineProbes: (cwd: string) => ResumeProbes
): SessionBackend {
  return storedBackend(
    sessions,
    resumeProbes,
    {
      accountUsable: () => hasUsableAccount(listAccounts(), 'agy'),
      trustsFolder: (dir) => sessions.trustsFolder(dir),
      turns: (key, n) => sessions.readTurns(key, n),
      peerNames: () => async () => null,
      runningElsewhere: () => false
    },
    machineProbes
  )
}
