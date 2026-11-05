import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { InboxSnapshot } from '@shared/inbox'
import { BackgroundFile } from './backgroundFile'

function inboxFile(): string {
  return path.join(app.getPath('userData'), 'inbox.json')
}

export function loadInbox(): InboxSnapshot | null {
  try {
    const raw = JSON.parse(fs.readFileSync(inboxFile(), 'utf8')) as Partial<InboxSnapshot>
    if (!Array.isArray(raw.cards)) return null
    return {
      cards: raw.cards.filter(
        (c) =>
          typeof c?.id === 'string' && typeof c.source === 'string' && typeof c.key === 'string'
      ),
      ready: []
    }
  } catch {
    return null
  }
}

const inboxOnDisk = new BackgroundFile(inboxFile)

export function saveInbox(snapshot: InboxSnapshot): void {
  inboxOnDisk.write(JSON.stringify({ cards: snapshot.cards }))
}

export function flushInbox(): void {
  inboxOnDisk.flushSync()
}
