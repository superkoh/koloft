import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { previewFileUrl } from '@shared/browserRoute'
import type { PreviewItem } from '@shared/types'
import { WebView } from './WebView'
import { cleanBlock, renderMarkdown, type RenderedDoc } from '../markdown'
import type { SourceLines } from '../markdown/lines'
import {
  cachedDiagram,
  hashCode,
  makeCache,
  MERMAID_MAX_TEXT_SIZE,
  renderDiagram
} from '../mermaidRender'
import { CommentBox, type CommentTarget } from './CommentBox'
import { CHANGES_MSG, passageAt, passagePrompt, type Passage } from './changesModel'
import { findInBlocks, linesOfRange, selectedRangeIn, swapMark, type DrawnBlock } from './mdPassage'
import '../previewViewer.css'

export interface MdHeading {
  id: string
  text: string
  level: number
}

type PassageComment = CommentTarget & { rel: string }

const DIAGRAM_RENDER_AHEAD_PX = 150
const PAINT_SLICE_MS = 8
const TOKEN = crypto.randomUUID()
const COMMENT_BUTTON_ROOM_PX = 90
const COMMENT_BUTTON_H_PX = 26
const COMMENT_BUTTON_GAP_PX = 4

type DrawnDoc = RenderedDoc & { text: string }
type Drawn = Awaited<ReturnType<typeof renderDiagram>>

const UNREADABLE: DrawnDoc = {
  blocks: ['<p>Failed to read file.</p>'],
  lines: [null],
  headings: [],
  text: ''
}

let mermaidTempIdSeq = 0

const DIAGRAM_HEIGHTS_KEPT = 1000
const drawnHeights = makeCache<number>(DIAGRAM_HEIGHTS_KEPT)
const heightKey = (code: string): string => hashCode(code.trim())

interface Shown extends DrawnBlock {
  html: string
}

interface OpenComment {
  passage: Passage
  lines: SourceLines | null
  marked: string
}

interface Diagrams {
  watch: (el: HTMLElement) => void
  forgetRemoved: () => void
}

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

function placeInOrder(body: HTMLElement, was: Shown[], now: Shown[]): void {
  const kept = new Set<Element>(now.map((b) => b.el))
  const top = body.scrollTop
  let at = body.firstElementChild
  for (const { el } of now) {
    while (at && !kept.has(at)) at = at.nextElementSibling
    if (el === at) at = at.nextElementSibling
    else body.insertBefore(el, at)
  }
  for (const { el } of was) if (!kept.has(el)) el.remove()
  body.scrollTop = top
}

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

function showDrawn(el: HTMLElement, drawn: Drawn, code: string): void {
  if (!drawn.ok) fillError(el, drawn.message, code, TOKEN)
  else {
    el.innerHTML = drawn.svg
    settleDiagram(el)
  }
  el.dataset.state = 'done'
}

function fillAtOnce(el: HTMLElement): boolean {
  const code = codeOf(el)
  const svg = cachedDiagram(code, `d${++mermaidTempIdSeq}`)
  if (svg !== undefined) showDrawn(el, { ok: true, svg }, code)
  return svg !== undefined
}

function blockImage(img: HTMLImageElement): void {
  const addr =
    img.getAttribute('data-blocked') || img.getAttribute('data-path') || img.getAttribute('src')
  const box = document.createElement('span')
  box.className = 'md-img-blocked'
  box.textContent = addr || img.getAttribute('alt') || 'image unavailable'
  img.replaceWith(box)
}

function reuseDrawnDiagrams(block: HTMLElement, body: HTMLElement): void {
  for (const fig of block.querySelectorAll<HTMLElement>('.mmd')) {
    if (fig.dataset.k !== TOKEN || !fig.dataset.code) continue
    const drawn = body.querySelector<HTMLElement>(
      `.mmd[data-state="done"][data-k="${TOKEN}"][data-code="${CSS.escape(fig.dataset.code)}"]`
    )
    if (!drawn) continue
    fig.innerHTML = drawn.innerHTML
    fig.dataset.state = 'done'
    settleDiagram(fig)
  }
}

