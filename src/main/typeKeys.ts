import { sleep } from './codexTransport'

// CC§12 CC§17
const SUBMIT_AFTER_TEXT_MS = 300

// CC§12
export async function typeKeys(write: (data: string) => void, keys: string[]): Promise<void> {
  for (const [i, key] of keys.entries()) {
    if (i > 0) await sleep(SUBMIT_AFTER_TEXT_MS)
    write(key)
  }
}

// CC§17 CODEX§23
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

// CC§17
const CHARS_PER_WRITE_CLAUDE_STILL_TAKES_AS_TYPING = 128

const TYPED_PIECE = new RegExp(`[\\s\\S]{1,${CHARS_PER_WRITE_CLAUDE_STILL_TAKES_AS_TYPING}}`, 'gu')

export function typedPieces(text: string): string[] {
  return text.match(TYPED_PIECE) ?? []
}
