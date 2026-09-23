import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ParsedDiff } from '../inlineDiff'
import { highlightLines, langForPath } from '../highlight'

// Cap rendered rows so a huge whole-file diff can't build a runaway DOM. Past the cap
// we render plain rows (no double-tokenization) + a hint.
const MAX_INLINE_ROWS = 5000

interface Hl {
  newHtml: string[]
  oldHtml: string[]
}

/**
 * The default code view: the whole file shown WITH its diff inline. Renders a full-context
 * unified diff (`gitFileDiffFull`) as syntax-highlighted rows — context lines plain, removed
 * lines red, added lines green — with an old/new line-number gutter.
 *
 * Highlighting: the old and new files are each reconstructed from the diff and highlighted once
 * (Shiki `highlightLines`), then rows index back into those per-line arrays by a running per-side
 * counter — so tokens stay correct without re-tokenizing each line alone. `key={src}` (set by the
 * caller) remounts on file switch so a stale file's rows can't flash under the next title.
 *
 * Takes the already-parsed diff (FilePane parses once to decide inline-vs-plain) rather than the
 * raw string, so the whole-file diff isn't parsed twice per open.
 */
export function InlineDiff({
  src,
  parsed,
  line
}: {
  src: string
  parsed: ParsedDiff
  line?: number
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const { rows, oldText, newText } = parsed
  const truncated = rows.length > MAX_INLINE_ROWS
  const shown = truncated ? rows.slice(0, MAX_INLINE_ROWS) : rows
  const hasDel = useMemo(() => rows.some((r) => r.kind === 'del'), [rows])
  const [hl, setHl] = useState<Hl | null>(null)

  const lang = langForPath(src)
  useEffect(() => {
    setHl(null)
    if (truncated) return // don't tokenize an enormous file we won't fully render
    let cancelled = false
    Promise.all([
      highlightLines(newText, lang),
      // the old side only feeds deleted rows — skip the pass entirely when there are none
      hasDel ? highlightLines(oldText, lang) : Promise.resolve<string[]>([])
    ])
      .then(([newHtml, oldHtml]) => {
        if (!cancelled) setHl({ newHtml, oldHtml })
      })
      .catch(() => {
        /* highlight failed — rows fall back to plain escaped text */
      })
    return () => {
      cancelled = true
    }
  }, [newText, oldText, lang, truncated, hasDel])

  // per-row highlighted HTML, aligned to `shown` by walking a running new-/old-side counter
  // (matches how newText/oldText were reconstructed). null → not highlighted yet, render plain.
  const rowsHtml = useMemo<(string | null)[]>(() => {
    if (!hl) return shown.map(() => null)
    let ni = 0
    let oi = 0
    return shown.map((r) => {
      if (r.kind === 'del') return hl.oldHtml[oi++] ?? ''
      if (r.kind === 'add') return hl.newHtml[ni++] ?? ''
      oi++ // ctx exists on both sides
      return hl.newHtml[ni++] ?? ''
    })
  }, [shown, hl])

  // stable {__html} identities — React 19 re-sets innerHTML on a fresh wrapper object
  // (see PreviewViewer); with thousands of rows that's a full DOM rebuild per re-render.
  const rowHtmlObjs = useMemo<({ __html: string } | null)[]>(
    () => rowsHtml.map((h) => (h != null ? { __html: h || '&nbsp;' } : null)),
    [rowsHtml]
  )

  // scroll a requested new-file line into view once rows are in the DOM (content-search
  // hit). Guarded per line value: an auto-refresh replaces `parsed`/`hl` with the same
  // `line`, and re-jumping then would yank away the scroll position the user moved to.
  const jumpedLine = useRef<number | null>(null)
  useEffect(() => {
    if (!line || jumpedLine.current === line) return
    const el = bodyRef.current?.querySelector<HTMLElement>(`.idiff-row[data-newno="${line}"]`)
    if (el) {
      jumpedLine.current = line
      el.scrollIntoView({ block: 'center' })
    }
  }, [line, hl])

  return (
    <div className="idiff" ref={bodyRef}>
      {shown.map((r, i) => (
        <div key={i} className={'idiff-row idiff-' + r.kind} data-newno={r.newNo ?? undefined}>
          <span className="idiff-num">{r.oldNo ?? ''}</span>
          <span className="idiff-num">{r.newNo ?? ''}</span>
          <span className="idiff-sign">
            {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
          </span>
          {/* Safe by construction (same as CodeView): highlightLines HTML-escapes every token's
              text; only Shiki's theme-derived color/fontStyle are interpolated raw. No sanitizer. */}
          {rowHtmlObjs[i] != null ? (
            <span className="idiff-code" dangerouslySetInnerHTML={rowHtmlObjs[i]} />
          ) : (
            <span className="idiff-code">{r.text || ' '}</span>
          )}
        </div>
      ))}
      {truncated && (
        <div className="idiff-hint">
          Diff truncated — showing first {MAX_INLINE_ROWS} of {rows.length} lines.
        </div>
      )}
    </div>
  )
}
