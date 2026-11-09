export const TO_LINE_START = '\x01'
export const TO_LINE_END = '\x05'
export const CLEAR_TO_LINE_START = '\x15'

// CC§12 CODEX§25 MUSE§17 AGY§15 PLATFORM§2 PLATFORM§7
const COMMAND_KEY_LINE_EDITS = new Map([
  ['ArrowLeft', TO_LINE_START],
  ['ArrowRight', TO_LINE_END],
  ['Backspace', CLEAR_TO_LINE_START]
])

type KeyPress = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export function commandKeyLineEdit(e: KeyPress): string | undefined {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return undefined
  return COMMAND_KEY_LINE_EDITS.get(e.key)
}
