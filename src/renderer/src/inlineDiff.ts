/** One rendered line of an inline full-file diff. `ctx` lines exist in both versions;
 *  `add` only in the new file (green), `del` only in the old (red). `oldNo`/`newNo` are the
 *  1-based line numbers shown in the gutter (null on the side where the line doesn't exist). */
export interface DiffRow {
  kind: 'ctx' | 'add' | 'del'
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface ParsedDiff {
  rows: DiffRow[]
  /** old file reconstructed from ctx+del rows (in order), for per-line syntax highlighting */
  oldText: string
  /** new file reconstructed from ctx+add rows (in order), for per-line syntax highlighting */
  newText: string
  /** any add/del row — false means the file is unchanged / the diff wasn't a real text diff
   *  (empty, or "Binary files … differ"), so the caller should show the plain file instead */
  hasChange: boolean
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Longest row text kept. Measured on a 2.8 MB single line (base64 fonts in a
 *  self-contained html): tokenizing and wrap-laying-out that one row froze the renderer
 *  for ~20 s. Cut here, not in highlight.ts, because layout is half the cost; the source
 *  views rely on the 2 MB read cap instead. */
export const MAX_ROW_CHARS = 5000
export const CUT_MARK = ' … [line cut]'

function rowText(line: string): string {
  return line.length - 1 > MAX_ROW_CHARS
    ? line.slice(1, MAX_ROW_CHARS + 1) + CUT_MARK
    : line.slice(1)
}

/**
 * Parse a unified diff into ordered rows plus the reconstructed old/new file text. Built for
 * the **full-context** per-file diff (`gitFileDiffFull` → a single whole-file hunk), but tolerant
 * of any unified diff: file headers (`diff --git`, `index`, `---`, `+++`, `new file …`) and the
 * `\ No newline at end of file` marker are skipped, and multiple hunks accumulate in order.
 *
 * old/new text are joined only from the rows that exist on that side, so a caller can highlight
 * each whole reconstructed file once and index the rows back by a running per-side counter —
 * keeping syntax highlighting correct without re-tokenizing each line in isolation.
 */
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
    if (!inHunk) continue // pre-hunk headers
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
      // "\ No newline at end of file" — annotation, not a line; ignore.
      continue
    } else if (line.startsWith('diff --git')) {
      inHunk = false // next file section begins; wait for its @@
    }
    // else: '' trailer from the trailing newline, or a stray header line — skip.
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
