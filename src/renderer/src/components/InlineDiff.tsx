import { memo, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ParsedDiff } from '@shared/unifiedDiff'
import { langForPath } from '../highlight'
import { dropQueuedColoring, highlightLinesOffThread } from '../offThread'
import '../inlineDiff.css'

export const MAX_INLINE_ROWS = 5000

interface Hl {
  lang: string
  codes: string[]
  html: string[][]
}

function htmlByLineText(code: string, html: string[] = []): Map<string, string> {
  const byText = new Map<string, string>()
  code.split('\n').forEach((text, j) => {
    if (html[j] != null && !byText.has(text)) byText.set(text, html[j])
  })
  return byText
}

export const InlineDiff = memo(function InlineDiff({
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
  const colorQueue = useRef({})

  const lang = langForPath(src)
  const codes = useMemo(() => (hasDel ? [newText, oldText] : [newText]), [newText, oldText, hasDel])
  useEffect(() => {
    if (truncated) {
      setHl(null)
      return
    }
    const owner = colorQueue.current
    let cancelled = false
    highlightLinesOffThread(owner, codes, lang)
      .then((html) => {
        if (!cancelled) setHl({ lang, codes, html })
      })
      .catch(() => {
        if (!cancelled) setHl(null)
      })
    return () => {
      cancelled = true
      dropQueuedColoring(owner)
    }
  }, [codes, lang, truncated])

  const rowsHtml = useMemo<(string | null)[]>(() => {
    if (!hl || hl.lang !== lang) return shown.map(() => null)
    if (hl.codes !== codes) {
      const newByText = htmlByLineText(hl.codes[0], hl.html[0])
      const oldByText = htmlByLineText(hl.codes[1] ?? '', hl.html[1])
      return shown.map((r) => (r.kind === 'del' ? oldByText : newByText).get(r.text) ?? null)
    }
    const [newHtml, oldHtml = []] = hl.html
    let ni = 0
    let oi = 0
    return shown.map((r) => {
      if (r.kind === 'del') return oldHtml[oi++] ?? ''
      if (r.kind === 'add') return newHtml[ni++] ?? ''
      oi++
      return newHtml[ni++] ?? ''
    })
  }, [shown, hl, lang, codes])

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
})
