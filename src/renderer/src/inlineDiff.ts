export interface DiffRow {
  kind: 'ctx' | 'add' | 'del'
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface ParsedDiff {
  rows: DiffRow[]
  oldText: string
  newText: string
  hasChange: boolean
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export const MAX_ROW_CHARS = 5000
export const CUT_MARK = ' … [line cut]'

function rowText(line: string): string {
  return line.length - 1 > MAX_ROW_CHARS
    ? line.slice(1, MAX_ROW_CHARS + 1) + CUT_MARK
    : line.slice(1)
}

export function parseUnifiedDiff(diff: string): ParsedDiff {
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    const m = HUNK.exec(line)
    if (m) {
      oldNo = parseInt(m[1], 10)
      newNo = parseInt(m[2], 10)
      inHunk = true
      continue
    }
    if (!inHunk) continue
    const c = line[0]
    if (c === ' ') {
      rows.push({ kind: 'ctx', oldNo, newNo, text: rowText(line) })
      oldNo++
      newNo++
    } else if (c === '+') {
      rows.push({ kind: 'add', oldNo: null, newNo, text: rowText(line) })
      newNo++
    } else if (c === '-') {
      rows.push({ kind: 'del', oldNo, newNo: null, text: rowText(line) })
      oldNo++
    } else if (c === '\\') {
      continue
    } else if (line.startsWith('diff --git')) {
      inHunk = false
    }
  }
  const oldText = rows
    .filter((r) => r.kind !== 'add')
    .map((r) => r.text)
    .join('\n')
  const newText = rows
    .filter((r) => r.kind !== 'del')
    .map((r) => r.text)
    .join('\n')
  return { rows, oldText, newText, hasChange: rows.some((r) => r.kind !== 'ctx') }
}
