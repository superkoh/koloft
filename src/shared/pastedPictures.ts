export interface PastedPicture {
  path: string
  shown: string
}

export const PASTED_PICTURE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

const PICTURE_LINE = 'Picture: '

// CC§18 CODEX§23 AGY§13
export function withPictures(words: string, paths: readonly string[]): string {
  const lines = paths.map((p) => PICTURE_LINE + p).join('\n')
  return [words, lines].filter(Boolean).join('\n\n')
}

export function pastedPicturesIn(text: string, dir: string): string[] {
  const inDir = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const extensions = Object.values(PASTED_PICTURE_EXTENSIONS).join('|')
  const file = new RegExp(`${inDir}/[0-9a-f-]{36}\\.(?:${extensions})`, 'g')
  return [...new Set(text.match(file) ?? [])]
}
