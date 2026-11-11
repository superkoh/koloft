import { LINES_IN_BLOCK_ATTR, type SourceLines } from '../markdown/lines'

export interface DrawnBlock {
  el: HTMLElement
  lines: SourceLines | null
}

const MARK = 'md-cmt'

export function selectedRangeIn(body: HTMLElement): Range | null {
  const sel = document.getSelection()
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null
  const live = sel.getRangeAt(0)
  if (!body.contains(live.commonAncestorContainer) || !sel.toString().trim()) return null
  return withoutEmptyTail(live.cloneRange(), body)
}

export function withoutEmptyTail(range: Range, body: HTMLElement): Range {
  if (range.endOffset !== 0) return range
  const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  walk.currentNode = range.endContainer
  let prev = walk.previousNode() as Text | null
  while (prev && !prev.data.trim()) prev = walk.previousNode() as Text | null
  if (prev && range.intersectsNode(prev)) range.setEnd(prev, prev.data.length)
  return range
}

function blockOf(node: Node, body: HTMLElement): HTMLElement | null {
  let n: Node | null = node
  while (n && n.parentNode !== body) n = n.parentNode
  return n instanceof HTMLElement ? n : null
}

function nodeAt(container: Node, offset: number, side: 'start' | 'end'): Node {
  if (container.nodeType === Node.TEXT_NODE) return container
  return container.childNodes[side === 'start' ? offset : offset - 1] ?? container
}

function linesAt(node: Node, body: HTMLElement, drawn: DrawnBlock[]): SourceLines | null {
  const block = blockOf(node, body)
  const base = block && drawn.find((b) => b.el === block)?.lines
  if (!block || !base) return null
  const el = (node instanceof Element ? node : node.parentElement)?.closest(
    `[${LINES_IN_BLOCK_ATTR}]`
  )
  if (!el || !block.contains(el)) return base
  const [from, to] = el.getAttribute(LINES_IN_BLOCK_ATTR)!.split(',').map(Number)
  const inBlock =
    Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to
      ? ([base[0] + from, base[0] + to] as SourceLines)
      : null
  return inBlock && inBlock[1] <= base[1] ? inBlock : base
}

export function linesOfRange(
  range: Range,
  body: HTMLElement,
  drawn: DrawnBlock[]
): SourceLines | null {
  const first = linesAt(nodeAt(range.startContainer, range.startOffset, 'start'), body, drawn)
  const last = linesAt(nodeAt(range.endContainer, range.endOffset, 'end'), body, drawn)
  if (!first || !last) return first ?? last
  return [Math.min(first[0], last[0]), Math.max(first[1], last[1])]
}

function rangeOfText(el: HTMLElement, text: string): Range | null {
  const nodes: Text[] = []
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (walk.nextNode()) nodes.push(walk.currentNode as Text)
  const at = nodes
    .map((n) => n.data)
    .join('')
    .indexOf(text)
  if (at < 0) return null
  const r = document.createRange()
  let seen = 0
  for (const n of nodes) {
    const end = seen + n.data.length
    if (at >= seen && at <= end) r.setStart(n, at - seen)
    if (at + text.length >= seen && at + text.length <= end) {
      r.setEnd(n, at + text.length - seen)
      return r
    }
    seen = end
  }
  return null
}

export function findInBlocks(
  drawn: DrawnBlock[],
  lines: SourceLines | null,
  text: string
): Range | null {
  const near = (b: DrawnBlock): boolean =>
    !!lines && !!b.lines && b.lines[1] > lines[0] && b.lines[0] < lines[1]
  for (const b of [...drawn.filter(near), ...drawn.filter((b) => !near(b))]) {
    const r = rangeOfText(b.el, text)
    if (r) return r
  }
  return null
}

export function swapMark(next: Range | null, prev: Range | null): void {
  let marks = CSS.highlights.get(MARK)
  if (!marks) {
    marks = new Highlight()
    CSS.highlights.set(MARK, marks)
  }
  if (prev) marks.delete(prev)
  if (next) marks.add(next)
}
