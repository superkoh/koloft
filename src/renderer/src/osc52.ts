import type { Terminal } from '@xterm/xterm'

const OSC_SET_CLIPBOARD = 52
const CLIPBOARD_READ_REQUEST = '?'
const CLIPBOARD_TARGET = 'c'
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true })

function clipboardTextOfOsc52(data: string): string {
  const split = data.indexOf(';')
  if (split < 0) return ''
  const targets = data.slice(0, split)
  if (targets && !targets.includes(CLIPBOARD_TARGET)) return ''
  const payload = data.slice(split + 1)
  if (payload === CLIPBOARD_READ_REQUEST) return ''
  try {
    return STRICT_UTF8.decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))
  } catch {
    return ''
  }
}

// PLATFORM§21 PLATFORM§35 CC§12 CODEX§16 MUSE§17 AGY§7
export function copyOsc52ToClipboard(term: Terminal, write: (text: string) => void): void {
  term.parser.registerOscHandler(OSC_SET_CLIPBOARD, (data) => {
    const text = clipboardTextOfOsc52(data)
    if (text) write(text)
    return true
  })
}
