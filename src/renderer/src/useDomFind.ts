import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * In-place text search over rendered DOM (Shiki code / markdown-it HTML) using the
 * CSS Custom Highlight API — overlay-only, so it never mutates the DOM and can't break
 * Shiki's nested token spans. Two registered highlights: `find-all` (every match, dim)
 * and `find-active` (the current match, bright); the active range is excluded from
 * `find-all` so there's no overlap to resolve. Styled via `::highlight()` in styles.css.
 *
 * `getRoot` returns the viewer body (`.file-pane-body`); we search/scroll within its
 * scrollable carrier child. Preview content paints asynchronously (Shiki/markdown
 * resolve after mount, and the code carrier swaps loading → content), so an active
 * query re-runs via a MutationObserver on the root until the bar closes.
 *
 * Known limitations (deliberately not handled): matches that straddle a block-element
 * boundary can phantom-match (no inter-block separator in the haystack), and the span
 * table is rebuilt per keystroke rather than cached — both negligible for KB-scale
 * source/markdown files.
 */

const HL_ALL = 'find-all'
const HL_ACTIVE = 'find-active'

export interface FindCount {
  current: number
  total: number
}

export interface FindBackend {
  count: FindCount
  /** recompute matches for `query` and jump to the first one (empty query clears) */
  search: (query: string) => void
  next: () => void
  prev: () => void
  /** drop all highlights and reset the count */
  clear: () => void
}

interface NodeSpan {
  node: Text
  start: number
  end: number
}

/** Case-fold while preserving length. `toLowerCase()` changes length for a few code
 *  points (e.g. U+0130 'İ' → 2 units), which would desync the haystack index from the
 *  text-node offset table; fold per code point but keep the original when its lowercase
 *  differs in length, so the index↔offset mapping always holds (that one char won't fold). */
function foldCase(s: string): string {
  let out = ''
  for (const ch of s) {
    const lo = ch.toLowerCase()
    out += lo.length === ch.length ? lo : ch
  }
  return out
}

/** All matches of `query` under `root`, as Ranges that may span text-node bounds (Shiki
 *  splits a word across several spans, so a per-node search would miss them). Skips the
 *  `.code-state` placeholder (loading/binary/error message), which isn't file content. */
function computeMatchRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return []

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement
      if (!el) return NodeFilter.FILTER_REJECT
      const tag = el.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT
      if (el.closest('.code-state')) return NodeFilter.FILTER_REJECT
      // the inline-diff gutter (line numbers) and +/− sign column aren't file content —
      // searching them would match line-number digits and inflate the count
      if (el.closest('.idiff-num, .idiff-sign')) return NodeFilter.FILTER_REJECT
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

  const haystack = foldCase(full)
  const needle = foldCase(query)
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
    from = i + needle.length // non-overlapping
  }
  return ranges
}

/** Binary-search the span table for the text node + offset holding global `index`. */
function locate(spans: NodeSpan[], index: number): { node: Text; offset: number } | null {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = spans[mid]
    if (index < s.start) hi = mid - 1
    else if (index > s.end) lo = mid + 1
    else return { node: s.node, offset: index - s.start } // [start,end]: boundary stays in this node
  }
  return null
}

/** Resolve the nearest ancestor of `range` (up to `root`) that actually scrolls it
 *  vertically. The scroller is NOT always root.firstElementChild — code content lives in
 *  `.code-body`, nested inside a `.code-wrap` wrapper that never scrolls (its content is
 *  absolutely positioned, so it has no scroll height), so using firstElementChild would
 *  scroll a non-scrolling element and the active match would stay off-screen.
 *
 *  Real vertical overflow (scrollHeight > clientHeight) is required, not just a computed
 *  overflow-y of auto/scroll: when a box sets `overflow-x: auto` only, CSS coerces its
 *  unspecified `overflow-y` from visible to auto (CSS Overflow L3), so a markdown `<pre>`
 *  would otherwise pose as a vertical scroller and swallow the scroll before it reaches
 *  the true scroller (`.md-body`). */
function scrollContainerFor(range: Range, root: HTMLElement): HTMLElement | null {
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

/** Scroll `range` to the center of its scroll container, but only on the axis where it's
 *  off-screen — highlights don't affect layout and there's no element to scrollIntoView. */
function scrollRangeIntoView(range: Range, container: HTMLElement): void {
  const r = range.getBoundingClientRect()
  if (r.height === 0 && r.width === 0) return
  const c = container.getBoundingClientRect()
  if (r.top < c.top || r.bottom > c.bottom) {
    const top = r.top - c.top + container.scrollTop - container.clientHeight / 2 + r.height / 2
    container.scrollTop = Math.max(0, top)
  }
  // long unwrapped code lines can leave the match off to the side
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

  // render() re-runs on every MutationObserver tick, so its setCount must bail out when
  // nothing changed: a fresh {current,total} object per pass would re-render the pane,
  // and any DOM the pane re-touches re-fires the observer — an observer→setState→commit
  // microtask cycle that starves the event loop (BUG-P1-01) instead of converging.
  const setCountStable = useCallback((current: number, total: number) => {
    setCount((c) => (c.current === current && c.total === total ? c : { current, total }))
  }, [])

  const render = useCallback(() => {
    const ranges = rangesRef.current
    if (ranges.length === 0) {
      CSS.highlights.delete(HL_ALL)
      CSS.highlights.delete(HL_ACTIVE)
      setCountStable(0, 0)
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

    setCountStable(active + 1, ranges.length)
    const root = getRoot()
    const scroller = root ? scrollContainerFor(ranges[active], root) : null
    if (scroller) scrollRangeIntoView(ranges[active], scroller)
  }, [getRoot, setCountStable])

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
      // re-search when async preview content settles (Shiki/markdown paint after mount)
      // or the carrier swaps (code loading → .code-body); disconnected on clear
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

  // a left-over highlight / observer would bleed onto the next file, so clear on unmount
  useEffect(() => clear, [clear])

  return { count, search, next, prev, clear }
}
