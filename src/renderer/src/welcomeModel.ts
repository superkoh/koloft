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
import { mergeUse } from '@shared/firstRun'
import { mayBeRunningElsewhere } from './resumeFlow'

interface AgentTally extends FolderUse {
  folders: number
}

export function tallyAgents(found: readonly DiscoveredFolder[]): Tally {
  const tally: Tally = {}
  for (const f of found) {
    for (const [agent, use] of Object.entries(f.agents) as [BackendId, FolderUse][]) {
      const had = tally[agent]
      tally[agent] = { ...mergeUse(had, use), folders: (had?.folders ?? 0) + 1 }
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
  for (const r of rows)
    agents[r.backendId] = mergeUse(agents[r.backendId], { sessions: 1, mtime: r.mtime })
  return { path, sessions: rows.length, mtime: Math.max(0, ...rows.map((r) => r.mtime)), agents }
}

export function defaultAccountName(
  backend: BackendId,
  accounts: readonly Pick<AccountMeta, 'name' | 'kind'>[]
): string {
  const taken = new Set(
    accounts
      .filter((a) => ACCOUNT_KINDS_OF[backend].includes(a.kind))
      .map((a) => a.name.toLowerCase())
  )
  const base = BACKEND_LABEL[backend]
  let name = base
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}-${i}`
  return name
}

export function resumeTarget(rows: readonly SessionRow[], now: number): SessionRow | undefined {
  return [...rows]
    .sort((a, b) => b.mtime - a.mtime)
    .find((r) => !r.invalidCwd && !mayBeRunningElsewhere(r.mtime, now))
}
