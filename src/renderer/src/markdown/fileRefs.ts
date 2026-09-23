import type { MarkdownIt, StateCore, Token } from 'markdown-it'
import { escapeHtml as esc } from './escape'

/**
 * FR-13 / FR-13b: `src/main/index.ts:975` written in prose (or in backticks) becomes a link
 * that opens that file at that line — the one thing Claude writes in every document and no
 * other markdown reader does.
 *
 * Recognition is deliberately narrow, because a false positive turns ordinary text into a
 * dead link:
 *   - a known code suffix is required, which is what keeps `v0.13.1:12` and `09:30` out;
 *   - a colon+number inside a URL is left alone (`http://host:3000/a.ts:12`);
 *   - fenced code is never touched (fences are not inline tokens, so they never reach here).
 *
 * Only the raw path string and the line number are emitted, as data. Resolving that path —
 * document directory first, workspace root second — happens at click time in the UI layer,
 * which is the only place that knows what exists on disk.
 */

// A path is a reference only if it ends in something that is plainly a file. The list is
// local on purpose: it answers "does this look like a file someone would open", which is a
// different question from "can we syntax-highlight it", and must not drift when a grammar
// is added to the highlighter.
const EXTENSIONS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'py',
  'pyi',
  'rb',
  'php',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'scala',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'cs',
  'm',
  'mm',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'lua',
  'pl',
  'r',
  'dart',
  'ex',
  'exs',
  'erl',
  'hs',
  'clj',
  'sql',
  'graphql',
  'gql',
  'proto',
  'tf',
  'gradle',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  'md',
  'markdown',
  'txt',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'xml',
  'env',
  'lock',
  'patch',
  'diff',
  'snap'
])

// Everything a path segment may contain: whitespace, the delimiters that bracket a path in
// prose, and CJK punctuation are out — the last group matters because Chinese prose has no
// spaces, so `见 docs/说明.md:3` would otherwise swallow the surrounding sentence.
const SEG = '[^\\s:"\'`<>()\\[\\]{}|,;/，。、；：！？（）《》「」【】…]'
const REF_RE = new RegExp(
  `(?<![\\w.~/-])(/?(?:${SEG}+/)*${SEG}+\\.([A-Za-z0-9]+)):(\\d+)(?::\\d+)?(?![\\w.-])`,
  'gu'
)
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g

interface Ref {
  start: number
  end: number
  text: string
  path: string
  line: string
}

export function findFileRefs(text: string): Ref[] {
  const urls: [number, number][] = []
  URL_RE.lastIndex = 0
  for (let u = URL_RE.exec(text); u; u = URL_RE.exec(text))
    urls.push([u.index, u.index + u[0].length])

  const out: Ref[] = []
  REF_RE.lastIndex = 0
  for (let m = REF_RE.exec(text); m; m = REF_RE.exec(text)) {
    const at = m.index
    if (!EXTENSIONS.has(m[2].toLowerCase())) continue
    if (urls.some(([from, to]) => at >= from && at < to)) continue
    out.push({ start: at, end: at + m[0].length, text: m[0], path: m[1], line: m[3] })
  }
  return out
}

/** No `href`: the pane's generic link handler would route a bare path as a preview link and
 *  lose the line — and a reference to a file that does not exist has to stay a quiet no-op
 *  (Edge Cases #5). The UI layer picks these up by class. */
function linkTokens(ref: Ref, level: number, state: StateCore): Token[] {
  const open = new state.Token('link_open', 'a', 1)
  open.attrSet('class', 'md-fileref')
  open.attrSet('data-path', ref.path)
  open.attrSet('data-line', ref.line)
  open.level = level
  const label = new state.Token('text', '', 0)
  label.content = ref.text
  label.level = level + 1
  const close = new state.Token('link_close', 'a', -1)
  close.level = level
  return [open, label, close]
}

function splitText(token: Token, state: StateCore): Token[] | null {
  const refs = findFileRefs(token.content)
  if (!refs.length) return null
  const out: Token[] = []
  let at = 0
  for (const ref of refs) {
    if (ref.start > at) {
      const before = new state.Token('text', '', 0)
      before.content = token.content.slice(at, ref.start)
      before.level = token.level
      out.push(before)
    }
    out.push(...linkTokens(ref, token.level, state))
    at = ref.end
  }
  if (at < token.content.length) {
    const tail = new state.Token('text', '', 0)
    tail.content = token.content.slice(at)
    tail.level = token.level
    out.push(tail)
  }
  return out
}

/** Inline code is rendered by hand here so the link can live inside the `<code>` — the whole
 *  point of FR-13's "recognized both inside and outside backticks". */
function codeInlineHtml(content: string): string | null {
  const refs = findFileRefs(content)
  if (!refs.length) return null
  let html = '<code>'
  let at = 0
  for (const ref of refs) {
    html += esc(content.slice(at, ref.start))
    html +=
      `<a class="md-fileref" data-path="${esc(ref.path)}" data-line="${ref.line}">` +
      `${esc(ref.text)}</a>`
    at = ref.end
  }
  return html + esc(content.slice(at)) + '</code>'
}

function rule(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !token.children) continue
    const out: Token[] = []
    let inLink = 0
    let changed = false
    for (const child of token.children) {
      if (child.type === 'link_open') inLink++
      else if (child.type === 'link_close') inLink--
      if (!inLink && child.type === 'text') {
        const split = splitText(child, state)
        if (split) {
          out.push(...split)
          changed = true
          continue
        }
      } else if (!inLink && child.type === 'code_inline') {
        const html = codeInlineHtml(child.content)
        if (html) {
          const replaced = new state.Token('html_inline', '', 0)
          replaced.content = html
          replaced.level = child.level
          out.push(replaced)
          changed = true
          continue
        }
      }
      out.push(child)
    }
    if (changed) token.children = out
  }
}

export function fileRefs(md: MarkdownIt): void {
  // before `linkify`, so a path that also looks like a domain (`说明.md:3` — `.md` is a real
  // TLD) is claimed here first; linkify then skips anything already inside a link
  md.core.ruler.after('inline', 'koloft_filerefs', rule)
}
