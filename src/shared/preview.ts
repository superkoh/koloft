import type { PreviewKind } from './types'

const EXT_MAP: Record<string, PreviewKind> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.pdf': 'pdf'
}

export function extOf(p: string): string {
  const i = p.lastIndexOf('.')
  if (i < 0) return ''
  return p.slice(i).toLowerCase()
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** `basename`'s twin, on the same string-only footing (the renderer has no `path`).
 *  Returns '' when there is no parent left, which is the terminator FR-27's
 *  grow-the-prefix-until-distinct loop reads as "this path has run out of parents". */
export function dirname(p: string): string {
  const i = p.replace(/[\\/]+$/, '').search(/[\\/][^\\/]*$/)
  if (i < 0) return ''
  return i === 0 ? '/' : p.slice(0, i)
}

export function previewKindForPath(p: string): PreviewKind | null {
  return EXT_MAP[extOf(p)] ?? null
}

/** every extension the preview pane can render */
export const PREVIEW_EXTENSIONS: readonly string[] = Object.keys(EXT_MAP)

/** D6: a page renders in the Browser, never in Preview — the one extension group that
 *  left EXT_MAP without leaving Koloft. */
const WEB_PAGE_EXTENSIONS = ['.html', '.htm']

export function isWebPagePath(p: string): boolean {
  return WEB_PAGE_EXTENSIONS.includes(extOf(p))
}

/** every extension Koloft shows somewhere in-app, Preview's kinds plus the Browser's
 *  pages (source of truth for the `open` shim's intercept filter — keeps the bash glob
 *  list from drifting). The tree's Preview filter reads the same two groups: a `.html`
 *  is still viewable content to the user, it just lands in the other surface. */
export const VIEWABLE_EXTENSIONS: readonly string[] = [
  ...PREVIEW_EXTENSIONS,
  ...WEB_PAGE_EXTENSIONS
]
