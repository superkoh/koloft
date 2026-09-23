import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { PreviewItem } from '@shared/types'
import { WebView } from './WebView'
import { renderMarkdown } from '../markdown'
import { MERMAID_MAX_TEXT_SIZE, renderDiagram } from '../mermaidRender'

export interface MdHeading {
  id: string
  text: string
  level: number
}

const DIAGRAM_RENDER_AHEAD_PX = 150

let mermaidTempIdSeq = 0

interface Salvage {
  bodyByCode: Map<string, string>
  scrollTop: number
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

function harvest(body: HTMLElement | null, token: string): Salvage | null {
  if (!body) return null
  const bodyByCode = new Map<string, string>()
  for (const el of body.querySelectorAll<HTMLElement>('.mmd')) {
    if (el.dataset.k !== token || el.dataset.state !== 'done' || !el.dataset.code) continue
    bodyByCode.set(el.dataset.code, el.innerHTML)
  }
  return { bodyByCode, scrollTop: body.scrollTop }
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
  const token = useRef('')
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
        salvage.current = harvest(bodyRef.current, token.current)
        setZoom(null)
        token.current = doc.token
        setHtml(doc.html)
        onHeadings?.(doc.headings)
      })
      .catch(() => {
        if (!cancelled) setHtml((h) => h || '<p>Failed to read file.</p>')
      })
    return () => {
      cancelled = true
    }
  }, [item.src, item.kind, tick, onHeadings])

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (item.kind !== 'markdown' || !body) return
    const carried = salvage.current
    salvage.current = null

    const pending = new Set<HTMLElement>()
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
    for (const img of body.querySelectorAll<HTMLImageElement>('img[data-blocked]')) blockImage(img)

    // PLATFORM§26
    for (const bad of body.querySelectorAll<HTMLElement>('.katex-error')) {
      const src = decodeAttr(bad.dataset.src) || bad.getAttribute('title')
      if (src) bad.textContent = src
    }

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
      { root: body, rootMargin: `${DIAGRAM_RENDER_AHEAD_PX}px` }
    )
    for (const el of pending) io.observe(el)

    const ro = new ResizeObserver(() => {
      if (disposed || !body.clientHeight) return
      const view = body.getBoundingClientRect()
      for (const el of pending) {
        if (el.dataset.state) {
          pending.delete(el)
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
    }
  }, [html, item.kind])

  useEffect(() => {
    const body = bodyRef.current
    if (item.kind !== 'markdown' || !body) return
    const openZoom = (fig: HTMLElement): void => {
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
        if (copy.dataset.k !== token.current) return
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

  // PLATFORM§25
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
