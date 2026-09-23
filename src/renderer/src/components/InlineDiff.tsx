import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ParsedDiff } from '../inlineDiff'
import { highlightLines, langForPath } from '../highlight'

export const MAX_INLINE_ROWS = 5000

interface Hl {
  newHtml: string[]
  oldHtml: string[]
}

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
    if (truncated) return
    let cancelled = false
    Promise.all([
      highlightLines(newText, lang),
      hasDel ? highlightLines(oldText, lang) : Promise.resolve<string[]>([])
    ])
      .then(([newHtml, oldHtml]) => {
        if (!cancelled) setHl({ newHtml, oldHtml })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [newText, oldText, lang, truncated, hasDel])

  const rowsHtml = useMemo<(string | null)[]>(() => {
    if (!hl) return shown.map(() => null)
    let ni = 0
    let oi = 0
    return shown.map((r) => {
      if (r.kind === 'del') return hl.oldHtml[oi++] ?? ''
      if (r.kind === 'add') return hl.newHtml[ni++] ?? ''
      oi++
      return hl.newHtml[ni++] ?? ''
    })
  }, [shown, hl])

  // PLATFORM§25
  const rowHtmlObjs = useMemo<({ __html: string } | null)[]>(
    () => rowsHtml.map((h) => (h != null ? { __html: h || '&nbsp;' } : null)),
    [rowsHtml]
  )

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
