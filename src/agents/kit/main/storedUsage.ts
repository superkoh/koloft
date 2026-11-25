import { formatRemoteKey } from '@shared/remoteKey'
import type { AgentUsage, SessionPlace, UsageFile, UsagePlaces } from '@core/agent/usage'
import type { AgentSearch, SearchCandidate } from '@core/agent/search'

export function placedByOwnRowThenFolder(
  placeOf: (id: string, host?: string) => SessionPlace | undefined,
  workspaceOfFolder: (folder: string) => string
): UsagePlaces {
  return {
    workspaceOf: (e) =>
      placeOf(e.sessionId ?? e.records[0].sessionId, e.host)?.workspace ??
      (e.cwd === undefined
        ? undefined
        : workspaceOfFolder(e.host && e.cwd ? formatRemoteKey(e.host, e.cwd) : (e.cwd ?? ''))),
    titleOf: (id, host) => placeOf(id, host)?.title
  }
}

const PLACES_WITHOUT_SESSIONS = placedByOwnRowThenFolder(
  () => undefined,
  (folder) => folder
)

export function storedSessionsUsage(
  sessions: () => { usagePlaces(): UsagePlaces } | null,
  filesIn: (machine?: string) => Promise<UsageFile[]>
): AgentUsage {
  return {
    filesIn,
    placesNow: () => sessions()?.usagePlaces() ?? PLACES_WITHOUT_SESSIONS,
    recordsOf: (entries) => new Map(entries.map((e) => [e.file, e.records]))
  }
}

export function storedSessionsSearch(
  sessions: () => {
    searchable(workspaces: string[]): SearchCandidate[]
    searchSnippets(term: string, signal?: AbortSignal): Promise<{ id: string; snippet: string }[]>
  } | null
): AgentSearch {
  return {
    rows: (workspaces) => sessions()?.searchable(workspaces) ?? [],
    snippets: (_rows, term, _found, signal) => {
      const own = sessions()
      return {
        streamed: Promise.resolve(),
        said: own ? own.searchSnippets(term, signal) : Promise.resolve([])
      }
    }
  }
}
