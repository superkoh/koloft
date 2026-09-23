import type { MarkdownIt, StateCore, Token } from 'markdown-it'
import { escapeHtml as esc } from './escape'

const FILE_SUFFIXES_KEPT_APART_FROM_HIGHLIGHTER_LANGS = new Set([
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

const PATH_CHAR_STOPPING_AT_CJK_PUNCTUATION =
  '[^\\s:"\'`<>()\\[\\]{}|,;/，。、；：！？（）《》「」【】…]'
const REF_RE = new RegExp(
  `(?<![\\w.~/-])(/?(?:${PATH_CHAR_STOPPING_AT_CJK_PUNCTUATION}+/)*${PATH_CHAR_STOPPING_AT_CJK_PUNCTUATION}+\\.([A-Za-z0-9]+)):(\\d+)(?::\\d+)?(?![\\w.-])`,
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
    if (!FILE_SUFFIXES_KEPT_APART_FROM_HIGHLIGHTER_LANGS.has(m[2].toLowerCase())) continue
    if (urls.some(([from, to]) => at >= from && at < to)) continue
    out.push({ start: at, end: at + m[0].length, text: m[0], path: m[1], line: m[3] })
  }
  return out
}

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
  md.core.ruler.after('inline', 'koloft_filerefs', rule)
}
