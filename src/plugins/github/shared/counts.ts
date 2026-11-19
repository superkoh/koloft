import type { WorkspaceRows } from '@shared/types'

export const COUNTS_KEY = 'github'

export interface WorkspaceGithub {
  repo: string
  issues: number
  prs: number
}

export const countsOf = (ws: WorkspaceRows['workspace']): WorkspaceGithub | undefined =>
  ws.plugins?.[COUNTS_KEY] as WorkspaceGithub | undefined