function blockElement(html: string): HTMLDivElement {
  const el = document.createElement('div')
  el.append(cleanBlock(html))
  for (const img of el.querySelectorAll<HTMLImageElement>('img[data-blocked]')) blockImage(img)
  // PLATFORM§26
  for (const bad of el.querySelectorAll<HTMLElement>('.katex-error')) {
    const src = decodeAttr(bad.dataset.src) || bad.getAttribute('title')
    if (src) bad.textContent = src
  }
  return el
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

export function PreviewViewer({
  item,
  tick = 0,
  onHeadings,
  comment
}: {
  item: PreviewItem
  tick?: number
  onHeadings?: (h: MdHeading[]) => void
  comment?: PassageComment
}): JSX.Element {
  const [doc, setDoc] = useState<DrawnDoc | null>(null)
  const [zoom, setZoom] = useState<{ code: string; svg: string } | null>(null)
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null)
  const [open, setOpen] = useState<OpenComment | null>(null)
  const [note, setNote] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const shown = useRef<Shown[]>([])
  const drawnText = useRef('')
  const mark = useRef<Range | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const diagrams = useRef<Diagrams>({ watch: () => {}, forgetRemoved: () => {} })
  const zoomFrom = useRef<HTMLElement | null>(null)
  const pipeline = useRef({ busy: false, again: false, read: () => {} })
  const tellHeadings = useRef(onHeadings)
  tellHeadings.current = onHeadings

  useEffect(() => {
    if (item.kind !== 'markdown') return
    const p = pipeline.current
    p.read = () => {
      if (p.busy) {
        p.again = true
        return
      }
      p.busy = true
      window.api.preview
        .readText(item.src)
        .then((text) =>
          renderMarkdown({ text, srcPath: item.src, token: TOKEN }).then((d) => ({ ...d, text }))
        )
        .then(setDoc, () => setDoc((d) => (d ? { ...d } : UNREADABLE)))
    }
    p.read()
  }, [item.src, item.kind, tick])

  const markAgainIfRedrawn = (): void => {
    const was = mark.current
    const o = openRef.current
    if (!was || !o || was.toString() === o.marked) return
    const again = findInBlocks(shown.current, o.lines, o.marked)
    swapMark(again, was)
    mark.current = again
  }

  useEffect(() => {
    const body = bodyRef.current
    if (!doc || !body) return
    setZoom(null)
    const was = shown.current
    const firstPaint = was.length === 0
    const reusable = new Map<string, Shown[]>()
    for (const b of was) {
      const same = reusable.get(b.html)
      if (same) same.push(b)
      else reusable.set(b.html, [b])
    }
    const now: Shown[] = []
    const fresh: Shown[] = []
    if (firstPaint) {
      shown.current = now
      drawnText.current = doc.text
    }

    const watch = (b: Shown): void => {
      for (const el of b.el.querySelectorAll<HTMLElement>('.mmd')) {
        if (el.dataset.k !== TOKEN || el.dataset.state || fillAtOnce(el)) continue
        const was = drawnHeights.get(heightKey(codeOf(el)))
        if (was) el.style.minHeight = `${was}px`
        diagrams.current.watch(el)
      }
    }

    const painted = (): void => {
      tellHeadings.current?.(doc.headings)
      markAgainIfRedrawn()
      const p = pipeline.current
      p.busy = false
      if (!p.again) return
      p.again = false
      p.read()
    }

    let i = 0
    const nextSlice = new MessageChannel()
    const step = (): void => {
      const until = performance.now() + PAINT_SLICE_MS
      while (i < doc.blocks.length) {
        const at = i++
        const html = doc.blocks[at]
        const lines = doc.lines[at] ?? null
        const kept = reusable.get(html)?.shift()
        const b = kept ? { ...kept, lines } : { html, el: blockElement(html), lines }
        now.push(b)
        if (firstPaint) {
          body.append(b.el)
          watch(b)
        } else if (!kept) {
          reuseDrawnDiagrams(b.el, body)
          fresh.push(b)
        }
        if (performance.now() >= until) break
      }
      if (i < doc.blocks.length) {
        nextSlice.port2.postMessage(null)
        return
      }
      if (!firstPaint) {
        placeInOrder(body, was, now)
        diagrams.current.forgetRemoved()
        for (const b of fresh) watch(b)
        shown.current = now
        drawnText.current = doc.text
      }
      painted()
    }
    nextSlice.port1.onmessage = step
    step()
    return () => nextSlice.port1.close()
  }, [doc])

  useEffect(() => {
    const body = bodyRef.current
    if (item.kind !== 'markdown' || !body) return
    const pending = new Set<HTMLElement>()
    let disposed = false
    const renderNode = async (el: HTMLElement): Promise<void> => {
      pending.delete(el)
      if (el.dataset.state) return
      el.dataset.state = 'busy'
      const code = codeOf(el)
      if (code.trim().length > MERMAID_MAX_TEXT_SIZE) {
        fillTooBig(el, code)
        el.dataset.state = 'done'
      } else {
        const res = await renderDiagram(code, `d${++mermaidTempIdSeq}`)
        if (disposed || !el.isConnected) return
        showDrawn(el, res, code)
      }
      el.style.minHeight = ''
      if (el.offsetHeight) drawnHeights.set(heightKey(code), el.offsetHeight)
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          io.unobserve(e.target)
          void renderNode(e.target as HTMLElement)
        }
      },
      { root: body, rootMargin: `${DIAGRAM_RENDER_AHEAD_PX}px` }
    )
    diagrams.current = {
      watch: (el) => {
        pending.add(el)
        io.observe(el)
      },
      forgetRemoved: () => {
        for (const el of pending) {
          if (el.isConnected) continue
          pending.delete(el)
          io.unobserve(el)
        }
      }
    }

    const ro = new ResizeObserver(() => {
      if (disposed || !body.clientHeight) return
      const view = body.getBoundingClientRect()
      for (const el of pending) {
        const r = el.getBoundingClientRect()
        if (
          r.bottom < view.top - DIAGRAM_RENDER_AHEAD_PX ||
          r.top > view.bottom + DIAGRAM_RENDER_AHEAD_PX
        )
          continue
        io.unobserve(el)
        void renderNode(el)
      }
    })
    ro.observe(body)

    return () => {
      disposed = true
      io.disconnect()
      ro.disconnect()
      diagrams.current = { watch: () => {}, forgetRemoved: () => {} }
    }
  }, [item.kind])

  useEffect(() => {
    const body = bodyRef.current
    if (item.kind !== 'markdown' || !body) return
    const openZoom = (fig: HTMLElement): void => {
      if (fig.dataset.k !== TOKEN) return
      if (!fig.querySelector('svg')) return
      zoomFrom.current = fig
      setZoom({ code: codeOf(fig), svg: fig.innerHTML })
    }
    const onClick = (ev: MouseEvent): void => {
      const t = ev.target as HTMLElement
      const copy = t.closest<HTMLElement>('button.md-code-copy, button.mmd-copy')
      if (copy) {
        ev.stopPropagation()
        if (copy.dataset.k !== TOKEN) return
        navigator.clipboard?.writeText(codeOf(copy)).catch(() => {})
        flashCopied(copy)
        return
      }
      const fig = t.closest<HTMLElement>('.mmd')
      if (fig) openZoom(fig)
    }
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

  const commentable = item.kind === 'markdown' && !!comment
  useEffect(() => {
    const wrap = wrapRef.current
    const body = bodyRef.current
    if (!commentable || !wrap || !body) return
    let raf = 0
    let showing = false
    const hide = (): void => {
      showing = false
      setPick(null)
    }
    const place = (): void => {
      raf = 0
      const rects = selectedRangeIn(body)?.getClientRects()
      const end = rects?.[rects.length - 1]
      if (!end) return hide()
      const view = body.getBoundingClientRect()
      if (end.bottom < view.top || end.top > view.bottom) return hide()
      const box = wrap.getBoundingClientRect()
      const x = Math.max(0, Math.min(end.right - box.left, box.width - COMMENT_BUTTON_ROOM_PX))
      const y = Math.min(
        end.bottom - box.top + COMMENT_BUTTON_GAP_PX,
        box.height - COMMENT_BUTTON_H_PX
      )
      showing = true
      setPick((p) => (p?.x === x && p.y === y ? p : { x, y }))
    }
    const soon = (): void => {
      const at = document.getSelection()?.anchorNode
      if (!showing && !(at && body.contains(at))) return
      if (!raf) raf = requestAnimationFrame(place)
    }
    document.addEventListener('selectionchange', soon)
    body.addEventListener('scroll', soon)
    return () => {
      document.removeEventListener('selectionchange', soon)
      body.removeEventListener('scroll', soon)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [commentable])

  useEffect(
    () => () => {
      swapMark(null, mark.current)
      mark.current = null
    },
    []
  )

  const openComment = (): void => {
    const body = bodyRef.current
    const range = body && selectedRangeIn(body)
    if (!body || !range || !comment) return
    const lines = linesOfRange(range, body, shown.current)
    // PLATFORM§68
    const said = document.getSelection()?.toString() ?? ''
    setOpen({
      passage: passageAt(comment.rel, drawnText.current, lines, said),
      lines,
      marked: range.toString()
    })
    setNote('')
    setPick(null)
    swapMark(range, mark.current)
    mark.current = range
  }

  const closeComment = (): void => {
    setOpen(null)
    swapMark(null, mark.current)
    mark.current = null
  }

  // PLATFORM§25
  const zoomHtml = useMemo(() => ({ __html: zoom?.svg ?? '' }), [zoom])

  switch (item.kind) {
    case 'markdown':
      return (
        <div className={'md-wrap' + (open ? ' commenting' : '')} ref={wrapRef}>
          <div className="md-body" ref={bodyRef} />
          {comment && pick && !open && (
            <button
              type="button"
              className="md-cmt"
              style={{ left: pick.x, top: pick.y }}
              disabled={!!comment.blocked}
              title={comment.blocked ?? CHANGES_MSG.commentPassage}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openComment}
            >
              ✎ comment
            </button>
          )}
          {comment && open && (
            <CommentBox
              on="passage"
              head={`${open.passage.place} · “${open.passage.selected}”`}
              blocked={comment.blocked}
              note={note}
              setNote={setNote}
              onClose={closeComment}
              onPut={() => {
                closeComment()
                comment.put(passagePrompt(open.passage, note))
              }}
            />
          )}
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
          <img src={previewFileUrl(item.src) + (tick ? `?v=${tick}` : '')} alt={item.label} />
        </div>
      )
    case 'pdf':
      return <WebView src={previewFileUrl(item.src)} reloadToken={tick} />
    default:
      return <div className="hint">Unsupported preview type.</div>
  }
}
