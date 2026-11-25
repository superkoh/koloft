import type { SearchSnippet, SessionSearchHit, SessionSearchHits } from '@shared/types'
import { snippetAround } from '@core/snippetAround'
import type { AgentSearch, SearchCandidate } from '@core/agent/search'

export interface SessionSearchDeps {
  agents(): readonly { search: AgentSearch }[]
  workspaces(): string[]
  hidden(id: string): boolean
  send(found: SessionSearchHits): void
}

const HITS_BATCH_MS = 50

export class SessionSearch {
  private stopCurrent = (): void => {}

  constructor(private deps: SessionSearchDeps) {}

  start(searchId: number, term: string): void {
    this.stopCurrent()
    const wanted = term.trim()
    if (!wanted) return
    let live = true
    let queued: SessionSearchHit[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = (done: boolean): void => {
      clearTimeout(timer)
      timer = undefined
      if (!live) return
      this.deps.send({ searchId, hits: queued, done })
      queued = []
    }
    const found = (hit: SessionSearchHit): void => {
      if (!live) return
      queued.push(hit)
      timer ??= setTimeout(() => flush(false), HITS_BATCH_MS)
    }

    const unread = new Map<string, SearchCandidate>()
    const seen = new Set<string>()
    const workspaces = this.deps.workspaces()
    const agents = this.deps.agents().map(({ search }) => ({
      search,
      unread: [] as SearchCandidate[]
    }))
    for (const agent of agents) {
      for (const { row, workspacePath, file } of agent.search.rows(workspaces)) {
        if (this.deps.hidden(row.id) || seen.has(row.id)) continue
        seen.add(row.id)
        if (snippetAround(row.title, wanted)) found({ row, workspacePath })
        else {
          const candidate = { row, workspacePath, file }
          unread.set(row.id, candidate)
          agent.unread.push(candidate)
        }
      }
    }
    const foundIn = (id: string, snippet: SearchSnippet | undefined): void => {
      const c = unread.get(id)
      if (!c) return
      unread.delete(id)
      found({ row: c.row, workspacePath: c.workspacePath, snippet })
    }
    const stop = new AbortController()
    const snippets = agents.map((agent) =>
      agent.search.snippets(agent.unread, wanted, foundIn, stop.signal)
    )
    const said = Promise.all(snippets.map((s) => s.said)).then((each) => {
      for (const { id, snippet } of each.flat()) foundIn(id, snippetAround(snippet, wanted))
    })
    this.stopCurrent = () => {
      live = false
      clearTimeout(timer)
      stop.abort()
    }
    void Promise.allSettled([...snippets.map((s) => s.streamed), said]).then(() => flush(true))
  }
}
