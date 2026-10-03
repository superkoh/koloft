export const DISCORD_MESSAGE_LIMIT = 2000

const CLOSE_FENCE = '\n```'

function isFence(line: string): boolean {
  return line.trimStart().startsWith('```')
}

function endsMidPair(text: string, cut: number): boolean {
  const code = text.charCodeAt(cut - 1)
  return code >= 0xd800 && code <= 0xdbff
}

// PLATFORM§39
export function splitForDiscord(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const out: string[] = []
  let body = ''
  let opener: string | null = null
  const hasWords = (): boolean => !!body.trim() && body !== opener
  const flush = (): void => {
    if (hasWords()) out.push(opener ? body + CLOSE_FENCE : body)
    body = opener ?? ''
  }
  for (const line of text.split('\n')) {
    let rest = line
    for (;;) {
      const next = body ? `${body}\n${rest}` : rest
      const after: string | null = isFence(rest) ? (opener ? null : rest.trim()) : opener
      if (next.length + (after ? CLOSE_FENCE.length : 0) <= limit) {
        body = next
        opener = after
        break
      }
      if (hasWords()) {
        flush()
        continue
      }
      const room = limit - (body ? body.length + 1 : 0) - (opener ? CLOSE_FENCE.length : 0)
      const cut = endsMidPair(rest, room) ? room - 1 : room
      body = body ? `${body}\n${rest.slice(0, cut)}` : rest.slice(0, cut)
      rest = rest.slice(cut)
      flush()
    }
  }
  if (hasWords()) out.push(body)
  return out
}
