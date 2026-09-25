export interface FileStamp {
  mtimeMs: number
  size: number
}

export function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

export function isDirty(original: string, current: string): boolean {
  if (original.length !== current.length) return true
  return original !== current
}

export function buildLineIndex(text: string): Uint32Array {
  const starts: number[] = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return Uint32Array.from(starts)
}

export function positionAt(
  index: Uint32Array,
  offset: number,
  text: string
): { line: number; col: number } {
  const at = Math.max(0, Math.min(text.length, offset))
  let lo = 0
  let hi = index.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (index[mid] <= at) lo = mid
    else hi = mid - 1
  }
  const bom = lo === 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0
  return { line: lo + 1, col: Math.max(1, at - index[lo] - bom + 1) }
}

const encoder = new TextEncoder()

export function exceedsBytes(text: string, maxBytes: number): boolean {
  return encoder.encode(text).length > maxBytes
}

export const TAB_TEXT = '  '

export function insertTab(value: string, start: number, end: number): { caret: number } {
  const lo = Math.max(0, Math.min(value.length, Math.min(start, end)))
  return { caret: lo + TAB_TEXT.length }
}

export const AUTOSAVE_DELAY_MS = 600

export function autosaveAllowed(e: {
  dirty: boolean
  conflict: unknown
  readOnly: unknown
}): boolean {
  return e.dirty && !e.conflict && !e.readOnly
}
