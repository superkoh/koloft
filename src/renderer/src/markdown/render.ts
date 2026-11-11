import MarkdownIt from 'markdown-it'
import type { Env, Token } from 'markdown-it'
import footnotePlugin from 'markdown-it-footnote'
import type { MarkdownKatexOptions } from '@vscode/markdown-it-katex'
import type { KatexOptions } from 'katex'
import { headingAnchors } from '../mdHeadings'
import { highlightCodeLight, langForFence } from '../highlight'
import { alerts } from './alerts'
import { assets } from './assets'
import { fileRefs } from './fileRefs'
import { frontMatter } from './frontMatter'
import { tasks } from './tasks'
import { LINES_IN_BLOCK_ATTR, type SourceLines } from './lines'
import { escapeHtml as esc } from '@shared/escapeHtml'

export interface RenderedDoc {
  blocks: string[]
  lines: (SourceLines | null)[]
  headings: { id: string; text: string; level: number }[]
}

const MAX_HIGHLIGHT_LINES = 2000
const COLORED_FENCE_CHARS_KEPT = 2_000_000
const TAGS_THAT_NEED_NO_CLOSE = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
  'p',
  'li',
  'dt',
  'dd',
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'tfoot',
  'colgroup',
  'caption',
  'option',
  'optgroup',
  'rp',
  'rt'
])

const KATEX_OPTIONS: MarkdownKatexOptions & KatexOptions = {
  trust: false,
  strict: 'ignore',
  throwOnError: true,
  output: 'html',
  // PLATFORM§26
  maxSize: 10,
  maxExpand: 1000
}

const BIDI_RE = /[\u{61C}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu

function markBidi(html: string): string {
  return html.replace(BIDI_RE, (c) => {
    const point = c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
    return `<span class="md-bidi">&lt;U+${point}&gt;</span>`
  })
}

interface RenderEnv extends Env {
  srcPath: string
  koloftToken: string
  koloftHighlight: Map<string, string>
}

function fenceLang(token: Token): string {
  return token.info.trim().split(/\s+/)[0] ?? ''
}

function fenceCode(token: Token): string {
  return token.content.replace(/\n$/, '')
}

function cacheKey(lang: string, code: string): string {
  return `${lang}\u0000${code}`
}

function plainCode(code: string): string {
  return `<pre class="shiki md-code-plain"><code>${esc(code)}</code></pre>`
}

function isDiagram(lang: string): boolean {
  return lang.toLowerCase() === 'mermaid'
}

function payload(code: string): string {
  return encodeURIComponent(code)
}

function renderFence(token: Token, env: RenderEnv): string {
  const label = fenceLang(token)
  const code = fenceCode(token)

  if (isDiagram(label)) {
    return `<div class="mmd" data-k="${env.koloftToken}" data-code="${payload(code)}"></div>\n`
  }

  const highlighted = env.koloftHighlight?.get(cacheKey(label, code)) ?? plainCode(code)
  const lines = token.attrGet(LINES_IN_BLOCK_ATTR)
  const mark = lines ? ` ${LINES_IN_BLOCK_ATTR}="${lines}"` : ''
  return (
    `<div class="md-code"${mark}><span class="md-code-lang">${esc(label)}</span>` +
    `<button class="md-code-copy" type="button" data-k="${env.koloftToken}" ` +
    `data-code="${payload(code)}">Copy</button>` +
    `${markBidi(highlighted)}</div>\n`
  )
}

const md = new MarkdownIt({ html: true, linkify: true, breaks: true })
  .use(headingAnchors)
  .use(frontMatter)
  .use(alerts)
  .use(tasks)
  .use(fileRefs)
  .use(assets)
  .use(footnotePlugin)

let katexLoaded: Promise<void> | null = null
function loadKatex(): Promise<void> {
  return (katexLoaded ??= import('@vscode/markdown-it-katex')
    .then((m) => {
      md.use(m.default, KATEX_OPTIONS)
    })
    .catch((err: unknown) => {
      katexLoaded = null
      throw err
    }))
}

md.renderer.rules.fence = (tokens, idx, _options, env) => renderFence(tokens[idx], env as RenderEnv)

md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>\n'
md.renderer.rules.table_close = () => '</table></div>\n'

function headingText(inline: Token | undefined): string {
  if (!inline) return ''
  if (!inline.children) return inline.content
  return inline.children
    .filter((c) => c.type === 'text' || c.type === 'code_inline')
    .map((c) => c.content)
    .join('')
    .trim()
}

function outline(tokens: Token[]): RenderedDoc['headings'] {
  const out: RenderedDoc['headings'] = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue
    out.push({
      id: String(tokens[i].attrGet('id') ?? ''),
      text: headingText(tokens[i + 1]),
      level: Number(tokens[i].tag.slice(1))
    })
  }
  return out
}

