import type { SearchSnippet, SessionRow, SessionSearchHit, SessionSearchHits } from '@shared/types'
import { snippetAround, type TranscriptFile } from './transcriptSearch'

export interface SearchCandidate {
  row: SessionRow
  workspacePath: string
  file?: string
}

export interface TranscriptScan {
  done: Promise<void>
  stop(): void
}

export interface SessionSearchDeps {
  candidates(): SearchCandidate[]
  codexSnippets(term: string): Promise<{ id: string; snippet: string }[]>
  hidden(id: string): boolean
  scan(
    files: TranscriptFile[],
    term: string,
    found: (id: string, snippet: SearchSnippet) => void
  ): TranscriptScan
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
    for (const { row, workspacePath, file } of this.deps.candidates()) {
      if (this.deps.hidden(row.id) || seen.has(row.id)) continue
      seen.add(row.id)
      if (snippetAround(row.title, wanted)) found({ row, workspacePath })
      else unread.set(row.id, { row, workspacePath, file })
    }
    const foundIn = (id: string, snippet: SearchSnippet | undefined): void => {
      const c = unread.get(id)
      if (!c) return
      unread.delete(id)
      found({ row: c.row, workspacePath: c.workspacePath, snippet })
    }
    const files = [...unread.values()]
      .flatMap(({ row, file }) => (file ? [{ id: row.id, file, mtime: row.mtime }] : []))
      .sort((a, b) => b.mtime - a.mtime)
    const scan = this.deps.scan(files, wanted, foundIn)
    const codex = this.deps.codexSnippets(wanted).then((said) => {
      for (const { id, snippet } of said) foundIn(id, snippetAround(snippet, wanted))
    })
    this.stopCurrent = () => {
      live = false
      clearTimeout(timer)
      scan.stop()
    }
    void Promise.allSettled([scan.done, codex]).then(() => flush(true))
  }
}
