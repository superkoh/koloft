import type { DiscoveredFolder, FolderUse, SessionRow } from './types'

const FIRST_RUN_PINS = 3
export const FIRST_RUN_RECENT_MS = 14 * 24 * 60 * 60 * 1000
export const ADOPTED_PER_FOLDER = 4

export function foldersToPin(found: readonly DiscoveredFolder[], now: number): DiscoveredFolder[] {
  const recent = found.filter((f) => now - f.mtime <= FIRST_RUN_RECENT_MS).slice(0, FIRST_RUN_PINS)
  return recent.length > 0 ? recent : found.slice(0, 1)
}

export function rowsToAdopt(newestFirst: readonly SessionRow[], now: number): SessionRow[] {
  return newestFirst
    .filter((r) => !r.invalidCwd && now - r.mtime <= FIRST_RUN_RECENT_MS)
    .slice(0, ADOPTED_PER_FOLDER)
}

export function mergeUse(had: FolderUse | undefined, use: FolderUse): FolderUse {
  return {
    sessions: (had?.sessions ?? 0) + use.sessions,
    mtime: Math.max(had?.mtime ?? 0, use.mtime)
  }
}
