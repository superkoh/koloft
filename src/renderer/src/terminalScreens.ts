import type { Terminal } from '@xterm/xterm'

interface Shown {
  term: Terminal
  sizedToPane: boolean
}

const shown = new Map<string, Shown>()
const awaitingAScreen = new Map<string, ((term: Terminal) => void)[]>()
let answering = false

function screenOnceShown(id: string): Promise<Terminal> {
  const term = shown.get(id)?.term
  if (term) return Promise.resolve(term)
  return new Promise((resolve) => {
    const waiting = awaitingAScreen.get(id)
    if (waiting) waiting.push(resolve)
    else awaitingAScreen.set(id, [resolve])
  })
}

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
  for (const resolve of awaitingAScreen.get(id) ?? []) resolve(term)
  awaitingAScreen.delete(id)
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

export async function lastLinesOnceWritten(id: string, count: number): Promise<string[]> {
  const term = await screenOnceShown(id)
  return new Promise((resolve) => term.write('', () => resolve(lastWrittenLines(term, count))))
}

export function writeOnScreen(id: string, text: string): void {
  shown.get(id)?.term.write(text)
}

export function screenSizedToPane(id: string): void {
  const s = shown.get(id)
  if (s) s.sizedToPane = true
}
