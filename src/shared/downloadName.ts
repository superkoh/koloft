import { basename } from './preview'

/**
 * SEC-9: what a download is allowed to be called on disk. Chromium hands over the
 * server's suggested name verbatim, so joining it onto the download dir would let
 * `../../evil.sh` write outside that dir — only the basename ever survives.
 */
export function safeDownloadName(suggested: string): string {
  const name = basename(suggested.replace(/\p{Cc}/gu, '').replace(/[\\/]+$/, '')).trim()
  if (!name || name === '.' || name === '..') return 'download'
  return name
}

const EXTENDED_FILENAME = /;\s*filename\*\s*=\s*([^;]+)/i
const PLAIN_FILENAME = /;\s*filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/i

/**
 * SEC-9: the name the site asked for, as it was written in `Content-Disposition`.
 * Chromium hands `getFilename()` over already flattened — `../../evil.sh` arrives as
 * `_.._evil.sh`, which HIDES the traversal from the basename rule instead of answering
 * it — so the header is read first and Chromium's name is the fallback for a response
 * that suggested none.
 */
export function suggestedDownloadName(contentDisposition: string, fallback: string): string {
  const extended = EXTENDED_FILENAME.exec(contentDisposition)
  if (extended) {
    // RFC 5987: charset'language'percent-encoded-value
    const parts = extended[1].trim().split("'")
    try {
      const decoded = decodeURIComponent(parts.length >= 3 ? parts.slice(2).join("'") : parts[0])
      if (decoded.trim()) return decoded
    } catch {
      /* a value that is not percent-encoding is not a name — try the plain parameter */
    }
  }
  const plain = PLAIN_FILENAME.exec(contentDisposition)
  if (plain) {
    const raw = plain[1].trim()
    const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw
    if (value.trim()) return value
  }
  return fallback
}

/**
 * SEC-9: the second half — a same-named file is never silently overwritten. `taken`
 * answers for the target directory (`fs.existsSync` in main), and the counter goes
 * before the extension so `report.pdf` stays a pdf.
 */
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
