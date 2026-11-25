import { hasUsableAccount } from '@shared/accountUsage'
import { listAccounts } from '../../../main/accounts'
import type { SessionBackend } from '@core/agent/sessionBackends'
import type { AgySessions } from './agySessions'
import type { ResumeProbes } from '../../../main/resumePlan'
import { storedBackend } from '@agents/kit/main/stored'
import { agyMessages } from './agyMessages'
import { withHandover } from '@core/handOver'

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
      runningElsewhere: () => false,
      handOverLaunch: (handOver, task) => ({ firstPrompt: withHandover(handOver, task) }),
      ...agyMessages((tabId, text) => sessions.deliver(tabId, text))
    },
    machineProbes
  )
}
