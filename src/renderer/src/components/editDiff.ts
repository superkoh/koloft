import type { DiffRow, ParsedDiff } from '../inlineDiff'

/**
 * B-21 — the difference between what is on disk and what the editor holds, in the shape
 * `InlineDiff` already renders. The conflict view is the one place in Koloft that needs a
 * diff git cannot supply: neither side is a commit, and one of them exists only in memory.
 *
 * Common head and tail, then everything between them as "theirs out, mine in". That is not
 * a shortest-edit-script, and the difference only shows on a file rewritten all over — the
 * case this view exists for is a handful of lines apart, where the two agree. It is also
 * the only shape that stays linear: the buffer can be half a megabyte, and the quadratic
 * table a real line-level diff builds would freeze the panel at the moment the user most
 * needs to read it.
 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  // a file that ends in a newline does not have an extra empty last line — rendering one
  // would put a phantom row at the bottom of every diff
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

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