const colored = new Map<string, string>()
let coloredChars = 0

function keepColored(key: string, html: string): void {
  coloredChars -= colored.get(key)?.length ?? 0
  colored.delete(key)
  colored.set(key, html)
  coloredChars += html.length
  for (const [oldest, was] of colored) {
    if (coloredChars <= COLORED_FENCE_CHARS_KEPT || oldest === key) break
    colored.delete(oldest)
    coloredChars -= was.length
  }
}

async function warmHighlight(tokens: Token[], env: RenderEnv): Promise<void> {
  const jobs = new Map<string, { lang: string; code: string }>()
  for (const token of tokens) {
    if (token.type !== 'fence') continue
    const label = fenceLang(token)
    if (isDiagram(label)) continue
    const code = fenceCode(token)
    if (code.split('\n').length > MAX_HIGHLIGHT_LINES) continue
    jobs.set(cacheKey(label, code), { lang: langForFence(label), code })
  }
  await Promise.all(
    [...jobs].map(async ([key, job]) => {
      try {
        const html = colored.get(key) ?? (await highlightCodeLight(job.code, job.lang))
        keepColored(key, html)
        env.koloftHighlight.set(key, html)
      } catch {}
    })
  )
}

function keepErrorSource(html: string): string {
  return html.replace(
    /<(\w+)([^>]*\bclass="[^"]*katex-error[^"]*"[^>]*\btitle="([^"]*)"[^>]*)>/g,
    (_whole, tag: string, attrs: string, title: string) =>
      `<${tag}${attrs} data-src="${encodeURIComponent(unescapeAttr(title))}">`
  )
}

function unescapeAttr(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

const RAW_TAG_OR_COMMENT_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g

function tagsLeftOpen(html: string, countOpeners: boolean): number {
  let open = 0
  for (const m of html.matchAll(RAW_TAG_OR_COMMENT_RE)) {
    if (!m[2] || m[3] || TAGS_THAT_NEED_NO_CLOSE.has(m[2].toLowerCase())) continue
    if (m[1]) open--
    else if (countOpeners) open++
  }
  return open
}

function rawTagsLeftOpen(token: Token): number {
  if (token.type === 'html_block') return tagsLeftOpen(token.content, true)
  if (token.type !== 'inline') return 0
  return (token.children ?? [])
    .filter((c) => c.type === 'html_inline')
    .reduce((n, c) => n + tagsLeftOpen(c.content, false), 0)
}

function topLevelBlocks(tokens: Token[]): [number, number][] {
  const out: [number, number][] = []
  let start = 0
  let depth = 0
  let rawOpen = 0
  for (let i = 0; i < tokens.length; i++) {
    depth += tokens[i].nesting
    rawOpen = Math.max(0, rawOpen + rawTagsLeftOpen(tokens[i]))
    if (depth !== 0 || rawOpen > 0) continue
    out.push([start, i + 1])
    start = i + 1
  }
  if (start < tokens.length) out.push([start, tokens.length])
  return out
}

export async function renderBlocks(
  text: string,
  opts: { srcPath: string; token: string }
): Promise<RenderedDoc> {
  const env: RenderEnv = {
    srcPath: opts.srcPath,
    koloftToken: opts.token,
    koloftHighlight: new Map()
  }
  if (text.includes('$')) await loadKatex().catch(() => {})
  const tokens = md.parse(text, env)
  await warmHighlight(tokens, env)
  const blocks: string[] = []
  const lines: (SourceLines | null)[] = []
  for (const [from, to] of topLevelBlocks(tokens)) {
    const block = tokens.slice(from, to)
    lines.push(markLinesInBlock(block))
    blocks.push(keepErrorSource(md.renderer.render(block, md.options, env)))
  }
  return { blocks, lines, headings: outline(tokens) }
}

function markLinesInBlock(block: Token[]): SourceLines | null {
  const mapped = block.filter((t) => t.map && t.nesting >= 0 && t.type !== 'inline')
  if (!mapped.length) return null
  let from = Infinity
  let to = 0
  for (const t of mapped) {
    from = Math.min(from, t.map![0])
    to = Math.max(to, t.map![1])
  }
  for (const t of mapped)
    if (t !== block[0]) t.attrSet(LINES_IN_BLOCK_ATTR, `${t.map![0] - from},${t.map![1] - from}`)
  return [from, to]
}
