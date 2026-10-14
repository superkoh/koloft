import type { SessionBackend } from '../sessionBackends'
import type { MuseSessions } from '../museSessions'
import type { ResumeProbes } from '../resumePlan'
import { storedBackend } from './stored'

export function museBackend(sessions: MuseSessions, resumeProbes: ResumeProbes): SessionBackend {
  return storedBackend(sessions, resumeProbes, {
    accountUsable: () => true,
    trustsFolder: (dir) => sessions.trustsFolder(dir),
    turns: (key, n) => sessions.readTurns(key, n)
  })
}
