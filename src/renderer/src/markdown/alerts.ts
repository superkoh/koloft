import type { MarkdownIt, StateCore, Token } from 'markdown-it'

const KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
type Kind = (typeof KINDS)[number]

const MARKER_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i

const SVG_OPEN =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">'
const BANG =
  '<rect x="7.1" y="5.4" width="1.8" height="4.6" rx=".9"/><circle cx="8" cy="11.8" r="1"/>'

const ICONS_OF_DOMPURIFY_ALLOWLISTED_SVG_PRIMITIVES: Record<Kind, string> = {
  note:
    SVG_OPEN +
    '<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<circle cx="8" cy="4.4" r="1"/><rect x="7.1" y="6.6" width="1.8" height="5.2" rx=".9"/></svg>',
  tip:
    SVG_OPEN + '<polygon points="8,.8 9.7,6.3 15.2,8 9.7,9.7 8,15.2 6.3,9.7 .8,8 6.3,6.3"/></svg>',
  important:
    SVG_OPEN +
    '<rect x=".8" y="1.2" width="14.4" height="11.2" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<polygon points="4,12.4 7.6,12.4 4,15.6"/>' +
    '<rect x="7.1" y="3.6" width="1.8" height="4" rx=".9"/><circle cx="8" cy="9.6" r="1"/></svg>',
  warning:
    SVG_OPEN +
    '<polygon points="8,1.2 15.3,14.2 .7,14.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<rect x="7.1" y="5.8" width="1.8" height="4.2" rx=".9"/><circle cx="8" cy="12" r="1"/></svg>',
  caution:
    SVG_OPEN +
    '<polygon points="4.7,.8 11.3,.8 15.2,4.7 15.2,11.3 11.3,15.2 4.7,15.2 .8,11.3 .8,4.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    BANG +
    '</svg>'
}

function titleHtml(kind: Kind): string {
  return (
    `<div class="md-alert-title"><span class="md-alert-icon">${ICONS_OF_DOMPURIFY_ALLOWLISTED_SVG_PRIMITIVES[kind]}</span>` +
    `<span class="md-alert-label">${kind.toUpperCase()}</span></div>\n`
  )
}

function closeOf(tokens: Token[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].type === 'blockquote_open') depth++
    else if (tokens[i].type === 'blockquote_close') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function rule(state: StateCore): void {
  const tokens = state.tokens
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].type !== 'blockquote_open') continue
    if (tokens[i + 1]?.type !== 'paragraph_open' || tokens[i + 2]?.type !== 'inline') continue
    const m = MARKER_RE.exec(tokens[i + 2].content)
    if (!m) continue
    const close = closeOf(tokens, i)
    if (close < 0) continue

    const kind = m[1].toLowerCase() as Kind
    tokens[i].tag = 'div'
    tokens[i].attrJoin('class', `md-alert md-alert-${kind}`)
    tokens[close].tag = 'div'

    const body = tokens[i + 2].content.slice(m[0].length)
    tokens[i + 2].content = body
    if (!body.trim()) {
      tokens[i + 1].hidden = true
      tokens[i + 2].hidden = true
      if (tokens[i + 3]?.type === 'paragraph_close') tokens[i + 3].hidden = true
    }

    const title = new state.Token('html_block', '', 0)
    title.content = titleHtml(kind)
    title.block = true
    title.level = tokens[i + 1].level
    tokens.splice(i + 1, 0, title)
  }
}

export function alerts(md: MarkdownIt): void {
  md.core.ruler.before('inline', 'koloft_alerts', rule)
}
