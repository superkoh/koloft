// CC§2
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function notesOwner(wsPath: string): string {
  return NOTES_OWNER_PREFIX + encodeCwd(wsPath)
}

export const NOTES_OWNER_PREFIX = 'notes-'

export const NOTES_TAB = 'notes'
