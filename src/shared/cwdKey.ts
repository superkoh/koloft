/**
 * One folder name made from one folder path.
 *
 * Claude Code names its own storage buckets (`~/.claude/projects/<key>`) by taking the
 * session's working folder and swapping every character that is not a letter or a digit
 * for a '-'. Verified against real sessions. Koloft reads those buckets, and the
 * workspace note (`src/main/notes.ts`) files itself the same way, so the rule lives here
 * once instead of being copied into each caller.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * The edit registry's owner key for one workspace's note (D2).
 *
 * The registry keys a buffer by (owner, tab) and splits the two on a space, so an owner
 * may not hold one — `encodeCwd` guarantees that. The `notes-` head keeps this key apart
 * from every other owner: the ordinary ones are pty ids, spelt `pty-<tag>-<n>`.
 */
export function notesOwner(wsPath: string): string {
  return NOTES_OWNER_PREFIX + encodeCwd(wsPath)
}

export const NOTES_OWNER_PREFIX = 'notes-'

/** The one panel-tab id a note buffer ever uses — a workspace has exactly one note. */
export const NOTES_TAB = 'notes'
