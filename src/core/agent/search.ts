import type { SearchSnippet, SessionRow } from '@shared/types'

export interface SearchCandidate {
  row: SessionRow
  workspacePath: string
  file?: string
}

export interface AgentSnippets {
  streamed: Promise<void>
  said: Promise<{ id: string; snippet: string }[]>
}

export interface AgentSearch {
  rows(workspaces: string[]): SearchCandidate[]
  snippets(
    rows: SearchCandidate[],
    term: string,
    found: (id: string, snippet: SearchSnippet) => void,
    signal: AbortSignal
  ): AgentSnippets
}
