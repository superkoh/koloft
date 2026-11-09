import { sleep } from './codexTransport'

// CC§12 CC§18 MUSE§17
const SUBMIT_AFTER_TEXT_MS = 300

// CC§12
export async function typeKeys(
  write: (data: string) => void,
  keys: string[],
  stillWanted: () => boolean = () => true
): Promise<boolean> {
  for (const [i, key] of keys.entries()) {
    if (i > 0) await sleep(SUBMIT_AFTER_TEXT_MS)
    if (!stillWanted()) return false
    write(key)
  }
  return true
}

const CONTROLS_THAT_COULD_END_A_PASTE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g

// CC§18 CODEX§23
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(CONTROLS_THAT_COULD_END_A_PASTE, '')}\x1b[201~`
}

// CC§18
const CHARS_PER_WRITE_CLAUDE_STILL_TAKES_AS_TYPING = 128

const TYPED_PIECE = new RegExp(`[\\s\\S]{1,${CHARS_PER_WRITE_CLAUDE_STILL_TAKES_AS_TYPING}}`, 'gu')

export function typedPieces(text: string): string[] {
  return text.match(TYPED_PIECE) ?? []
}

// CC§12 CODEX§25
const MOUSE_AND_FOCUS_REPORTS = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[IO]/g

export function withoutMouseAndFocusReports(data: string): string {
  return data.replace(MOUSE_AND_FOCUS_REPORTS, '')
}

// PLATFORM§21
const ONLY_THE_TERMINALS_OWN_ANSWERS =
  /^(?:\x1b\[[?>]?[\d;]*(?:[Rcntu]|\$y)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/

export function onlyTheTerminalsOwnAnswers(data: string): boolean {
  return ONLY_THE_TERMINALS_OWN_ANSWERS.test(data)
}

export function pressesAKey(data: string): boolean {
  const keys = withoutMouseAndFocusReports(data)
  return keys !== '' && !onlyTheTerminalsOwnAnswers(keys)
}

const A_MOUSE_BUTTON_PRESS = /\x1b\[<[0-2];\d+;\d+M/

export function clicksTheMouse(data: string): boolean {
  return A_MOUSE_BUTTON_PRESS.test(data)
}

// CC§12 CODEX§25
const NAMED_KEYS = new Map([
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
