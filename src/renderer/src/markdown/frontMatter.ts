import type { MarkdownIt, StateBlock, Token } from 'markdown-it'
import { escapeHtml as esc } from './escape'

const FENCE = '---'
const MAX_SCAN = 200

const PAIR_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(.*))?$/

function valueIsWhole(v: string): boolean {
  const pairs: [string, string][] = [
    ['[', ']'],
    ['{', '}']
  ]
  for (const [open, close] of pairs) {
    if (v.startsWith(open) && !v.endsWith(close)) return false
  }
  for (const q of ['"', "'"]) {
    if (v.startsWith(q) && !(v.length > 1 && v.endsWith(q))) return false
  }
  return true
}

export function parseFrontMatter(body: string): [string, string][] | null {
  const pairs: [string, string][] = []
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const m = PAIR_RE.exec(line)
    if (!m) {
      const last = pairs[pairs.length - 1]
      if (!last || !/^[ \t]/.test(line)) return null
      last[1] = last[1] ? `${last[1]} ${line.trim()}` : line.trim()
      continue
    }
    const value = m[2] ?? ''
    if (!valueIsWhole(value)) return null
    pairs.push([m[1], value])
  }
  return pairs
}

function pairsOf(token: Token): [string, string][] {
  const p = token.meta?.pairs
  return Array.isArray(p) ? (p as [string, string][]) : []
}

function rule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (startLine !== 0 || state.parentType !== 'root' || state.blkIndent !== 0) return false
  const start = state.bMarks[0] + state.tShift[0]
  if (state.tShift[0] !== 0) return false
  if (state.src.slice(start, state.eMarks[0]).trim() !== FENCE) return false

  let close = -1
  for (let line = 1; line < endLine && line <= MAX_SCAN; line++) {
    const from = state.bMarks[line] + state.tShift[line]
    if (state.src.slice(from, state.eMarks[line]).trim() === FENCE) {
      close = line
      break
    }
  }
  if (close < 0) return false
  if (silent) return true

  const body = state.getLines(startLine + 1, close, 0, false)
  const pairs = parseFrontMatter(body)
  if (pairs === null) {
    const token = state.push('koloft_front_matter_raw', '', 0)
    token.content = body
    token.map = [startLine, close + 1]
  } else if (pairs.length) {
    const token = state.push('koloft_front_matter', '', 0)
    token.meta = { pairs }
    token.map = [startLine, close + 1]
    state.env.frontMatter = Object.fromEntries(pairs)
  }
  state.line = close + 1
  return true
}

export function frontMatter(md: MarkdownIt): void {
  md.block.ruler.before('table', 'koloft_front_matter', rule, { alt: [] })

  md.renderer.rules.koloft_front_matter = (tokens, idx) => {
    const rows = pairsOf(tokens[idx])
      .map(
        ([k, v]) =>
          `<span class="md-fm-key">${esc(k)}</span><span class="md-fm-val">${esc(v)}</span>`
      )
      .join('')
    return `<div class="md-frontmatter">${rows}</div>\n`
  }

  md.renderer.rules.koloft_front_matter_raw = (tokens, idx) =>
    `<pre class="md-fm-raw"><code>${esc(tokens[idx].content)}</code></pre>\n`
}
