import type { MarkdownIt, StateCore, Token } from 'markdown-it'

/**
 * X-9①: an `#anchor` link in a rendered markdown preview scrolls the pane — which needs
 * something to scroll TO. markdown-it emits no heading ids, so a document's own table of
 * contents points at nothing; these are the ids every md writer already assumes (the
 * GitHub slug their `[…](#section)` was written against).
 */

/** lowercase, punctuation dropped, runs of spacing to a single dash — GitHub's rule for
 *  the anchor a heading answers to. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

/** markdown-it plugin: `md.use(headingAnchors)`. Repeats are suffixed in document order,
 *  so two `## Notes` are `#notes` and `#notes-1` rather than one unreachable anchor. */
export function headingAnchors(md: MarkdownIt): void {
  md.core.ruler.push('koloft_heading_anchors', (state: StateCore) => {
    const seen = new Map<string, number>()
    let ordinal = 0
    state.tokens.forEach((token: Token, i: number) => {
      if (token.type !== 'heading_open') return
      ordinal++
      // A heading of pure punctuation (`## ---`) slugs to nothing. It still gets an id —
      // a positional one — because the preview's outline lists EVERY heading and finds
      // them in the DOM by id: one heading without an id slides every later row of the
      // outline onto the wrong section.
      const slug = headingSlug(state.tokens[i + 1]?.content ?? '') || `h-${ordinal}`
      const n = seen.get(slug) ?? 0
      seen.set(slug, n + 1)
      token.attrSet('id', n ? `${slug}-${n}` : slug)
    })
    return true
  })
}
