import type { WorkspaceRows } from '@shared/types'
import { plugin } from '../plugin'

export const COUNTS_KEY = plugin.id

export interface WorkspaceGithub {
  repo: string
  issues: number
  prs: number
}

export const githubCountsOfRow = (ws: WorkspaceRows['workspace']): WorkspaceGithub | undefined =>
  ws.plugins?.[COUNTS_KEY] as WorkspaceGithub | undefined
