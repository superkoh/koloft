import type { Terminal } from '@xterm/xterm'

const OSC_SET_CLIPBOARD = 52
const CLIPBOARD_READ_REQUEST = '?'

function clipboardTextOfOsc52(data: string): string | null {
  const split = data.indexOf(';')
  if (split < 0) return null
  const payload = data.slice(split + 1)
  if (!payload || payload === CLIPBOARD_READ_REQUEST) return null
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes) || null
  } catch {
    return null
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
