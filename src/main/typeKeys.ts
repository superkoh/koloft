import { sleep } from './codexTransport'

// CC§12 CC§18
const SUBMIT_AFTER_TEXT_MS = 300

// CC§12
export async function typeKeys(write: (data: string) => void, keys: string[]): Promise<void> {
  for (const [i, key] of keys.entries()) {
    if (i > 0) await sleep(SUBMIT_AFTER_TEXT_MS)
    write(key)
  }
}

// CC§18 CODEX§23
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

// CC§18
const CHARS_PER_WRITE_CLAUDE_STILL_TAKES_AS_TYPING = 128

const TYPED_PIECE = new RegExp(`[\\s\\S]{1,${CHARS_PER_WRITE_CLAUDE_STILL_TAKES_AS_TYPING}}`, 'gu')

export function typedPieces(text: string): string[] {
  return text.match(TYPED_PIECE) ?? []
}

// CC§12 CODEX§24
export const NAMED_KEYS = new Map([
  ['enter', '\r'],
  ['esc', '\x1b'],
  ['tab', '\t'],
  ['shift-tab', '\x1b[Z'],
  ['up', '\x1b[A'],
  ['down', '\x1b[B'],
  ['right', '\x1b[C'],
  ['left', '\x1b[D'],
  ['space', ' '],
  ['backspace', '\x7f']
])

export function keysFor(words: string[]): string[] {
  return words.flatMap((word) => {
    const key = NAMED_KEYS.get(word.toLowerCase())
    return key === undefined ? typedPieces(word) : [key]
  })
}
