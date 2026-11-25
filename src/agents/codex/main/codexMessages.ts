import type { SentNote, SessionMessages } from '@core/agent/sessionBackends'

export interface CodexMessageDeps {
  queue(tabId: string, text: string, clientId: string): Promise<void>
  noteKoloftSent(tabId: string, note: SentNote): Promise<void>
}

export function codexMessages(d: CodexMessageDeps): SessionMessages {
  let queued = 0
  return {
    send: async (tabId, m) => {
      // ADR-0028 CODEX§33
      if (m.koloftWroteTheOpening) await d.noteKoloftSent(tabId, { words: m.text })
      // CODEX§17
      await d.queue(
        tabId,
        m.text,
        'handedOverAs' in m ? m.handedOverAs : `koloft-conductor-${++queued}`
      )
      return 'taken'
    },
    mightNotTakeAMessageNow: async () => false
  }
}
