import { noteRead, noteWrite, type FileAcc } from './touchedFiles'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export function toolFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  const p = i.file_path ?? i.notebook_path ?? i.path
  return typeof p === 'string' && p.length ? p : null
}

function countLines(s: unknown): number {
  if (typeof s !== 'string' || s.length === 0) return 0
  let n = 1
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
  if (s.charCodeAt(s.length - 1) === 10) n--
  return n
}

function editDelta(tool: string, input: unknown): { added: number; removed: number } {
  if (!input || typeof input !== 'object') return { added: 0, removed: 0 }
  const i = input as Record<string, unknown>
  if (tool === 'Edit') return { added: countLines(i.new_string), removed: countLines(i.old_string) }
  if (tool === 'MultiEdit') {
    let added = 0
    let removed = 0
    if (Array.isArray(i.edits)) {
      for (const e of i.edits as Array<Record<string, unknown>>) {
        added += countLines(e?.new_string)
        removed += countLines(e?.old_string)
      }
    }
    return { added, removed }
  }
  if (tool === 'Write') return { added: countLines(i.content), removed: 0 }
  return { added: 0, removed: 0 }
}

export class ClaudeTouchedFiles {
  readonly files = new Map<string, FileAcc>()
  lastTouched: string | null = null
  lastWritten: string | null = null

  noteToolCall(tool: string, input: unknown, abs: string, at: number): boolean {
    if (WRITE_TOOLS.has(tool)) {
      const { added, removed } = editDelta(tool, input)
      noteWrite(this.files, abs, added, removed, at)
      this.lastTouched = abs
      this.lastWritten = abs
      return true
    }
    if (tool === 'Read') {
      noteRead(this.files, abs)
      this.lastTouched = abs
    }
    return false
  }
}
