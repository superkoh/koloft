import type { MainIpc } from '@core/ipc'
import { errorText } from '@core/errorText'
import { INBOX_LEVELS, type InboxAnswers, type InboxLevel, type InboxSnapshot } from '@shared/inbox'
import { CHANNELS } from '../shared/channels'

export interface Cards {
  snapshot(): InboxSnapshot
  press(cardId: string, actionId: string, answers: InboxAnswers): void
  confirm(cardId: string): void
  undo(cardId: string): void
  retry(cardId: string): void
  dismiss(cardId: string): void
  moveToTop(cardId: string): void
  setYourLevel(cardId: string, level: InboxLevel | null): void
  clearNotes(): void
}

export interface ChannelDeps {
  cards: Cards
  sync(): void
  toast(text: string): void
}

export function registerChannels(ipc: MainIpc, deps: ChannelDeps): void {
  const { cards } = deps
  ipc.handle(CHANNELS.list, () => {
    deps.sync()
    return cards.snapshot()
  })
  const onCard =
    (act: (cardId: string, ...rest: unknown[]) => void) =>
    (cardId: unknown, ...rest: unknown[]): void => {
      if (typeof cardId !== 'string') return
      try {
        act(cardId, ...rest)
      } catch (error) {
        deps.toast(errorText(error))
      }
    }
  ipc.on(
    CHANNELS.press,
    onCard((id, action, answers) => {
      if (typeof action === 'string' && answers && typeof answers === 'object')
        cards.press(id, action, answers as InboxAnswers)
    })
  )
  ipc.on(
    CHANNELS.confirm,
    onCard((id) => cards.confirm(id))
  )
  ipc.on(
    CHANNELS.undo,
    onCard((id) => cards.undo(id))
  )
  ipc.on(
    CHANNELS.retry,
    onCard((id) => cards.retry(id))
  )
  ipc.on(
    CHANNELS.dismiss,
    onCard((id) => cards.dismiss(id))
  )
  ipc.on(
    CHANNELS.top,
    onCard((id) => cards.moveToTop(id))
  )
  ipc.on(
    CHANNELS.level,
    onCard((id, level) => {
      if (level === null || INBOX_LEVELS.includes(level as InboxLevel))
        cards.setYourLevel(id, level as InboxLevel | null)
    })
  )
  ipc.on(CHANNELS.clearNotes, () => cards.clearNotes())
}

export const pushChanged =
  (ipc: MainIpc) =>
  (snapshot: InboxSnapshot): void =>
    ipc.push(CHANNELS.changed, snapshot)
