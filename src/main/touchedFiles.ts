import type { FileAccess, PreviewItem } from '@shared/types'
import { basename } from '@shared/preview'

export interface FileAcc {
  access: FileAccess
  added: number
  removed: number
  wroteAt: number
}

const MAX_FILES = 300

export function noteWrite(
  files: Map<string, FileAcc>,
  abs: string,
  added: number,
  removed: number,
  at: number
): void {
  const cur = files.get(abs)
  if (cur && cur.access === 'wrote') {
    cur.added += added
    cur.removed += removed
    cur.wroteAt = Math.max(cur.wroteAt, at)
  } else {
    files.set(abs, { access: 'wrote', added, removed, wroteAt: at })
  }
}

export function noteRead(files: Map<string, FileAcc>, abs: string): void {
  if (!files.has(abs)) files.set(abs, { access: 'read', added: 0, removed: 0, wroteAt: 0 })
}

export function touchedItem(src: string, acc: FileAcc): PreviewItem {
  const item: PreviewItem = { src, label: basename(src), access: acc.access }
  if (acc.added) item.added = acc.added
  if (acc.removed) item.removed = acc.removed
  if (acc.access === 'wrote') item.wroteAt = acc.wroteAt
  return item
}

export function capTouched(all: PreviewItem[]): PreviewItem[] {
  return all.length <= MAX_FILES
    ? all
    : [
        ...all.filter((f) => f.access === 'wrote'),
        ...all.filter((f) => f.access !== 'wrote')
      ].slice(0, MAX_FILES)
}
