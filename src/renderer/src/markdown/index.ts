import MarkdownIt from 'markdown-it'
import type { Env, Token } from 'markdown-it'
import DOMPurify from 'dompurify'
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
  html: string
  token: string
  headings: { id: string; text: string; level: number }[]
  diagrams: { id: string; code: string }[]
  frontMatter: Record<string, string> | null
}

const MAX_HIGHLIGHT_LINES = 2000

const KATEX_OPTIONS: MarkdownKatexOptions & KatexOptions = {
  trust: false,
  strict: 'ignore',
  throwOnError: true,
  output: 'html',
  // PLATFORM§26
  maxSize: 10,
  maxExpand: 1000
}

const BIDI_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

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
  return (katexLoaded ??= Promise.all([
    import('@vscode/markdown-it-katex'),
    import('katex/dist/katex.min.css')
  ])
    .then(([m]) => {
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
        env.koloftHighlight.set(key, await highlightCodeLight(job.code, job.lang))
      } catch {}
    })
  )
}

const SANITIZE: Parameters<typeof DOMPurify.sanitize>[1] = {
  ALLOWED_URI_REGEXP:
    /^(?:koloft-file:|(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  FORBID_TAGS: [
    'style',
    'link',
    'base',
    'meta',
    'iframe',
    'object',
    'embed',
    'video',
    'audio',
    'source',
    'track',
    'form',
    // PLATFORM§24
    'image',
    'feimage'
  ],
  FORBID_ATTR: ['srcset', 'poster', 'background', 'action', 'formaction', 'ping', 'lowsrc']
}

const LOCAL_URL = /^(?:koloft-file:|data:)/i
const CSS_URL = /url\(\s*['"]?([^'")]*)/gi

let hookInstalled = false
function installHook(): void {
  if (hookInstalled) return
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    const src = el.getAttribute?.('src')
    if (src && !LOCAL_URL.test(src)) {
      el.removeAttribute('src')
      el.setAttribute('data-blocked', src)
    }
    const style = el.getAttribute?.('style')
    // PLATFORM§24
    if (style && /url\(|:\/\//i.test(style)) {
      CSS_URL.lastIndex = 0
      let offMachine = !/url\(/i.test(style)
      for (const m of style.matchAll(CSS_URL)) if (!LOCAL_URL.test(m[1] ?? '')) offMachine = true
      if (offMachine) el.removeAttribute('style')
    }
  })
  hookInstalled = true
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

export async function renderMarkdown(
  text: string,
  opts: { srcPath: string }
): Promise<RenderedDoc> {
  const env: RenderEnv = {
    srcPath: opts.srcPath,
    koloftToken: crypto.randomUUID(),
    koloftHighlight: new Map(),
    koloftDiagrams: []
  }
  installHook()
  if (text.includes('$')) await loadKatex().catch(() => {})
  const tokens = md.parse(text, env)
  await warmHighlight(tokens, env)
  const html = md.renderer.render(tokens, md.options, env)
  const fm = env.frontMatter
  return {
    html: DOMPurify.sanitize(keepErrorSource(html), SANITIZE),
    token: env.koloftToken,
    headings: outline(tokens),
    diagrams: env.koloftDiagrams,
    frontMatter: fm && typeof fm === 'object' ? (fm as Record<string, string>) : null
  }
}
