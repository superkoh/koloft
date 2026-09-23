import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { ensureNotesFile, notesFileFor } from '../../src/main/notes'
import { encodeCwd } from '@shared/cwdKey'

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-notes-'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('notesFileFor', () => {
  it('files the note under the workspace key, always as notes.md', () => {
    const ws = '/Users/someone/Projects/my app'
    expect(notesFileFor(base, ws)).toBe(path.join(base, encodeCwd(ws), 'notes.md'))
  })

  it('gives two workspaces two folders', () => {
    const a = notesFileFor(base, '/Users/someone/one')
    const b = notesFileFor(base, '/Users/someone/two')
    expect(a).not.toBe(b)
    expect(path.dirname(a)).not.toBe(path.dirname(b))
  })
})

describe('ensureNotesFile', () => {
  it('makes the folder and an empty file when there is no note yet', () => {
    const file = ensureNotesFile(base, '/Users/someone/one')
    expect(file).toBe(notesFileFor(base, '/Users/someone/one'))
    expect(fs.readFileSync(file, 'utf8')).toBe('')
  })

  it('leaves an existing note exactly as it was', () => {
    const ws = '/Users/someone/one'
    const file = ensureNotesFile(base, ws)
    fs.writeFileSync(file, 'buy milk\n')
    expect(ensureNotesFile(base, ws)).toBe(file)
    expect(fs.readFileSync(file, 'utf8')).toBe('buy milk\n')
  })
})
