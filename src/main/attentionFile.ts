import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { ATTENTION_REASON, type AttentionEvent } from '@shared/types'
import type { SavedMark } from './attention'
import { BackgroundFile } from './backgroundFile'

function attentionFile(): string {
  return path.join(app.getPath('userData'), 'attention.json')
}

export function loadLastRunAttention(): SavedMark[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(attentionFile(), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (e): e is SavedMark =>
        typeof e?.tabId === 'string' &&
        typeof e.sessionId === 'string' &&
        Object.hasOwn(ATTENTION_REASON, e.kind)
    )
  } catch {
    return []
  }
}

const attentionOnDisk = new BackgroundFile(attentionFile)

export function saveAttention(pending: AttentionEvent[]): void {
  attentionOnDisk.write(JSON.stringify(pending))
}

export function flushAttention(): void {
  attentionOnDisk.flushSync()
}
