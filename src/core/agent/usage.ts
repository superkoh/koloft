import type { PriceList } from '@shared/pricing'
import type { BackendId, UsageRecord } from '@shared/types'

export interface UsageFile {
  file: string
  backend: BackendId
  workspace: string
  sessionId?: string
  db?: string
  host?: string
}

export interface PackedCalls {
  sessions: string[]
  days: string[]
  models: string[]
  calls: string
}

export interface ScannedFile {
  file: string
  records: UsageRecord[]
  // ADR-0054
  claudeCalls?: PackedCalls
  bornAt?: string
  cwd?: string
}

export interface FileStat {
  mtimeMs: number
  size: number
}

export interface CachedUsageFile extends FileStat, UsageFile, Omit<ScannedFile, 'file'> {}

export interface SessionPlace {
  workspace: string
  title: string
}

export interface UsagePlaces {
  workspaceOf(entry: CachedUsageFile): string | undefined
  titleOf(sessionId: string, host?: string): string | undefined
}

export interface AgentUsage {
  filesIn(machine?: string): Promise<UsageFile[]>
  placesNow(): UsagePlaces
  recordsOf(entries: CachedUsageFile[], generation: number): Map<string, UsageRecord[]>
}

export interface UsageWorkerScan {
  id: BackendId
  priceOf: PriceList
  scan(file: UsageFile, priceOf: PriceList): Promise<Omit<ScannedFile, 'file'>>
}
