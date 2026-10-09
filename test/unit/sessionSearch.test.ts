import { describe, expect, it, vi } from 'vitest'
import {
  SessionSearch,
  type SearchCandidate,
  type SessionSearchDeps
} from '../../src/main/sessionSearch'
import type { SearchSnippet, SessionRow, SessionSearchHits } from '@shared/types'

const row = (id: string, title: string, mtime: number): SessionRow => ({
  id,
  title,
  cwd: '/repo',
  worktree: 'main',
  running: false,
  invalidCwd: false,
  mtime,
  backendId: 'claude',
  host: 'local'
})

const snippet = (match: string): SearchSnippet => ({ before: '', match, after: '' })

function harness(candidates: SearchCandidate[], overrides: Partial<SessionSearchDeps> = {}) {
  const sent: SessionSearchHits[] = []
  const scans: {
    files: { id: string; file: string }[]
    found: (id: string, s: SearchSnippet) => void
    finish: () => void
    stop: ReturnType<typeof vi.fn>
  }[] = []
  const deps: SessionSearchDeps = {
    claudeRows: () => candidates,
    codexHits: async () => [],
    hidden: () => false,
    scan: (files, _term, found) => {
      let finish!: () => void
      const done = new Promise<void>((resolve) => (finish = resolve))
      const stop = vi.fn()
      scans.push({ files, found, finish, stop })
      return { done, stop }
    },
    send: (found) => sent.push(found),
    ...overrides
  }
  return { search: new SessionSearch(deps), sent, scans }
}

const ids = (sent: SessionSearchHits[]) => sent.flatMap((s) => s.hits.map((h) => h.row.id))

describe('SessionSearch', () => {
  it('lists a title match at once without reading its transcript, and reads the rest newest first', async () => {
    const { search, sent, scans } = harness([
      { row: row('old', 'Old work', 1), workspacePath: '/repo', file: '/t/old.jsonl' },
      { row: row('named', 'The parser plan', 2), workspacePath: '/repo', file: '/t/named.jsonl' },
      { row: row('new', 'New work', 3), workspacePath: '/repo', file: '/t/new.jsonl' }
    ])
    search.start(1, ' parser ')
    expect(scans[0].files.map((f) => f.id)).toEqual(['new', 'old'])
    await vi.waitFor(() => expect(ids(sent)).toEqual(['named']))
    scans[0].found('old', snippet('parser'))
    scans[0].finish()
    await vi.waitFor(() => expect(sent.at(-1)?.done).toBe(true))
    expect(ids(sent)).toEqual(['named', 'old'])
    expect(sent.every((s) => s.searchId === 1)).toBe(true)
  })

  it('a new search stops the one still running, and nothing more of the old one is sent', async () => {
    const { search, sent, scans } = harness([
      { row: row('a', 'A', 1), workspacePath: '/repo', file: '/t/a.jsonl' }
    ])
    search.start(1, 'needle')
    search.start(2, 'other')
    expect(scans[0].stop).toHaveBeenCalled()
    scans[0].found('a', snippet('needle'))
    scans[0].finish()
    scans[1].finish()
    await vi.waitFor(() => expect(sent.at(-1)?.done).toBe(true))
    expect(sent.map((s) => s.searchId)).toEqual([2])
  })

  it('an empty search only stops the running one', () => {
    const { search, sent, scans } = harness([
      { row: row('a', 'A', 1), workspacePath: '/repo', file: '/t/a.jsonl' }
    ])
    search.start(1, 'needle')
    search.start(2, '  ')
    expect(scans).toHaveLength(1)
    expect(scans[0].stop).toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('leaves out the sessions the sidebar hides, from both backends', async () => {
    const { search, sent, scans } = harness(
      [{ row: row('conductor', 'needle', 1), workspacePath: '/repo', file: '/t/c.jsonl' }],
      {
        hidden: (id) => id === 'conductor' || id === 'codex:hidden',
        codexHits: async () => [
          { row: { ...row('codex:hidden', 'needle', 1), backendId: 'codex' }, workspacePath: '/r' },
          { row: { ...row('codex:shown', 'x', 2), backendId: 'codex' }, workspacePath: '/r' }
        ]
      }
    )
    search.start(1, 'needle')
    scans[0].finish()
    await vi.waitFor(() => expect(sent.at(-1)?.done).toBe(true))
    expect(ids(sent)).toEqual(['codex:shown'])
  })

  it('a Codex search that fails still ends the search with the Claude hits', async () => {
    const { search, sent, scans } = harness(
      [{ row: row('a', 'A', 1), workspacePath: '/repo', file: '/t/a.jsonl' }],
      { codexHits: async () => Promise.reject(new Error('app-server gone')) }
    )
    search.start(1, 'needle')
    scans[0].found('a', snippet('needle'))
    scans[0].finish()
    await vi.waitFor(() => expect(sent.at(-1)?.done).toBe(true))
    expect(ids(sent)).toEqual(['a'])
  })
})
