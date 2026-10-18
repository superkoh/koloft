export const TIP_DELAY_MS = 600
const GAP_PX = 6
const EDGE_PX = 4

interface Shown {
  el: Element
  text: string
}

function titled(target: EventTarget | null): Element | null {
  const el = target instanceof Element ? target.closest('[title]') : null
  return el && el.getAttribute('title') ? el : null
}

// PLATFORM§24 ADR-0013
export function installTitleTips(doc: Document = document): () => void {
  const win = doc.defaultView ?? window
  const tip = doc.createElement('div')
  tip.className = 'kt-tip'
  tip.setAttribute('role', 'tooltip')
  let pending: { el: Element; timer: number } | null = null
  let shown: Shown | null = null
  let dismissed: Element | null = null

  const place = (el: Element): void => {
    const box = el.getBoundingClientRect()
    const own = tip.getBoundingClientRect()
    const vw = doc.documentElement.clientWidth
    const vh = doc.documentElement.clientHeight
    const below = box.bottom + GAP_PX
    const top = below + own.height <= vh - EDGE_PX ? below : box.top - GAP_PX - own.height
    const left = Math.min(Math.max(box.left, EDGE_PX), vw - EDGE_PX - own.width)
    tip.style.top = `${Math.max(top, EDGE_PX)}px`
    tip.style.left = `${Math.max(left, EDGE_PX)}px`
  }

  const show = (el: Element): void => {
    pending = null
    const text = el.getAttribute('title')
    if (!text || !el.isConnected) return
    el.removeAttribute('title')
    shown = { el, text }
    tip.textContent = text
    doc.body.appendChild(tip)
    place(el)
  }

  const hide = (): void => {
    if (pending) win.clearTimeout(pending.timer)
    pending = null
    if (!shown) return
    if (!shown.el.hasAttribute('title')) shown.el.setAttribute('title', shown.text)
    shown = null
    tip.remove()
  }

  const over = (e: Event): void => {
    if (shown && e.target instanceof Node && shown.el.contains(e.target)) {
      const inner = titled(e.target)
      if (!inner || !shown.el.contains(inner)) return
    }
    const el = titled(e.target)
    if (el && el === pending?.el) return
    hide()
    if (!el || el === dismissed) return
    dismissed = null
    pending = { el, timer: win.setTimeout(() => show(el), TIP_DELAY_MS) }
  }

  const out = (e: Event): void => {
    const to = (e as MouseEvent).relatedTarget
    const host = shown?.el ?? pending?.el
    if (host && to instanceof Node && host.contains(to)) return
    if (dismissed && !(to instanceof Node && dismissed.contains(to))) dismissed = null
    hide()
  }

  const dismiss = (): void => {
    dismissed = shown?.el ?? pending?.el ?? dismissed
    hide()
  }

  doc.addEventListener('mouseover', over, true)
  doc.addEventListener('mouseout', out, true)
  doc.addEventListener('mousedown', dismiss, true)
  doc.addEventListener('keydown', dismiss, true)
  doc.addEventListener('wheel', dismiss, { capture: true, passive: true })
  win.addEventListener('blur', hide)
  return () => {
    hide()
    doc.removeEventListener('mouseover', over, true)
    doc.removeEventListener('mouseout', out, true)
    doc.removeEventListener('mousedown', dismiss, true)
    doc.removeEventListener('keydown', dismiss, true)
    doc.removeEventListener('wheel', dismiss, { capture: true })
    win.removeEventListener('blur', hide)
  }
}
