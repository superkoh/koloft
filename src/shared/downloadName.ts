import { basename } from './preview'

export function safeDownloadName(suggested: string): string {
  const name = basename(suggested.replace(/\p{Cc}/gu, '').replace(/[\\/]+$/, '')).trim()
  if (!name || name === '.' || name === '..') return 'download'
  return name
}

const EXTENDED_FILENAME = /;\s*filename\*\s*=\s*([^;]+)/i
const PLAIN_FILENAME = /;\s*filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/i

// PLATFORM§13
export function suggestedDownloadName(contentDisposition: string, fallback: string): string {
  const extended = EXTENDED_FILENAME.exec(contentDisposition)
  if (extended) {
    const parts = extended[1].trim().split("'")
    try {
      const decoded = decodeURIComponent(parts.length >= 3 ? parts.slice(2).join("'") : parts[0])
      if (decoded.trim()) return decoded
    } catch {}
  }
  const plain = PLAIN_FILENAME.exec(contentDisposition)
  if (plain) {
    const raw = plain[1].trim()
    const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw
    if (value.trim()) return value
  }
  return fallback
}

export function uniqueDownloadName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
}
