import { LINES_IN_BLOCK_ATTR, type SourceLines } from '../markdown/lines'

export interface DrawnBlock {
  el: HTMLElement
  lines: SourceLines | null
}

const MARK = 'md-cmt'

export function selectedRangeIn(body: HTMLElement): Range | null {
  const sel = document.getSelection()
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null
  const r = sel.getRangeAt(0)
  if (!body.contains(r.commonAncestorContainer) || !r.toString().trim()) return null
  return r
}

export function withoutEmptyTail(range: Range, body: HTMLElement): Range {
  if (range.endOffset !== 0) return range
  const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  walk.currentNode = range.endContainer
  let prev = walk.previousNode()
  while (prev && !prev.textContent?.trim()) prev = walk.previousNode()
  if (!prev || !range.intersectsNode(prev)) return range
  const out = range.cloneRange()
  out.setEnd(prev, prev.textContent!.length)
  return out
}

function blockOf(node: Node, body: HTMLElement): HTMLElement | null {
  let n: Node | null = node
  while (n && n.parentNode !== body) n = n.parentNode
  return n instanceof HTMLElement ? n : null
}

function linesInBlock(at: Node, block: HTMLElement): SourceLines | null {
  const el = (at instanceof Element ? at : at.parentElement)?.closest(`[${LINES_IN_BLOCK_ATTR}]`)
  if (!el || !block.contains(el)) return null
  const [from, to] = el.getAttribute(LINES_IN_BLOCK_ATTR)!.split(',').map(Number)
  return [from, to]
}

export function linesOfRange(
  range: Range,
  body: HTMLElement,
  drawn: DrawnBlock[]
): SourceLines | null {
  const linesOf = (el: HTMLElement | null): SourceLines | null =>
    (el && drawn.find((b) => b.el === el)?.lines) || null
  const first = blockOf(range.startContainer, body)
  const last = blockOf(range.endContainer, body)
  const head = linesOf(first)
  const tail = linesOf(last)
  if (first !== last) return head && tail ? [head[0], tail[1]] : (head ?? tail)
  const inner = first && linesInBlock(range.commonAncestorContainer, first)
  return head && inner ? [head[0] + inner[0], head[0] + inner[1]] : head
}

export function findInBlocks(
  drawn: DrawnBlock[],
  lines: SourceLines | null,
  text: string
): Range | null {
  if (!lines) return null
  for (const b of drawn) {
    if (!b.lines || b.lines[1] <= lines[0] || b.lines[0] >= lines[1]) continue
    const nodes: Text[] = []
    const walk = document.createTreeWalker(b.el, NodeFilter.SHOW_TEXT)
    while (walk.nextNode()) nodes.push(walk.currentNode as Text)
    const at = nodes
      .map((n) => n.data)
      .join('')
      .indexOf(text)
    if (at < 0) continue
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
