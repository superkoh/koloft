import { useCallback, useEffect, useRef, useState } from 'react'

const HL_ALL = 'find-all'
const HL_ACTIVE = 'find-active'
const DIFF_GUTTER_NOT_FILE_CONTENT = '.idiff-num, .idiff-sign'

export interface FindCount {
  current: number
  total: number
}

export interface FindBackend {
  count: FindCount
  search: (query: string) => void
  next: () => void
  prev: () => void
  clear: () => void
}

interface NodeSpan {
  node: Text
  start: number
  end: number
}

function foldCaseKeepingLength(s: string): string {
  let out = ''
  for (const ch of s) {
    const lo = ch.toLowerCase()
    out += lo.length === ch.length ? lo : ch
  }
  return out
}

function computeMatchRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return []

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement
      if (!el) return NodeFilter.FILTER_REJECT
      const tag = el.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT
      if (el.closest('.code-state')) return NodeFilter.FILTER_REJECT
      if (el.closest(DIFF_GUTTER_NOT_FILE_CONTENT)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })

  const spans: NodeSpan[] = []
  let full = ''
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    spans.push({ node: n, start: full.length, end: full.length + n.data.length })
    full += n.data
  }
  if (spans.length === 0) return []

  const haystack = foldCaseKeepingLength(full)
  const needle = foldCaseKeepingLength(query)
  const ranges: Range[] = []
  for (let from = 0; ;) {
    const i = haystack.indexOf(needle, from)
    if (i === -1) break
    const s = locate(spans, i)
    const e = locate(spans, i + needle.length)
    if (s && e) {
      const r = document.createRange()
      r.setStart(s.node, s.offset)
      r.setEnd(e.node, e.offset)
      ranges.push(r)
    }
    from = i + needle.length
  }
  return ranges
}

function locate(spans: NodeSpan[], index: number): { node: Text; offset: number } | null {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = spans[mid]
    if (index < s.start) hi = mid - 1
    else if (index > s.end) lo = mid + 1
    else return { node: s.node, offset: index - s.start }
  }
  return null
}

// PLATFORM§24
function nearestVerticalScroller(range: Range, root: HTMLElement): HTMLElement | null {
  const start = range.startContainer
  let el: HTMLElement | null =
    start.nodeType === Node.ELEMENT_NODE ? (start as HTMLElement) : start.parentElement
  while (el && el !== root) {
    const oy = getComputedStyle(el).overflowY
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el
    el = el.parentElement
  }
  return null
}

function scrollRangeIntoView(range: Range, container: HTMLElement): void {
  const r = range.getBoundingClientRect()
  if (r.height === 0 && r.width === 0) return
  const c = container.getBoundingClientRect()
  if (r.top < c.top || r.bottom > c.bottom) {
    const top = r.top - c.top + container.scrollTop - container.clientHeight / 2 + r.height / 2
    container.scrollTop = Math.max(0, top)
  }
  if (r.left < c.left || r.right > c.right) {
    const left = r.left - c.left + container.scrollLeft - container.clientWidth / 2 + r.width / 2
    container.scrollLeft = Math.max(0, left)
  }
}

export function useDomFind(getRoot: () => HTMLElement | null): FindBackend {
  const rangesRef = useRef<Range[]>([])
  const activeRef = useRef(0)
  const queryRef = useRef('')
  const observerRef = useRef<MutationObserver | null>(null)
  const [count, setCount] = useState<FindCount>({ current: 0, total: 0 })

  const setCountIfChanged = useCallback((current: number, total: number) => {
    setCount((c) => (c.current === current && c.total === total ? c : { current, total }))
  }, [])

  const render = useCallback(() => {
    const ranges = rangesRef.current
    if (ranges.length === 0) {
      CSS.highlights.delete(HL_ALL)
      CSS.highlights.delete(HL_ACTIVE)
      setCountIfChanged(0, 0)
      return
    }
    if (activeRef.current >= ranges.length) activeRef.current = 0
    const active = activeRef.current

    const all = new Highlight()
    ranges.forEach((r, i) => {
      if (i !== active) all.add(r)
    })
    all.priority = 0
    CSS.highlights.set(HL_ALL, all)

    const hot = new Highlight(ranges[active])
    hot.priority = 1
    CSS.highlights.set(HL_ACTIVE, hot)

    setCountIfChanged(active + 1, ranges.length)
    const root = getRoot()
    const scroller = root ? nearestVerticalScroller(ranges[active], root) : null
    if (scroller) scrollRangeIntoView(ranges[active], scroller)
  }, [getRoot, setCountIfChanged])

  const recompute = useCallback(() => {
    const root = getRoot()
    rangesRef.current = root ? computeMatchRanges(root, queryRef.current) : []
    render()
  }, [getRoot, render])

  const search = useCallback(
    (query: string) => {
      queryRef.current = query
      activeRef.current = 0
      observerRef.current?.disconnect()
      observerRef.current = null
      const root = getRoot()
      if (root && query) {
        const obs = new MutationObserver(() => recompute())
        obs.observe(root, { childList: true, subtree: true, characterData: true })
        observerRef.current = obs
      }
      recompute()
    },
    [getRoot, recompute]
  )

  const step = useCallback(
    (delta: number) => {
      const n = rangesRef.current.length
      if (!n) return
      activeRef.current = (activeRef.current + delta + n) % n
      render()
    },
    [render]
  )

  const next = useCallback(() => step(1), [step])
  const prev = useCallback(() => step(-1), [step])

  const clear = useCallback(() => {
    observerRef.current?.disconnect()
    observerRef.current = null
    rangesRef.current = []
    activeRef.current = 0
    queryRef.current = ''
    CSS.highlights.delete(HL_ALL)
    CSS.highlights.delete(HL_ACTIVE)
    setCount({ current: 0, total: 0 })
  }, [])

  useEffect(() => clear, [clear])

  return { count, search, next, prev, clear }
}
