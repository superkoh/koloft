import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { ATTENTION_REASON, type AttentionEvent } from '@shared/types'

function attentionFile(): string {
  return path.join(app.getPath('userData'), 'attention.json')
}

export function loadLastRunAttention(): AttentionEvent[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(attentionFile(), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (e): e is AttentionEvent =>
        typeof e?.tabId === 'string' &&
        typeof e.sessionId === 'string' &&
        Object.hasOwn(ATTENTION_REASON, e.kind)
    )
  } catch {
    return []
  }
}

export function saveAttention(pending: AttentionEvent[]): void {
  try {
    fs.writeFileSync(attentionFile(), JSON.stringify(pending.filter((e) => e.sessionId)))
  } catch {}
}
