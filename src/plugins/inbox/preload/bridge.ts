import type { PreloadIpc } from '@core/ipc'
import type { InboxAnswers, InboxLevel, InboxSnapshot } from '@shared/inbox'
import { CHANNELS } from '../shared/channels'

export interface InboxBridge {
  inbox: {
    list(): Promise<InboxSnapshot>
    onChanged(cb: (snapshot: InboxSnapshot) => void): () => void
    press(cardId: string, actionId: string, answers: InboxAnswers): void
    confirm(cardId: string): void
    undo(cardId: string): void
    retry(cardId: string): void
    dismiss(cardId: string): void
    level(cardId: string, level: InboxLevel | null): void
    top(cardId: string): void
    clearNotes(): void
  }
}

export const bridge = (ipc: PreloadIpc): InboxBridge => ({
  inbox: {
    list: () => ipc.invoke(CHANNELS.list),
    onChanged: (cb) => ipc.listen(CHANNELS.changed, cb),
    press: (cardId, actionId, answers) => ipc.send(CHANNELS.press, cardId, actionId, answers),
    confirm: (cardId) => ipc.send(CHANNELS.confirm, cardId),
    undo: (cardId) => ipc.send(CHANNELS.undo, cardId),
    retry: (cardId) => ipc.send(CHANNELS.retry, cardId),
    dismiss: (cardId) => ipc.send(CHANNELS.dismiss, cardId),
    level: (cardId, level) => ipc.send(CHANNELS.level, cardId, level),
    top: (cardId) => ipc.send(CHANNELS.top, cardId),
    clearNotes: () => ipc.send(CHANNELS.clearNotes)
  }
})
