import fs from 'fs'
import readline from 'readline'
import type { SearchSnippet } from '@shared/types'
import { mapAtMost } from '@core/mapAtMost'
import { anyCase, snippetAround } from '@core/snippetAround'
import { messageText } from './messageText'

export interface TranscriptFile {
  id: string
  file: string
}

const TRANSCRIPTS_SEARCHED_AT_ONCE = 8

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
