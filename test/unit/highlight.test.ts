import { describe, it, expect } from 'vitest'
import { highlightCode, highlightLines } from '../../src/renderer/src/highlight'

const HOSTILE_FILE = [
  '<script>window.pwned = 1</script>',
  '<img src=x onerror="window.pwned = 2">',
  'const s = "</span><b>bold</b>"'
].join('\n')

const TAGS_THE_HIGHLIGHTER_ITSELF_WRITES = new Set(['pre', 'code', 'span'])

function tagsIn(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase())
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

describe('highlighted HTML is safe to inject with dangerouslySetInnerHTML (ChangesView Source view, InlineDiff)', () => {
  it.each(['html', 'typescript', 'text'])(
    'highlightCode HTML-escapes file content, so a file holding <script> or <img onerror> renders as text (%s)',
    async (lang) => {
      const html = await highlightCode(HOSTILE_FILE, lang)
      expect(tagsIn(html).filter((t) => !TAGS_THE_HIGHLIGHTER_ITSELF_WRITES.has(t))).toEqual([])
      expect(textOf(html).replace(/\n$/, '')).toBe(HOSTILE_FILE)
    },
    30_000
  )

  it.each(['html', 'typescript', 'text'])(
    'highlightLines HTML-escapes file content, so a file holding <script> or <img onerror> renders as text (%s)',
    async (lang) => {
      const lines = await highlightLines(HOSTILE_FILE, lang)
      for (const line of lines) {
        expect(tagsIn(line).filter((t) => t !== 'span')).toEqual([])
      }
      expect(lines.map(textOf)).toEqual(HOSTILE_FILE.split('\n'))
    },
    30_000
  )
})
