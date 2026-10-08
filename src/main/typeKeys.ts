import { sleep } from './codexTransport'

// CC§12
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
