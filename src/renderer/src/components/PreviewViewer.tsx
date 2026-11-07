import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { previewFileUrl } from '@shared/browserRoute'
import type { PreviewItem } from '@shared/types'
import { WebView } from './WebView'
import { cleanBlock, renderMarkdown, type RenderedDoc } from '../markdown'
import { MERMAID_MAX_TEXT_SIZE, renderDiagram } from '../mermaidRender'
import '../previewViewer.css'

export interface MdHeading {
  id: string
  text: string
  level: number
}

const DIAGRAM_RENDER_AHEAD_PX = 150
const BLOCKS_PER_SLICE_MS = 8

const UNREADABLE: RenderedDoc = {
  blocks: ['<p>Failed to read file.</p>'],
  headings: [],
  diagrams: [],
  frontMatter: null
}

let mermaidTempIdSeq = 0

interface Shown {
  html: string
  nodes: ChildNode[]
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

function drawnDiagrams(body: HTMLElement, token: string): Map<string, string> {
  const bodyByCode = new Map<string, string>()
  for (const el of body.querySelectorAll<HTMLElement>('.mmd')) {
    if (el.dataset.k !== token || el.dataset.state !== 'done' || !el.dataset.code) continue
    bodyByCode.set(el.dataset.code, el.innerHTML)
  }
  return bodyByCode
}

function placeInOrder(body: HTMLElement, was: Shown[], now: Shown[]): void {
  const kept = new Set(now.flatMap((b) => b.nodes))
  for (const b of was) for (const n of b.nodes) if (!kept.has(n)) n.remove()
  let at = body.firstChild
  for (const b of now) {
    for (const n of b.nodes) {
      if (n === at) at = at.nextSibling
      else body.insertBefore(n, at)
    }
  }
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

function blockImage(img: HTMLImageElement): HTMLElement {
  const addr =
    img.getAttribute('data-blocked') || img.getAttribute('data-path') || img.getAttribute('src')
  const box = document.createElement('span')
  box.className = 'md-img-blocked'
  box.textContent = addr || img.getAttribute('alt') || 'image unavailable'
  img.replaceWith(box)
  return box
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
  onHeadings
}: {
  item: PreviewItem
  tick?: number
  onHeadings?: (h: MdHeading[]) => void
}): JSX.Element {
  const [doc, setDoc] = useState<RenderedDoc | null>(null)
  const [token] = useState(() => crypto.randomUUID())
  const [zoom, setZoom] = useState<{ code: string; svg: string } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const shown = useRef<Shown[]>([])
  const watchDiagram = useRef<(el: HTMLElement) => void>(() => {})
  const zoomFrom = useRef<HTMLElement | null>(null)
  const reading = useRef(false)
  const readAgain = useRef(false)
  const gone = useRef(false)

  useEffect(
    () => () => {
      gone.current = true
    },
    []
  )

  useEffect(() => {
    if (item.kind !== 'markdown') return
    const read = (): void => {
      if (reading.current) {
        readAgain.current = true
        return
      }
      reading.current = true
      window.api.preview
        .readText(item.src)
        .then((text) => renderMarkdown(text, { srcPath: item.src, token }))
        .then((d) => {
          if (!gone.current) setDoc(d)
        })
        .catch(() => {
          if (!gone.current) setDoc((d) => d ?? UNREADABLE)
        })
        .finally(() => {
          reading.current = false
          if (!readAgain.current || gone.current) return
          readAgain.current = false
          read()
        })
    }
    read()
  }, [item.src, item.kind, tick, token])

  useEffect(() => {
    if (doc) onHeadings?.(doc.headings)
  }, [doc, onHeadings])

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
    const drawn = firstPaint ? new Map<string, string>() : drawnDiagrams(body, token)
    const now: Shown[] = []
    const fresh: Shown[] = []
    if (firstPaint) shown.current = now

    const make = (html: string): Shown => {
      const frag = cleanBlock(html)
      for (const el of frag.querySelectorAll<HTMLElement>('.mmd')) {
        const prev =
          el.dataset.k === token && el.dataset.code ? drawn.get(el.dataset.code) : undefined
        if (prev === undefined) continue
        el.innerHTML = prev
        el.dataset.state = 'done'
        settleDiagram(el)
      }
      for (const img of frag.querySelectorAll<HTMLImageElement>('img[data-blocked]'))
        blockImage(img)
      // PLATFORM§26
      for (const bad of frag.querySelectorAll<HTMLElement>('.katex-error')) {
        const src = decodeAttr(bad.dataset.src) || bad.getAttribute('title')
        if (src) bad.textContent = src
      }
      return { html, nodes: [...frag.childNodes] }
    }
    const watch = (b: Shown): void => {
      for (const n of b.nodes) {
        if (!(n instanceof HTMLElement)) continue
        const found = [
          ...(n.matches('.mmd') ? [n] : []),
          ...n.querySelectorAll<HTMLElement>('.mmd')
        ]
        for (const el of found)
          if (el.dataset.k === token && !el.dataset.state) watchDiagram.current(el)
      }
    }

    let i = 0
    let timer = 0
    const step = (): void => {
      const until = performance.now() + BLOCKS_PER_SLICE_MS
      while (i < doc.blocks.length) {
        const html = doc.blocks[i++]
        const kept = reusable.get(html)?.shift()
        const b = kept ?? make(html)
        now.push(b)
        if (!kept) fresh.push(b)
        if (firstPaint) {
          body.append(...b.nodes)
          watch(b)
        }
        if (performance.now() >= until) break
      }
      if (i < doc.blocks.length) {
        timer = window.setTimeout(step)
        return
      }
      if (firstPaint) return
      placeInOrder(body, was, now)
      for (const b of fresh) watch(b)
      shown.current = now
    }
    step()
    return () => clearTimeout(timer)
  }, [doc, token])

  useEffect(() => {
    const body = bodyRef.current
    if (item.kind !== 'markdown' || !body) return
    const pending = new Set<HTMLElement>()
    let disposed = false
    const renderNode = async (el: HTMLElement): Promise<void> => {
      if (el.dataset.state) return
      el.dataset.state = 'busy'
      const code = codeOf(el)
      if (code.trim().length > MERMAID_MAX_TEXT_SIZE) {
        fillTooBig(el, code)
        el.dataset.state = 'done'
        return
      }
      const res = await renderDiagram(code, `d${++mermaidTempIdSeq}`)
      if (disposed || !el.isConnected) return
      if (res.ok) {
        el.innerHTML = res.svg
        settleDiagram(el)
      } else {
        fillError(el, res.message, code, token)
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
      { root: body, rootMargin: `${DIAGRAM_RENDER_AHEAD_PX}px` }
    )
    watchDiagram.current = (el) => {
      pending.add(el)
      io.observe(el)
    }

    const ro = new ResizeObserver(() => {
      if (disposed || !body.clientHeight) return
      const view = body.getBoundingClientRect()
      for (const el of pending) {
        if (el.dataset.state || !el.isConnected) {
          pending.delete(el)
          io.unobserve(el)
          continue
        }
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
      watchDiagram.current = () => {}
    }
  }, [item.kind, token])

  useEffect(() => {
    const body = bodyRef.current
    if (item.kind !== 'markdown' || !body) return
    const openZoom = (fig: HTMLElement): void => {
      if (fig.dataset.k !== token) return
      if (!fig.querySelector('svg')) return
      zoomFrom.current = fig
      setZoom({ code: codeOf(fig), svg: fig.innerHTML })
    }
    const onClick = (ev: MouseEvent): void => {
      const t = ev.target as HTMLElement
      const copy = t.closest<HTMLElement>('button.md-code-copy, button.mmd-copy')
      if (copy) {
        ev.stopPropagation()
        if (copy.dataset.k !== token) return
        navigator.clipboard?.writeText(codeOf(copy)).catch(() => {})
        flashCopied(copy)
        return
      }
      const fig = t.closest<HTMLElement>('.mmd')
      if (fig) openZoom(fig)
    }
    const onError = (ev: Event): void => {
      const t = ev.target
      if (!(t instanceof HTMLImageElement) || !body.contains(t)) return
      const box = blockImage(t)
      for (const b of shown.current) {
        const at = b.nodes.indexOf(t)
        if (at >= 0) b.nodes[at] = box
      }
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
  }, [item.kind, token])

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

  // PLATFORM§25
  const zoomHtml = useMemo(() => ({ __html: zoom?.svg ?? '' }), [zoom])

  switch (item.kind) {
    case 'markdown':
      return (
        <div className="md-wrap">
          <div className="md-body" ref={bodyRef} />
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
