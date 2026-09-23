import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { PreviewItem } from '@shared/types'
import { WebView } from './WebView'
import { renderMarkdown } from '../markdown'
import { MERMAID_MAX_TEXT_SIZE, renderDiagram } from '../mermaidRender'

/** One entry of the document outline (FR-14). Structurally the `headings` element of
 *  `renderMarkdown`'s RenderedDoc — declared here because FilePane consumes it too. */
export interface MdHeading {
  id: string
  text: string
  level: number
}

/** Render-ahead band around the viewport, in px: a diagram just below the fold starts
 *  rendering before it is scrolled to, so the common case shows a picture, not a gap. */
const LAZY_MARGIN = 150

/** mermaid renders through a temporary element of this id, so it must be unique per call
 *  — two identical diagrams (BB-M22) and a re-render of the same one both come through. */
let diagramSeq = 0

/** What survives a reload untouched: every already-rendered diagram body, keyed by the
 *  source that produced it (FR-15), plus where the reader was. The source string IS the
 *  cache key — hashing it would only trade exactness for a shorter key. */
interface Salvage {
  bodyByCode: Map<string, string>
  scrollTop: number
}

/** The source a `data-code` carries. It is percent-encoded at the pipeline (DOMPurify
 *  deletes any attribute containing `-->`, which every mermaid arrow is — see `payload()`
 *  in markdown/index.ts), so every reader goes through here. A value that somehow is not
 *  valid encoding is handed back as-is rather than costing the block its source. */
