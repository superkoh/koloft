import { hasUsableAccount } from '@shared/accountUsage'
import { listAccounts } from '../accounts'
import type { SessionBackend } from '../sessionBackends'
import type { CodexSessions } from '../codexSessions'
import { acceptCodexTrust, codexConfigFile, codexTrustsFolder } from '../codexTrust'
import type { ResumeProbes } from '../resumePlan'
import { storedBackend } from './stored'

export function trustCodexFolder(root: string, env: NodeJS.ProcessEnv | undefined): void {
  try {
    acceptCodexTrust(codexConfigFile(env), root)
  } catch (err) {
    console.error('[koloft] could not record Codex trust for', root, err)
  }
}

export function codexBackend(sessions: CodexSessions, resumeProbes: ResumeProbes): SessionBackend {
  return storedBackend(sessions, resumeProbes, {
    accountUsable: () => hasUsableAccount(listAccounts(), 'codex'),
    trustsFolder: (dir) => codexTrustsFolder(codexConfigFile(sessions.defaultEnv), dir),
    turns: async (key, n) => sessions.turnsOf(key, n) ?? sessions.readTurns(key, n)
  })
}
