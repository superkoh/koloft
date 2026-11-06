import type { Terminal } from '@xterm/xterm'

interface Shown {
  term: Terminal
  sizedToPane: boolean
}

const shown = new Map<string, Shown>()
let answering = false

function screenLines(term: Terminal): string[] {
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

function lastWrittenLines(term: Terminal, count: number): string[] {
  const buffer = term.buffer.active
  const text = (y: number): string => buffer.getLine(y)?.translateToString(true) ?? ''
  let end = buffer.length
  while (end > 0 && !text(end - 1)) end--
  const lines: string[] = []
  for (let y = Math.max(0, end - count); y < end; y++) lines.push(text(y))
  return lines
}

export function lastLinesOnceWritten(id: string, count: number): Promise<string[]> {
  const term = shown.get(id)?.term
  if (!term) return Promise.resolve([])
  return new Promise((resolve) => term.write('', () => resolve(lastWrittenLines(term, count))))
}

export function writeOnScreen(id: string, text: string): void {
  shown.get(id)?.term.write(text)
}

export function screenSizedToPane(id: string): void {
  const s = shown.get(id)
  if (s) s.sizedToPane = true
}
