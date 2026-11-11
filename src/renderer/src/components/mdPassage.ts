import { LINES_IN_BLOCK_ATTR, type SourceLines } from '../markdown/lines'
import { computeMatchRanges } from '../useDomFind'

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

function markedLines(node: Node, block: HTMLElement, base: SourceLines): SourceLines {
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

function lineInCode(
  container: Node,
  offset: number,
  node: Node,
  fence: SourceLines
): SourceLines | null {
  const pre = (node instanceof Element ? node : node.parentElement)?.closest('.md-code pre')
  if (!pre) return null
  const before = document.createRange()
  before.setStart(pre, 0)
  before.setEnd(container, offset)
  const line = fence[0] + before.toString().split('\n').length
  return line < fence[1] - 1 ? ([line, line + 1] as SourceLines) : null
}

function linesAt(
  container: Node,
  offset: number,
  side: 'start' | 'end',
  body: HTMLElement,
  drawn: DrawnBlock[]
): SourceLines | null {
  const node = nodeAt(container, offset, side)
  const block = blockOf(node, body)
  const base = block && drawn.find((b) => b.el === block)?.lines
  if (!block || !base) return null
  const own = markedLines(node, block, base)
  return lineInCode(container, offset, node, own) ?? own
}

export function linesOfRange(
  range: Range,
  body: HTMLElement,
  drawn: DrawnBlock[]
): SourceLines | null {
  const first = linesAt(range.startContainer, range.startOffset, 'start', body, drawn)
  const last = linesAt(range.endContainer, range.endOffset, 'end', body, drawn)
  if (!first || !last) return first ?? last
  return [Math.min(first[0], last[0]), Math.max(first[1], last[1])]
}

export function findInBlocks(
  drawn: DrawnBlock[],
  lines: SourceLines | null,
  text: string
): Range | null {
  if (!lines) return null
  for (const b of drawn) {
    if (!b.lines || b.lines[1] <= lines[0] || b.lines[0] >= lines[1]) continue
    const [r] = computeMatchRanges(b.el, text)
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
