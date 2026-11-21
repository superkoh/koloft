import path from 'path'
import type { FolderClaim } from '@shared/types'
import { plugin } from '../plugin'

// ADR-0029 CC§3 CODEX§2
export function conductorFolder(userData: string): string {
  return path.join(userData, 'conductors', 'global')
}

export const butlersFolderClaim = (userData: string): FolderClaim => ({
  path: conductorFolder(userData),
  by: plugin.id,
  shownAs: "the butler's own folder"
})
