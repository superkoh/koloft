import type { MarkdownIt, StateCore, Token } from 'markdown-it'

export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

export function headingAnchors(md: MarkdownIt): void {
  md.core.ruler.push('koloft_heading_anchors', (state: StateCore) => {
    const seen = new Map<string, number>()
    let ordinal = 0
    state.tokens.forEach((token: Token, i: number) => {
      if (token.type !== 'heading_open') return
      ordinal++
      const slug = headingSlug(state.tokens[i + 1]?.content ?? '') || `h-${ordinal}`
      const n = seen.get(slug) ?? 0
      seen.set(slug, n + 1)
      token.attrSet('id', n ? `${slug}-${n}` : slug)
    })
    return true
  })
}
