import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { encodeCwd } from '@shared/cwdKey'

/**
 * one plain-text note per workspace.
 *
 * The note lives in Koloft's own user-data folder, NOT inside the workspace, because:
 *  - a file in the repo would show up in `git status` and in every diff the user reads;
 *  - a worktree can be thrown away, and the note has to outlive it;
 *  - the e2e fake claude already drops a NOTES.md into the fixture workspace, so a
 *    workspace-side note would collide with it.
 *
 * Each workspace gets its OWN folder, named by `encodeCwd` — the same spelling Claude
 * Code uses for its buckets — and the file inside is always called `notes.md`. One name
 * everywhere means nothing has to guess a file name, and two workspaces can never land
 * on the same file.
 */

/** Where the note for this workspace goes. Pure path math — no disk touched. */
export function notesFileFor(baseDir: string, wsPath: string): string {
  return path.join(baseDir, encodeCwd(wsPath), 'notes.md')
}

/**
 * Make sure the note file is really there, and hand back its path.
 *
 * The file has to EXIST even when it is empty: the Workbench edit pane refuses a missing
 * file with KOLOFT_GONE, so "no note yet" has to look like an empty note. An existing
 * file is never touched.
 */
export function ensureNotesFile(baseDir: string, wsPath: string): string {
  const file = notesFileFor(baseDir, wsPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 'a' opens for append and creates when missing — it adds nothing to a file that is
  // already there, so an existing note keeps every byte.
  fs.closeSync(fs.openSync(file, 'a'))
  return file
}

/** The one line that needs Electron, kept apart so the rest unit-tests in plain Node. */
export function notesBaseDir(): string {
  return path.join(app.getPath('userData'), 'notes')
}
