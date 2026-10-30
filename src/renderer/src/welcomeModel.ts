import type {
  AccountMeta,
  BackendAvailability,
  BackendId,
  DiscoveredFolder,
  FolderUse,
  SessionRow
} from '@shared/types'
import { BACKEND_LABEL, SESSION_BACKENDS, backendAvailable } from '@shared/sessionBackend'
import { ACCOUNT_KINDS_OF } from '@shared/accountUsage'
import { mayBeRunningElsewhere } from './resumeFlow'

export const FIRST_RUN_PINS = 3
export const FIRST_RUN_RECENT_MS = 14 * 24 * 60 * 60 * 1000
export const ADOPTED_PER_FOLDER = 4

export function foldersToPin(found: readonly DiscoveredFolder[], now: number): DiscoveredFolder[] {
  const recent = found.filter((f) => now - f.mtime <= FIRST_RUN_RECENT_MS).slice(0, FIRST_RUN_PINS)
  return recent.length > 0 ? recent : found.slice(0, 1)
}

export interface AgentTally extends FolderUse {
  folders: number
}

export function tallyAgents(found: readonly DiscoveredFolder[]): Tally {
  const tally: Tally = {}
  for (const f of found) {
    for (const [agent, use] of Object.entries(f.agents) as [BackendId, FolderUse][]) {
      const had = tally[agent]
      tally[agent] = {
        sessions: (had?.sessions ?? 0) + use.sessions,
        mtime: Math.max(had?.mtime ?? 0, use.mtime),
        folders: (had?.folders ?? 0) + 1
      }
    }
  }
  return tally
}

export type Tally = Partial<Record<BackendId, AgentTally>>

export function lastUsedAgent(
  tally: Tally,
  installed: BackendAvailability[]
): BackendId | undefined {
  return SESSION_BACKENDS.filter((b) => tally[b] && backendAvailable(installed, b)).sort(
    (a, b) => tally[b]!.mtime - tally[a]!.mtime
  )[0]
}

export function defaultAgent(tally: Tally, installed: BackendAvailability[]): BackendId {
  return (
    lastUsedAgent(tally, installed) ??
    SESSION_BACKENDS.find((b) => backendAvailable(installed, b)) ??
    SESSION_BACKENDS[0]
  )
}

export function folderUseOf(path: string, rows: readonly SessionRow[]): DiscoveredFolder {
  const agents: DiscoveredFolder['agents'] = {}
  for (const r of rows) {
    const had = agents[r.backendId]
    agents[r.backendId] = {
      sessions: (had?.sessions ?? 0) + 1,
      mtime: Math.max(had?.mtime ?? 0, r.mtime)
    }
  }
  return { path, sessions: rows.length, mtime: Math.max(0, ...rows.map((r) => r.mtime)), agents }
}

export function defaultAccountName(
  backend: BackendId,
  accounts: readonly Pick<AccountMeta, 'name' | 'kind'>[]
): string {
  const taken = new Set(
    accounts.filter((a) => ACCOUNT_KINDS_OF[backend].includes(a.kind)).map((a) => a.name)
  )
  const base = BACKEND_LABEL[backend]
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
  return name
}

export function rowsToAdopt(newestFirst: readonly SessionRow[], now: number): SessionRow[] {
  return newestFirst
    .filter((r) => !r.invalidCwd && now - r.mtime <= FIRST_RUN_RECENT_MS)
    .slice(0, ADOPTED_PER_FOLDER)
}

export function resumeTarget(rows: readonly SessionRow[], now: number): SessionRow | undefined {
  return [...rows]
    .sort((a, b) => b.mtime - a.mtime)
    .find((r) => !r.invalidCwd && !mayBeRunningElsewhere(r.mtime, now))
}
