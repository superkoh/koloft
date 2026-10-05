export type CommandOutputKind = 'printed' | 'notice' | 'details'

export interface CommandOutput {
  kind: CommandOutputKind
  text: string
}

const ESC = String.fromCharCode(27)
const TERMINAL_CODES = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g')
const PRINTED = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/

function printed(content: unknown): CommandOutput | null {
  if (typeof content !== 'string') return null
  const text = PRINTED.exec(content)?.[1]?.replace(TERMINAL_CODES, '').trim()
  return text ? { kind: 'printed', text } : null
}

// CC§2
export function claudeWroteIt(record: { origin?: unknown }): boolean {
  return record.origin === undefined
}

// CC§2
export function commandOutputOf(obj: unknown): CommandOutput | null {
  if (!obj || typeof obj !== 'object') return null
  const r = obj as {
    type?: unknown
    subtype?: unknown
    content?: unknown
    isMeta?: unknown
    isSidechain?: unknown
    origin?: unknown
    message?: { content?: unknown }
  }
  if (r.isSidechain === true) return null
  if (r.type === 'system' && r.subtype === 'local_command') return printed(r.content)
  if (r.type === 'system' && r.subtype === 'informational' && typeof r.content === 'string') {
    const text = r.content.trim()
    return text ? { kind: 'notice', text } : null
  }
  const content = r.message?.content
  if (r.type !== 'user' || typeof content !== 'string') return null
  if (r.isMeta !== true || content.startsWith('<') || !claudeWroteIt(r)) return printed(content)
  const text = content.trim()
  return text ? { kind: 'details', text } : null
}
