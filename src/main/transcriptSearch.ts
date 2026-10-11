import fs from 'fs'
import readline from 'readline'
import type { SearchSnippet } from '@shared/types'
import { mapAtMost } from './mapAtMost'
import { messageText } from './messageText'

export interface TranscriptFile {
  id: string
  file: string
}

const SNIPPET_SIDE_CHARS = 60
const TRANSCRIPTS_SEARCHED_AT_ONCE = 8

const oneLine = (s: string): string => s.replace(/\s+/g, ' ')

function anyCase(literal: string): RegExp {
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

// CC§2
function spokenText(line: string): string | null {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }
  if (!record || typeof record !== 'object') return null
  const r = record as { type?: unknown; isMeta?: unknown; message?: { content?: unknown } }
  if ((r.type !== 'user' && r.type !== 'assistant') || r.isMeta === true) return null
  return messageText(r.message?.content)
}

export async function searchTranscript(file: string, term: string): Promise<SearchSnippet | null> {
  const inRawLine = anyCase(JSON.stringify(term).slice(1, -1))
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!inRawLine.test(line)) continue
      const text = spokenText(line)
      const hit = text && snippetAround(text, term)
      if (hit) return hit
    }
    return null
  } catch {
    return null
  } finally {
    lines.close()
    stream.destroy()
  }
}

export async function searchTranscripts(
  files: TranscriptFile[],
  term: string,
  found: (id: string, snippet: SearchSnippet) => void
): Promise<void> {
  await mapAtMost(files, TRANSCRIPTS_SEARCHED_AT_ONCE, async ({ id, file }) => {
    const hit = await searchTranscript(file, term)
    if (hit) found(id, hit)
  })
}
