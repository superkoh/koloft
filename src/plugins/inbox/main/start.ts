import type { PluginStart, StopOnQuit } from '@core/pluginStart'
import { pushChanged, registerChannels } from './channels'
import { INBOX_SENDER, Inbox, type InboxHost } from './inbox'
import { flushInbox, loadInbox, saveInbox } from './inboxFile'
import { registerInboxCommand } from './inboxVerb'
import {
  askFromClaude,
  askFromCodex,
  inboxFooter,
  where,
  KoloftInbox,
  type KoloftInboxDeps
} from './koloftInbox'
import { cardEachTurnAndQuestion } from './sessionHooks'

type SendToSession = InboxHost['sendToSession']

export interface InboxStartDeps {
  cards: Pick<InboxHost, 'now' | 'startSession'> & {
    sendFrom(sender: string, ...rest: Parameters<SendToSession>): ReturnType<SendToSession>
    quitting(): boolean
  }
  koloft: Omit<KoloftInboxDeps, 'inbox' | 'askOf'> & {
    claudeAskOf(tabId: string): Parameters<typeof askFromClaude>[0] | undefined
    pendingAskOf(tabId: string): Promise<Parameters<typeof askFromCodex>[0] | undefined>
  }
  tookTheTurn: Parameters<typeof cardEachTurnAndQuestion>[1]['tookTheTurn']
  toast(text: string): void
}

export const start: PluginStart<
  InboxStartDeps,
  { koloftInbox: KoloftInbox; flushInbox: StopOnQuit }
> = ({ commands, moments, ipc }, d) => {
  const pushInbox = pushChanged(ipc)
  let pushQueued = false
  const inbox: Inbox = new Inbox(
    {
      now: d.cards.now,
      sendToSession: (ref, text, toItsOwnSession) =>
        d.cards.sendFrom(INBOX_SENDER, ref, text, toItsOwnSession),
      answerSession: (ref, given) => koloftInbox.answer(ref, given),
      startSession: d.cards.startSession,
      footer: (card, action) => inboxFooter(card, action.lets),
      changed: () => {
        if (pushQueued) return
        pushQueued = true
        queueMicrotask(() => {
          pushQueued = false
          const now = inbox.snapshot()
          if (!d.cards.quitting()) saveInbox(now)
          pushInbox(now)
        })
      }
    },
    loadInbox()
  )
  const { claudeAskOf, pendingAskOf, ...koloft } = d.koloft
  const koloftInbox = new KoloftInbox({
    ...koloft,
    inbox,
    askOf: async (tabId) => {
      const claude = claudeAskOf(tabId)
      if (claude) return askFromClaude(claude)
      const other = await pendingAskOf(tabId)
      return other && askFromCodex(other)
    }
  })

  cardEachTurnAndQuestion(moments, { inbox: koloftInbox, tookTheTurn: d.tookTheTurn })
  registerInboxCommand(commands, {
    inbox: () => inbox,
    whereOf: (caller) => {
      const s = koloft.sessionOfTab(caller.tabId)
      return s ? where(s) : {}
    }
  })
  registerChannels(ipc, { cards: inbox, sync: () => koloftInbox.sync(), toast: d.toast })
  return { koloftInbox, flushInbox }
}
