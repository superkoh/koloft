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
import { escapeHtml as esc } from '@shared/escapeHtml'

export interface RenderedDoc {
  blocks: string[]
  headings: { id: string; text: string; level: number }[]
  diagrams: { id: string; code: string }[]
  frontMatter: Record<string, string> | null
}

const MAX_HIGHLIGHT_LINES = 2000
const COLORED_FENCES_KEPT = 500

const KATEX_OPTIONS: MarkdownKatexOptions & KatexOptions = {
  trust: false,
  strict: 'ignore',
  throwOnError: true,
  output: 'html',
  // PLATFORM§26
  maxSize: 10,
  maxExpand: 1000
}

const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/g

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
  koloftDiagrams: { id: string; code: string }[]
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
    const id = `mmd-${env.koloftDiagrams.length}`
    env.koloftDiagrams.push({ id, code })
    return `<div class="mmd" data-k="${env.koloftToken}" data-id="${id}" data-code="${payload(code)}"></div>\n`
  }

  const highlighted = env.koloftHighlight?.get(cacheKey(label, code)) ?? plainCode(code)
  return (
    `<div class="md-code"><span class="md-code-lang">${esc(label)}</span>` +
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
    .filter((c) => c.type === 'text' || c.type === 'code_inline' || c.type === 'html_inline')
    .map((c) => (c.type === 'html_inline' ? c.content.replace(/<[^>]*>/g, '') : c.content))
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

function keepColored(key: string, html: string): void {
  colored.delete(key)
  colored.set(key, html)
  if (colored.size > COLORED_FENCES_KEPT) colored.delete(colored.keys().next().value!)
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
      const done = colored.get(key)
      if (done !== undefined) {
        keepColored(key, done)
        env.koloftHighlight.set(key, done)
        return
      }
      try {
        const html = await highlightCodeLight(job.code, job.lang)
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

function topLevelBlocks(tokens: Token[]): [number, number][] {
  const firstRaw = tokens.findIndex((t) => t.type === 'html_block')
  const lastRaw = tokens.findLastIndex((t) => t.type === 'html_block')
  const out: [number, number][] = []
  let start = 0
  for (let i = 0; i < tokens.length; i++) {
    const ends = tokens[i].level === 0 && tokens[i].nesting <= 0
    const rawHtmlMayStillBeOpen = i >= firstRaw && i < lastRaw
    if (!ends || rawHtmlMayStillBeOpen) continue
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
    koloftHighlight: new Map(),
    koloftDiagrams: []
  }
  if (text.includes('$')) await loadKatex().catch(() => {})
  const tokens = md.parse(text, env)
  await warmHighlight(tokens, env)
  const blocks = topLevelBlocks(tokens).map(([from, to]) =>
    keepErrorSource(md.renderer.render(tokens.slice(from, to), md.options, env))
  )
  const fm = env.frontMatter
  return {
    blocks,
    headings: outline(tokens),
    diagrams: env.koloftDiagrams,
    frontMatter: fm && typeof fm === 'object' ? (fm as Record<string, string>) : null
  }
}