function decodeAttr(raw: string | undefined): string {
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function codeOf(el: HTMLElement | null | undefined): string {
  return decodeAttr(el?.dataset.code)
}

function harvest(body: HTMLElement | null, token: string): Salvage | null {
  if (!body) return null
  const bodyByCode = new Map<string, string>()
  for (const el of body.querySelectorAll<HTMLElement>('.mmd')) {
    // Both marks are required. `data-state` says the block finished rendering — but the
    // document can write that attribute itself, and a hand-written `.mmd` claiming to be
    // "done" under a real diagram's `data-code` would have its body carried into the next
    // reload IN PLACE OF that diagram. `data-k` is what it cannot forge.
    if (el.dataset.k !== token || el.dataset.state !== 'done' || !el.dataset.code) continue
    bodyByCode.set(el.dataset.code, el.innerHTML)
  }
  return { bodyByCode, scrollTop: body.scrollTop }
}

/** Finish a diagram that has just landed in the DOM: give it its natural width, and make
 *  it a click/Enter target for the blow-up (FR-04).
 *
 *  mermaid's default sizing caps the svg at the container (`width="100%"` plus an inline
 *  `max-width`), which makes a wide diagram shrink to the pane instead of scrolling inside
 *  its own frame — the opposite of FR-17b. The cap is exactly the natural width, so it
 *  becomes the width. An svg rendered without that cap arrives already sized and is left
 *  alone. */
function settleDiagram(el: HTMLElement): void {
  const svg = el.querySelector('svg')
  if (!svg) return
  const cap = svg.style.maxWidth
  if (cap && cap !== 'none') {
    svg.style.width = cap
    svg.style.maxWidth = 'none'
  }
  el.tabIndex = 0
  el.setAttribute('role', 'button')
  el.setAttribute('aria-label', 'Zoom diagram')
}

/**
 * An image the reader cannot be shown, put in its place as the address it wanted.
 *
 * Two ways to get here, one seat: the sanitize hook stripped an off-machine `src` before
 * it could fire (FR-12b), or the file is simply not there. Either way a bare broken-image
 * icon would read as "the document is wrong"; the address says which file, and that nothing
 * was fetched.
 */
function blockImage(img: HTMLImageElement): void {
  const addr =
    img.getAttribute('data-blocked') || img.getAttribute('data-path') || img.getAttribute('src')
  const box = document.createElement('span')
  box.className = 'md-img-blocked'
  box.textContent = addr || img.getAttribute('alt') || 'image unavailable'
  img.replaceWith(box)
}

function fillError(el: HTMLElement, message: string, code: string, token: string): void {
  const card = document.createElement('div')
  card.className = 'mmd-error'
  const msg = document.createElement('div')
  msg.className = 'mmd-error-msg'
  msg.textContent = message
  const pre = document.createElement('pre')
  pre.textContent = code
  const copy = document.createElement('button')
  copy.className = 'mmd-copy'
  copy.textContent = 'Copy source'
  copy.dataset.code = encodeURIComponent(code)
  copy.dataset.k = token
  card.append(msg, pre, copy)
  el.replaceChildren(card)
}

function fillTooBig(el: HTMLElement, code: string): void {
  const box = document.createElement('div')
  box.className = 'mmd-toobig'
  const msg = document.createElement('div')
  msg.className = 'mmd-error-msg'
  msg.textContent = `Diagram too large to render (${code.length} characters).`
  const pre = document.createElement('pre')
  pre.textContent = code
  box.append(msg, pre)
  el.replaceChildren(box)
}

function flashCopied(btn: HTMLElement): void {
  btn.classList.add('copied')
  window.setTimeout(() => btn.classList.remove('copied'), 1200)
}

/** `tick` is the caller's reload counter (disk change / ↻): markdown re-reads and
 *  re-renders in place (the .md-body node persists, so scroll survives); an image
 *  cache-busts its url; pdf forwards it to the webview as a reload token.
 *  `onHeadings` hands the parsed outline up to FilePane, which owns the outline UI. */
export function PreviewViewer({
  item,
  tick = 0,
  onHeadings
}: {
  item: PreviewItem
  tick?: number
  onHeadings?: (h: MdHeading[]) => void
}): JSX.Element {
  const [html, setHtml] = useState('')
  /** this render's `data-k` mark: only chrome carrying it is this pipeline's own, and only
   *  that chrome is allowed to act (a document can forge the class, not the mark) */
  const token = useRef('')
  /** the blown-up diagram (FR-04): its already-sanitized svg plus the source to copy */
  const [zoom, setZoom] = useState<{ code: string; svg: string } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const salvage = useRef<Salvage | null>(null)
  const zoomFrom = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (item.kind !== 'markdown') return
    let cancelled = false
    window.api.preview
      .readText(item.src)
      .then((text) => renderMarkdown(text, { srcPath: item.src }))
      .then((doc) => {
        if (cancelled) return
        // taken here, one tick before React swaps innerHTML, because this is the last
        // moment the previous render is still in the DOM to be taken FROM
        salvage.current = harvest(bodyRef.current, token.current)
        setZoom(null) // a blow-up of the old diagram must not sit over the new document
        token.current = doc.token
        setHtml(doc.html)
        onHeadings?.(doc.headings)
      })
      .catch(() => {
        // on a reload keep the last good render (transient read failure mid-write);
        // only the initial load surfaces the failure
        if (!cancelled) setHtml((h) => h || '<p>Failed to read file.</p>')
      })
    return () => {
      cancelled = true
    }
  }, [item.src, item.kind, tick, onHeadings])

  // Hydration (FR-01/02/03/15). A LAYOUT effect, not a passive one: it runs in the same
  // frame as the innerHTML swap, so carried-over diagrams are back in place before the
  // browser paints — a passive effect would flash empty placeholders on every reload.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (item.kind !== 'markdown' || !body) return
    const carried = salvage.current
    salvage.current = null

    const pending = new Set<HTMLElement>()
    // `.mmd` this pipeline emitted, never one the document hand-wrote (which would also be
    // able to preset `data-state` and sit there as an unrendered impostor)
    for (const el of body.querySelectorAll<HTMLElement>('.mmd')) {
      if (el.dataset.k !== token.current) continue
      const prev = carried && el.dataset.code ? carried.bodyByCode.get(el.dataset.code) : undefined
      if (prev !== undefined) {
        el.innerHTML = prev
        el.dataset.state = 'done'
        settleDiagram(el)
      } else {
        pending.add(el)
      }
    }
    // an image whose src the sanitize hook stripped never had a chance to fail on its own
    for (const img of body.querySelectorAll<HTMLImageElement>('img[data-blocked]')) blockImage(img)

    // A formula KaTeX refused: the plugin's own error text is a ParseError message with
    // combining marks stitched through the source. §Edge Cases #6 asks for the author's
    // own text back, and the untouched source is right there in `title`.
    for (const bad of body.querySelectorAll<HTMLElement>('.katex-error')) {
      // `data-src` first: percent-encoded, so unlike `title` it survives a source holding
      // `]>` or `-->` (the SAFE_FOR_XML rule that `payload()` exists for). `title` is the
      // fallback for anything that reached here without one.
      const src = decodeAttr(bad.dataset.src) || bad.getAttribute('title')
      if (src) bad.textContent = src
    }

    // innerHTML swaps a shorter document in for a moment; re-assert where the reader was.
    // Once more after a frame: images have no height until they decode, so the first
    // assignment clamps against a document that is still shorter than it will be.
    if (carried?.scrollTop) {
      const want = carried.scrollTop
      body.scrollTop = want
      requestAnimationFrame(() => {
        if (body.isConnected && body.scrollTop < want) body.scrollTop = want
      })
    }
    if (!pending.size) return

    let disposed = false
    const renderNode = async (el: HTMLElement): Promise<void> => {
      if (el.dataset.state) return
      el.dataset.state = 'busy'
      const code = codeOf(el)
      // the same boundary renderDiagram enforces, checked here so an over-size source
      // reads as "too big to draw" (with the source kept) rather than as a failure
      if (code.trim().length > MERMAID_MAX_TEXT_SIZE) {
        fillTooBig(el, code)
        el.dataset.state = 'done'
        return
      }
      const res = await renderDiagram(code, `d${++diagramSeq}`)
      // the document was replaced under us — this result belongs to the old one
      if (disposed || !el.isConnected) return
      if (res.ok) {
        el.innerHTML = res.svg
        settleDiagram(el)
      } else {
        fillError(el, res.message, code, token.current)
      }
      el.dataset.state = 'done'
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          io.unobserve(e.target)
          void renderNode(e.target as HTMLElement)
        }
      },
      { root: body, rootMargin: `${LAZY_MARGIN}px` }
    )
    for (const el of pending) io.observe(el)

    // A hidden tab's pane is display:none, and a subtree with no box never intersects
    // anything — so nothing an IntersectionObserver says while away can be trusted.
    // The body regaining a size (tab switched back) is the cue to look again; the
    // observer also fires once on observe, which covers the first paint.
    const ro = new ResizeObserver(() => {
      if (disposed || !body.clientHeight) return
      const view = body.getBoundingClientRect()
      for (const el of pending) {
        if (el.dataset.state) {
          pending.delete(el)
          continue
        }
        const r = el.getBoundingClientRect()
        if (r.bottom < view.top - LAZY_MARGIN || r.top > view.bottom + LAZY_MARGIN) continue
        io.unobserve(el)
        void renderNode(el)
      }
    })
    ro.observe(body)

    return () => {
      disposed = true
      io.disconnect()
      ro.disconnect()
    }
  }, [html, item.kind])

  // Copy buttons (FR-06 / FR-02) and the zoom layer (FR-04), delegated off the body: the
  // markup under it is replaced wholesale on every reload, so per-element listeners would
  // have to be re-attached each time. The body node itself outlives every reload.
  useEffect(() => {
    const body = bodyRef.current
    if (item.kind !== 'markdown' || !body) return
    const openZoom = (fig: HTMLElement): void => {
      // only this pipeline's own placeholder blows up: a hand-written `.mmd` in the
      // document carries no mark, and its "Copy source" would otherwise be a clipboard
      // the reader never saw the contents of
      if (fig.dataset.k !== token.current) return
      if (!fig.querySelector('svg')) return
      zoomFrom.current = fig
      setZoom({ code: codeOf(fig), svg: fig.innerHTML })
    }
    const onClick = (ev: MouseEvent): void => {
      const t = ev.target as HTMLElement
      const copy = t.closest<HTMLElement>('button.md-code-copy, button.mmd-copy')
      if (copy) {
        ev.stopPropagation()
        // a copy button the document wrote itself carries no mark, and gets no clipboard
        if (copy.dataset.k !== token.current) return
        navigator.clipboard?.writeText(codeOf(copy)).catch(() => {})
        flashCopied(copy)
        return
      }
      const fig = t.closest<HTMLElement>('.mmd')
      if (fig) openZoom(fig)
    }
    // `error` does not bubble, so this one listens in the capture phase: a local image that
    // could not be read has to say so rather than leaving a mute broken icon.
    const onError = (ev: Event): void => {
      const t = ev.target
      if (t instanceof HTMLImageElement && body.contains(t)) blockImage(t)
    }
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      const fig = (ev.target as HTMLElement).closest<HTMLElement>('.mmd')
      if (!fig) return
      ev.preventDefault()
      openZoom(fig)
    }
    body.addEventListener('click', onClick)
    body.addEventListener('keydown', onKeyDown)
    body.addEventListener('error', onError, true)
    return () => {
      body.removeEventListener('click', onClick)
      body.removeEventListener('keydown', onKeyDown)
      body.removeEventListener('error', onError, true)
    }
  }, [item.kind])

  // Esc closes the blow-up — captured, so FilePane's own Esc (which closes the whole
  // pane) never sees the same keystroke.
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setZoom(null)
      zoomFrom.current?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [zoom])

  // React 19's setProp assigns innerHTML unconditionally whenever the {__html} wrapper's
  // IDENTITY changes, so an inline object here would rebuild the .md-body DOM on every
  // unrelated re-render — resetting scroll, and re-firing any MutationObserver watching
  // the pane (the find bar's re-search observer: that feedback was BUG-P1-01's busy loop).
  const mdHtml = useMemo(() => ({ __html: html }), [html])
  const zoomHtml = useMemo(() => ({ __html: zoom?.svg ?? '' }), [zoom])

  switch (item.kind) {
    case 'markdown':
      return (
        <div className="md-wrap">
          <div className="md-body" ref={bodyRef} dangerouslySetInnerHTML={mdHtml} />
          {zoom && (
            <div
              className="mmd-zoom"
              role="dialog"
              aria-label="Diagram"
              onClick={() => {
                setZoom(null)
                zoomFrom.current?.focus()
              }}
            >
              <button
                className="mmd-copy"
                data-code={zoom.code}
                onClick={(e) => {
                  e.stopPropagation()
                  navigator.clipboard?.writeText(zoom.code).catch(() => {})
                  flashCopied(e.currentTarget)
                }}
              >
                Copy source
              </button>
              <div className="mmd-zoom-fig" dangerouslySetInnerHTML={zoomHtml} />
            </div>
          )}
        </div>
      )
    case 'image':
      return (
        <div className="img-wrap">
          <img
            src={window.api.preview.fileUrl(item.src) + (tick ? `?v=${tick}` : '')}
            alt={item.label}
          />
        </div>
      )
    case 'pdf':
      return <WebView src={window.api.preview.fileUrl(item.src)} reloadToken={tick} />
    default:
      return <div className="hint">Unsupported preview type.</div>
  }
}
