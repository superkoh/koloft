import type { BackendSessionRow, DiscoveredFolder } from '@shared/types'
import { keptOrRunning, type SessionRowsSource } from '@core/agent/sessionRows'

export interface SessionsKeptInMemory {
  rows(workspace: string): BackendSessionRow[]
  members(): Set<string>
  localHistoryFolders(): Promise<DiscoveredFolder[]>
}

export function rowsKeptInMemory(sessions: SessionsKeptInMemory): SessionRowsSource {
  return {
    rowsReady: async () => {},
    rowsPass: () => {
      const members = sessions.members()
      return {
        in: async (place, now) => keptOrRunning(sessions.rows(place.path), members, now()),
        done: async () => {},
        shown: () => {}
      }
    },
    members: () => sessions.members(),
    usedFolders: () => sessions.localHistoryFolders().catch(() => []),
    whereNow: () => (row) => ({ dir: row.cwd }),
    liveKey: () => ''
  }
}
