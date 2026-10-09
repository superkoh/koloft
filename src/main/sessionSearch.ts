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
  claudeRows(): SearchCandidate[]
  codexHits(term: string): Promise<SessionSearchHit[]>
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
    this.stopCurrent = () => {}
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
    const found = (hits: SessionSearchHit[]): void => {
      if (!live) return
      queued.push(...hits.filter((h) => !this.deps.hidden(h.row.id)))
      if (queued.length) timer ??= setTimeout(() => flush(false), HITS_BATCH_MS)
    }

    const unread = new Map<string, SearchCandidate>()
    const titled: SessionSearchHit[] = []
    for (const { row, workspacePath, file } of this.deps.claudeRows()) {
      if (snippetAround(row.title, wanted)) titled.push({ row, workspacePath })
      else if (file) unread.set(row.id, { row, workspacePath, file })
    }
    found(titled)
    const files = [...unread.values()]
      .sort((a, b) => b.row.mtime - a.row.mtime)
      .map((c) => ({ id: c.row.id, file: c.file! }))
    const scan = this.deps.scan(files, wanted, (id, snippet) => {
      const c = unread.get(id)
      if (c) found([{ row: c.row, workspacePath: c.workspacePath, snippet }])
    })
    const codex = this.deps.codexHits(wanted).then(found)
    this.stopCurrent = () => {
      live = false
      clearTimeout(timer)
      scan.stop()
    }
    void Promise.allSettled([scan.done, codex]).then(() => flush(true))
  }
}
