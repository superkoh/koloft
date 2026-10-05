export type CommandOutputKind = 'printed' | 'notice' | 'details'

export interface CommandOutput {
  kind: CommandOutputKind
  text: string
}

const ESC = String.fromCharCode(27)
const TERMINAL_CODES = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g')
const PRINTED = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/

function printed(content: unknown): string | null {
  if (typeof content !== 'string') return null
  const inner = PRINTED.exec(content)?.[1]
  return inner === undefined ? null : inner.replace(TERMINAL_CODES, '').trim()
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
    message?: { content?: unknown }
  }
  if (r.isSidechain === true) return null
  let found: CommandOutput | null = null
  if (r.type === 'system' && r.subtype === 'local_command') {
    const text = printed(r.content)
    if (text) found = { kind: 'printed', text }
  } else if (
    r.type === 'system' &&
    r.subtype === 'informational' &&
    typeof r.content === 'string'
  ) {
    found = { kind: 'notice', text: r.content.trim() }
  } else if (r.type === 'user' && typeof r.message?.content === 'string') {
    const content = r.message.content
    const text = printed(content)
    if (text) found = { kind: 'printed', text }
    else if (r.isMeta === true && !content.startsWith('<'))
      found = { kind: 'details', text: content.trim() }
  }
  return found?.text ? found : null
}
