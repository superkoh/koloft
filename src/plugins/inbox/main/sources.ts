import type { InboxCardInput, InboxTarget } from '@shared/inbox'
import type { Inbox } from '../../../main/inbox'

export interface InboxSource {
  add(card: InboxCardInput): { id: string; created: boolean; warnings: string[] }
  update(key: string, patch: Partial<InboxCardInput>): { warnings: string[] }
  move(key: string, to: InboxTarget, why?: string): void
}

export interface InboxSources {
  register(source: { id: string; name: string }): InboxSource
}

export function inboxSources(
  inbox: Pick<Inbox, 'register' | 'add' | 'update' | 'move'>
): InboxSources {
  return {
    register: (source) => {
      inbox.register(source)
      const as = { source: source.id }
      return {
        add: (card) => inbox.add(as, card),
        update: (key, patch) => inbox.update(as, key, patch),
        move: (key, to, why) => inbox.move(as, key, to, why)
      }
    }
  }
}
