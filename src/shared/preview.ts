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

export function dirname(p: string): string {
  const i = p.replace(/[\\/]+$/, '').search(/[\\/][^\\/]*$/)
  if (i < 0) return ''
  return i === 0 ? '/' : p.slice(0, i)
}

export function previewKindForPath(p: string): PreviewKind | null {
  return EXT_MAP[extOf(p)] ?? null
}

export const PREVIEW_EXTENSIONS: readonly string[] = Object.keys(EXT_MAP)

const WEB_PAGE_EXTENSIONS = ['.html', '.htm']

export function isWebPagePath(p: string): boolean {
  return WEB_PAGE_EXTENSIONS.includes(extOf(p))
}

export function isReaderDocPath(p: string): boolean {
  return previewKindForPath(p) === 'markdown' || isWebPagePath(p)
}

// CC§2 CC§9
const AGENT_ONLY_PATHS = [
  /\/(CLAUDE|AGENTS|SKILL)\.md$/,
  /\/\.claude\/projects\/[^/]+\/memory\//,
  /\/\.claude\/(skills|agents|commands)\//,
  /\/skills\/[^/]+\/references\//
]

export function writtenForTheAgent(src: string): boolean {
  return AGENT_ONLY_PATHS.some((p) => p.test(src))
}

export type ReadErrorState = 'missing' | 'tooLarge' | 'binary' | 'error'

export function stateAfterReadError(message: string, firstRead: boolean): ReadErrorState | null {
  if (message.includes('KOLOFT_READ_FAILED') || message.includes('KOLOFT_NOT_FILE'))
    return 'missing'
  if (message.includes('KOLOFT_TOO_LARGE')) return 'tooLarge'
  if (message.includes('KOLOFT_BINARY')) return 'binary'
  return firstRead ? 'error' : null
}

export const VIEWABLE_EXTENSIONS: readonly string[] = [
  ...PREVIEW_EXTENSIONS,
  ...WEB_PAGE_EXTENSIONS
]
