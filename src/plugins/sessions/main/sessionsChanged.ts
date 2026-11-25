import type { MadeLater } from '@core/moment'
import type { SessionInfo } from '@shared/types'
import type { WorkspaceManager } from './workspaces'

export interface SessionsChangedSteps {
  noteSessions(): SessionInfo[]
  sendSessions(all: SessionInfo[]): void
  workspaces: MadeLater<Pick<WorkspaceManager, 'sessionsChanged'>>
  syncAnswerable(): void
}

export function sessionsChangedIn(steps: SessionsChangedSteps): () => void {
  return () => {
    steps.sendSessions(steps.noteSessions())
    steps.workspaces()?.sessionsChanged()
    steps.syncAnswerable()
  }
}
