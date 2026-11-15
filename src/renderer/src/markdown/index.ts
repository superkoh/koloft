import DOMPurify, { type Config } from 'dompurify'
import { renderMarkdownOffThread } from '../offThread'
import type { RenderedDoc } from './render'

export type { RenderedDoc }

const SANITIZE: Config & { RETURN_DOM_FRAGMENT: true } = {
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
  FORBID_ATTR: ['srcset', 'poster', 'background', 'action', 'formaction', 'ping', 'lowsrc'],
  RETURN_DOM_FRAGMENT: true
}

const LOCAL_URL = /^(?:koloft-file:|data:)/i
const CSS_URL = /url\(\s*['"]?([^'")]*)/gi

const purify = DOMPurify()

purify.addHook('afterSanitizeAttributes', (node) => {
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

export function cleanBlock(html: string): DocumentFragment {
  return purify.sanitize(html, SANITIZE)
}

let katexStyle: Promise<unknown> | null = null
function loadKatexStyle(): Promise<unknown> {
  return (katexStyle ??= import('katex/dist/katex.min.css').catch(() => (katexStyle = null)))
}

export async function renderMarkdown(ask: {
  text: string
  srcPath: string
  token: string
}): Promise<RenderedDoc> {
  const [doc] = await Promise.all([
    renderMarkdownOffThread(ask),
    ask.text.includes('$') ? loadKatexStyle() : null
  ])
  return doc
}
