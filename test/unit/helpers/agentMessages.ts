import type { BackendId } from '@shared/types'
import type {
  SentNote,
  SessionBackends,
  SessionMessages
} from '../../../src/core/agent/sessionBackends'
import { claudeMessages } from '../../../src/agents/claude/main/messageSocket'
import { codexMessages } from '../../../src/agents/codex/main/codexMessages'
import { agyMessages } from '../../../src/agents/agy/main/agyMessages'

export interface WhatEachAgentSendsThrough {
  sendLine(tabId: string, line: string, ms: number): Promise<void>
  queue(tabId: string, text: string, clientId: string): Promise<void>
  throughItsApi(tabId: string, text: string): Promise<boolean>
  noteKoloftSent(tabId: string, note: SentNote): Promise<void>
}

export function everyAgentsMessages(
  through: WhatEachAgentSendsThrough
): Pick<SessionBackends, 'send' | 'mightNotTakeAMessageNow'> {
  const { noteKoloftSent } = through
  const of: Record<BackendId, SessionMessages> = {
    claude: claudeMessages({ sendPeerLine: through.sendLine, noteKoloftSent }),
    codex: codexMessages({ queue: through.queue, noteKoloftSent }),
    agy: agyMessages(through.throughItsApi)
  }
  return {
    send: (backend, tabId, m) => of[backend].send(tabId, m),
    mightNotTakeAMessageNow: (backend, tabId, turnHasEnded) =>
      of[backend].mightNotTakeAMessageNow(tabId, turnHasEnded)
  }
}
