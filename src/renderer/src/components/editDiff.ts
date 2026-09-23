import type { DiffRow, ParsedDiff } from '../inlineDiff'

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// ADR-0019
export function diffLines(oldText: string, newText: string): ParsedDiff {
  const a = splitLines(oldText)
  const b = splitLines(newText)

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const rows: DiffRow[] = []
  for (let i = 0; i < head; i++) rows.push({ kind: 'ctx', oldNo: i + 1, newNo: i + 1, text: a[i] })
  for (let i = head; i < a.length - tail; i++)
    rows.push({ kind: 'del', oldNo: i + 1, newNo: null, text: a[i] })
  for (let i = head; i < b.length - tail; i++)
    rows.push({ kind: 'add', oldNo: null, newNo: i + 1, text: b[i] })
  for (let k = 0; k < tail; k++) {
    const oi = a.length - tail + k
    const ni = b.length - tail + k
    rows.push({ kind: 'ctx', oldNo: oi + 1, newNo: ni + 1, text: a[oi] })
  }

  return {
    rows,
    oldText: rows
      .filter((r) => r.kind !== 'add')
      .map((r) => r.text)
      .join('\n'),
    newText: rows
      .filter((r) => r.kind !== 'del')
      .map((r) => r.text)
      .join('\n'),
    hasChange: rows.some((r) => r.kind !== 'ctx')
  }
}
