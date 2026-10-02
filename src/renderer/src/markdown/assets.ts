import type { MarkdownIt } from 'markdown-it'
import { resolveOnHost } from '@shared/remoteKey'
import { escapeHtml as esc } from './escape'

function fileUrl(p: string): string {
  return `koloft-file://localhost${encodeURI(p)}`
}

function undoMarkdownItPercentEncoding(src: string): string {
  try {
    return decodeURI(src)
  } catch {
    return src
  }
}

function isRemote(src: string): boolean {
  return /^(?:https?:)?\/\//i.test(src)
}

function isInline(src: string): boolean {
  return /^data:/i.test(src)
}

export function assets(md: MarkdownIt): void {
  const base = md.renderer.rules.image

  md.renderer.rules.image = (tokens, idx, options, env, self): string => {
    const token = tokens[idx]
    const src = String(token.attrGet('src') ?? '')

    if (isRemote(src)) {
      const alt = self.renderInlineAsText(token.children ?? [], options, env)
      const label = alt ? `${esc(alt)} — ` : ''
      return `<span class="md-img-blocked" data-src="${esc(src)}">${label}external image blocked: ${esc(src)}</span>`
    }

    if (!isInline(src)) {
      const srcPath = typeof env?.srcPath === 'string' ? env.srcPath : ''
      const path = undoMarkdownItPercentEncoding(src)
      token.attrSet('src', fileUrl(resolveOnHost(srcPath, path)))
      token.attrSet('data-path', path)
    }

    return base ? base(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
  }
}
