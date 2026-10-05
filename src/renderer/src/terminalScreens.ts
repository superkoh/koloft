import type { Terminal } from '@xterm/xterm'

interface Shown {
  term: Terminal
  sizedToPane: boolean
}

const shown = new Map<string, Shown>()
let answering = false

export function screenLines(term: Terminal): string[] {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = buffer.baseY; y < buffer.baseY + term.rows; y++)
    lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
  return lines
}

function answerScreenRequests(): void {
  if (answering) return
  answering = true
  window.api.terminal.onScreenRequest(({ requestId, tabId }) => {
    const s = shown.get(tabId)
    window.api.terminal.answerScreen({
      requestId,
      lines: s ? screenLines(s.term) : null,
      sizedToPane: s?.sizedToPane ?? false
    })
  })
}

export function registerScreen(id: string, term: Terminal): () => void {
  answerScreenRequests()
  shown.set(id, { term, sizedToPane: false })
  return () => {
    if (shown.get(id)?.term === term) shown.delete(id)
  }
}

export function screenSizedToPane(id: string): void {
  const s = shown.get(id)
  if (s) s.sizedToPane = true
}
