import type { SearchSnippet } from '@shared/types'

const SNIPPET_SIDE_CHARS = 60

const oneLine = (s: string): string => s.replace(/\s+/g, ' ')

export function anyCase(literal: string): RegExp {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

export function snippetAround(text: string, term: string): SearchSnippet | undefined {
  const found = anyCase(term).exec(text)
  if (!found) return undefined
  const at = found.index
  const start = Math.max(0, at - SNIPPET_SIDE_CHARS)
  const end = Math.min(text.length, at + found[0].length + SNIPPET_SIDE_CHARS)
  return {
    before: (start > 0 ? '…' : '') + oneLine(text.slice(start, at)).trimStart(),
    match: found[0],
    after: oneLine(text.slice(at + found[0].length, end)).trimEnd() + (end < text.length ? '…' : '')
  }
}
