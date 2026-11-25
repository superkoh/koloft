import path from 'path'
import type { SearchSnippet, UsageRecord } from '@shared/types'
import { mapAtMost } from '@core/mapAtMost'
import { resolvePricing } from '@core/agent/prices'
import type { AgentUsage, CachedUsageFile, SessionPlace } from '@core/agent/usage'
import type { AgentSearch, SearchCandidate } from '@core/agent/search'
import { jsonlUnder } from '@agents/kit/main/usageFiles'
import { claudeCallKeys, recordsOfClaudeCalls, type ClaudeCalls } from './usageWorkerScan'
import type { TranscriptFile } from './transcriptSearch'

const FILES_AT_ONCE = 16

export interface ClaudeUsageStore {
  transcriptFiles(): { file: string; workspace: string }[]
  sessionPlaces(): Map<string, SessionPlace>
}

class CallsCountedOnce {
  private claudeOnce?: { unchangedSince: object; recordsByFile: Map<string, UsageRecord[]> }
  private readonly unpackedClaude = new WeakMap<
    ClaudeCalls,
    { keys: string[]; records: UsageRecord[] }
  >()

  private unpacked(calls: ClaudeCalls): { keys: string[]; records: UsageRecord[] } {
    let found = this.unpackedClaude.get(calls)
    if (!found) {
      found = {
        keys: claudeCallKeys(calls).filter(Boolean),
        records: recordsOfClaudeCalls(calls, resolvePricing)
      }
      this.unpackedClaude.set(calls, found)
    }
    return found
  }

  // CC§5
  recordsOf(files: CachedUsageFile[], unchangedSince: object): Map<string, UsageRecord[]> {
    if (this.claudeOnce?.unchangedSince === unchangedSince) return this.claudeOnce.recordsByFile
    const startOf = (e: CachedUsageFile): number => Date.parse(e.bornAt ?? '') || Infinity
    const oldestFirst = files
      .filter((e) => e.claudeCalls)
      .sort((a, b) => startOf(a) - startOf(b) || (a.file < b.file ? -1 : 1))
    const counted = new Set<string>()
    const recordsByFile = new Map<string, UsageRecord[]>()
    for (const e of oldestFirst) {
      const { keys, records } = this.unpacked(e.claudeCalls!)
      const copies = new Set(keys.filter((k) => counted.has(k)))
      for (const k of keys) counted.add(k)
      recordsByFile.set(
        e.file,
        copies.size ? recordsOfClaudeCalls(e.claudeCalls!, resolvePricing, copies) : records
      )
    }
    this.claudeOnce = { unchangedSince, recordsByFile }
    return recordsByFile
  }
}

// CC§2
export function claudeUsage(store: () => ClaudeUsageStore | null): AgentUsage {
  const once = new CallsCountedOnce()
  return {
    filesIn: async (machine) => {
      if (machine) return []
      const transcripts = store()?.transcriptFiles() ?? []
      const claude = await mapAtMost(transcripts, FILES_AT_ONCE, async ({ file, workspace }) => {
        const subagents = path.join(file.slice(0, -'.jsonl'.length), 'subagents')
        return [file, ...(await jsonlUnder(subagents, ''))].map((f) => ({
          file: f,
          backend: 'claude' as const,
          workspace
        }))
      })
      return claude.flat()
    },
    placesNow: () => {
      const places = store()?.sessionPlaces()
      return { workspaceOf: (e) => e.workspace, titleOf: (id) => places?.get(id)?.title }
    },
    recordsOf: (entries, unchangedSince) => once.recordsOf(entries, unchangedSince)
  }
}

export interface TranscriptScan {
  done: Promise<void>
  stop(): void
}

export function claudeSearch(
  store: () => { searchableRows(): SearchCandidate[] } | null,
  startSearch: (
    files: TranscriptFile[],
    term: string,
    found: (id: string, snippet: SearchSnippet) => void
  ) => TranscriptScan
): AgentSearch {
  return {
    rows: () => store()?.searchableRows() ?? [],
    snippets: (rows, term, found, signal) => {
      const files = rows
        .flatMap(({ row, file }) => (file ? [{ id: row.id, file, mtime: row.mtime }] : []))
        .sort((a, b) => b.mtime - a.mtime)
      const scan = startSearch(files, term, found)
      signal.addEventListener('abort', () => scan.stop())
      return { streamed: scan.done, said: Promise.resolve([]) }
    }
  }
}
