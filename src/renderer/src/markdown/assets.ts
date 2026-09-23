import type { MarkdownIt } from 'markdown-it'
import { escapeHtml as esc } from './escape'

/**
 * FR-12: `![](./a.png)` is broken today because the preview never rewrites the src to the
 * `koloft-file://` protocol that can actually read a workspace file.
 *
 * FR-12b: an `http(s)` image is never fetched. This is not a display decision — fetching it
 * would tell that server which document is open right now, which is exactly what NFR-02's
 * "zero network requests" exists to prevent. It becomes a placeholder that still reads out
 * the address, so the document doesn't look like it lost a picture.
 *
 * `srcPath` (the document's own path) arrives on `env`, not as a plugin option: one parser
 * instance renders every document, so anything document-specific has to travel per render.
 */

/** Same normalization as `previewLinkTarget`: a preview link and a preview image have to
 *  resolve identically, or a doc's `[a](./x)` and `![](./x)` would point at different files. */
export function resolveAssetPath(src: string, fromSrc: string): string {
  const base = src.startsWith('/') ? '' : fromSrc.slice(0, fromSrc.lastIndexOf('/'))
  const out: string[] = []
  for (const seg of `${base}/${src.split(/[?#]/)[0]}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

/** Mirrors `window.api.preview.fileUrl` (preload). Not imported: preload is a different
 *  process boundary and pulling it into the renderer's render path would drag in ipcRenderer. */
function fileUrl(p: string): string {
  return `koloft-file://localhost${encodeURI(p)}`
}

/** markdown-it percent-encodes every link destination as it parses (`设计.png` arrives as
 *  `%E8%AE%BE...`), so the raw path has to come back before it is resolved and re-encoded —
 *  otherwise every non-ASCII or spaced file name is double-encoded into a 404. */
function rawPath(src: string): string {
  try {
    return decodeURI(src)
  } catch {
    return src
  }
}

/** Anything that leaves this machine. `//host/x.png` is protocol-relative, i.e. network. */
function isRemote(src: string): boolean {
  return /^(?:https?:)?\/\//i.test(src)
}

/** A `data:` image carries its own bytes — no request, so nothing to block. */
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
      const path = rawPath(src)
      token.attrSet('src', fileUrl(resolveAssetPath(path, srcPath)))
      // the path as written, for the placeholder the UI puts up when the image cannot be
      // loaded (Edge Cases #4)
      token.attrSet('data-path', path)
    }

    return base ? base(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
  }
}
