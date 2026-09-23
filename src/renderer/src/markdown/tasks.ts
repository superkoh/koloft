import type { MarkdownIt, StateCore } from 'markdown-it'

const MARKER_RE = /^\[([ xX])\][ \t]*/

function rule(state: StateCore): void {
  const tokens = state.tokens
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type !== 'inline') continue
    if (tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue
    const children = tokens[i].children
    const first = children?.[0]
    if (!children || first?.type !== 'text') continue
    const m = MARKER_RE.exec(first.content)
    if (!m) continue

    first.content = first.content.slice(m[0].length)
    const box = new state.Token('html_inline', '', 0)
    const checked = m[1] !== ' ' ? ' checked' : ''
    box.content = `<input class="md-task" type="checkbox"${checked} disabled> `
    box.level = first.level
    children.unshift(box)
  }
}

export function tasks(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'koloft_tasks', rule)
}
