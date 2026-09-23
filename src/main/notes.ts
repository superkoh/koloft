import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { encodeCwd } from '@shared/cwdKey'

export function notesFileFor(baseDir: string, wsPath: string): string {
  return path.join(baseDir, encodeCwd(wsPath), 'notes.md')
}

export function ensureNotesFile(baseDir: string, wsPath: string): string {
  const file = notesFileFor(baseDir, wsPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.closeSync(fs.openSync(file, 'a'))
  return file
}

export function notesBaseDir(): string {
  return path.join(app.getPath('userData'), 'notes')
}
