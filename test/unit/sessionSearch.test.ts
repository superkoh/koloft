import { describe, expect, it, vi } from 'vitest'
import { SessionSearch } from '../../src/main/sessionSearch'
import type { SearchCandidate } from '../../src/core/agent/search'
import { claudeSearch } from '../../src/agents/claude/main/claudeUsage'
import { storedSessionsSearch } from '../../src/agents/kit/main/storedUsage'
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

type Said = () => Promise<{ id: string; snippet: string }[]>

const LONGER_THAN_ONE_BATCH_OF_HITS_MS = 120

function harness(
  candidates: SearchCandidate[],
  overrides: { hidden?: (id: string) => boolean; said?: { codex?: Said; agy?: Said } } = {}
) {
  const sent: SessionSearchHits[] = []
  const scans: {
    files: { id: string; file: string }[]
    found: (id: string, s: SearchSnippet) => void
    finish: () => void
    stop: ReturnType<typeof vi.fn>
  }[] = []
  const rowsOf = (backendId: string) => candidates.filter((c) => c.row.backendId === backendId)
  const stored = (backendId: 'codex' | 'agy') =>
    storedSessionsSearch(() => ({
      searchable: () => rowsOf(backendId),
      searchSnippets: overrides.said?.[backendId] ?? (async () => [])
    }))
  const agents = [
    {
      search: claudeSearch(
        () => ({ searchableRows: () => rowsOf('claude') }),
        (files, _term, found) => {
          let finish!: () => void
          const done = new Promise<void>((resolve) => (finish = resolve))
          const stop = vi.fn()
          scans.push({ files, found, finish, stop })
          return { done, stop }
        }
      )
    },
    { search: stored('codex') },
    { search: stored('agy') }
  ]
  const search = new SessionSearch({
    agents: () => agents,
    workspaces: () => ['/repo'],
    hidden: overrides.hidden ?? (() => false),
    send: (found) => sent.push(found)
  })
  return { search, sent, scans }
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

  it('joins what Codex found to the Codex rows offered, once each, and drops threads that are not offered or that the sidebar hides', async () => {
    const codexRow = (id: string, title: string): SearchCandidate => ({
      row: { ...row(id, title, 1), backendId: 'codex' },
      workspacePath: '/repo'
    })
    const { search, sent, scans } = harness(
      [
        { row: row('conductor', 'needle', 1), workspacePath: '/repo', file: '/t/c.jsonl' },
        codexRow('codex:titled', 'A needle in the title'),
        codexRow('codex:said', 'Quiet'),
        codexRow('codex:hidden', 'Quiet')
      ],
      {
        hidden: (id) => id === 'conductor' || id === 'codex:hidden',
        said: {
          codex: async () => [
            { id: 'codex:said', snippet: '... the NEEDLE moved' },
            { id: 'codex:said', snippet: 'needle again from another home' },
            { id: 'codex:hidden', snippet: 'needle' },
            { id: 'codex:elsewhere', snippet: 'needle' }
          ]
        }
      }
    )
    search.start(1, 'needle')
    expect(scans[0].files).toEqual([])
    scans[0].finish()
    await vi.waitFor(() => expect(sent.at(-1)?.done).toBe(true))
    const hits = sent.flatMap((s) => s.hits)
    expect(hits.map((h) => [h.row.id, h.snippet?.match])).toEqual([
      ['codex:titled', undefined],
      ['codex:said', 'NEEDLE']
    ])
  })

  it('sends a transcript hit at once, while what the other agents found waits for all of their answers and goes out together', async () => {
    const otherRow = (id: string, backendId: 'codex' | 'agy'): SearchCandidate => ({
      row: { ...row(id, 'Quiet', 1), backendId },
      workspacePath: '/repo'
    })
    let codexAnswers!: (said: { id: string; snippet: string }[]) => void
    let agyAnswers!: (said: { id: string; snippet: string }[]) => void
    const { search, sent, scans } = harness(
      [
        { row: row('a', 'A', 1), workspacePath: '/repo', file: '/t/a.jsonl' },
        otherRow('codex:x', 'codex'),
        otherRow('agy:y', 'agy')
      ],
      {
        said: {
          codex: () => new Promise((resolve) => (codexAnswers = resolve)),
          agy: () => new Promise((resolve) => (agyAnswers = resolve))
        }
      }
    )
    search.start(1, 'needle')
    scans[0].found('a', snippet('needle'))
    await vi.waitFor(() => expect(ids(sent)).toEqual(['a']))
    expect(sent.at(-1)?.done).toBe(false)
    codexAnswers([{ id: 'codex:x', snippet: 'a needle' }])
    await new Promise((resolve) => setTimeout(resolve, LONGER_THAN_ONE_BATCH_OF_HITS_MS))
    expect(ids(sent)).toEqual(['a'])
    agyAnswers([{ id: 'agy:y', snippet: 'needle too' }])
    scans[0].finish()
    await vi.waitFor(() => expect(sent.at(-1)?.done).toBe(true))
    const batchOf = (id: string) => sent.findIndex((s) => s.hits.some((h) => h.row.id === id))
    expect(ids(sent)).toEqual(['a', 'codex:x', 'agy:y'])
    expect(batchOf('codex:x')).toBe(batchOf('agy:y'))
  })

  it('a Codex search that fails still ends the search with the Claude hits', async () => {
    const { search, sent, scans } = harness(
      [{ row: row('a', 'A', 1), workspacePath: '/repo', file: '/t/a.jsonl' }],
      { said: { codex: async () => Promise.reject(new Error('app-server gone')) } }
    )
    search.start(1, 'needle')
    scans[0].found('a', snippet('needle'))
    scans[0].finish()
    await vi.waitFor(() => expect(sent.at(-1)?.done).toBe(true))
    expect(ids(sent)).toEqual(['a'])
  })
})
