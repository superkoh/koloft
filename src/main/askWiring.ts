import type { AskPayload } from '@shared/sessionEvent'
import { sleep } from '@core/sleep'
import type { SessionRuntime } from '@core/agent/sessionRuntime'
import {
  claudeDialog,
  codexDialog,
  isAskedCall,
  questionsOf,
  type CodexApproval,
  type CodexQuestion,
  type DialogView
} from '@plugins/sessions/main/dialog'
import type { SessionAsks } from '@plugins/sessions/main/sessionAsks'
import { claudeAskLine, storedAskLine } from './rowActivity'

type CodexAsk = CodexApproval | CodexQuestion
interface StoredAsks {
  openApproval(tabId: string): CodexApproval | undefined
  openQuestion(tabId: string): CodexQuestion | undefined
}
type ToolCall = Parameters<typeof isAskedCall>[1]

export interface AskWiringDeps {
  runtime(): Pick<SessionRuntime, 'statusOf' | 'awaitsInput'>
  storedOwnerOf(tabId: string): StoredAsks | undefined
  sessionAsks(): Pick<SessionAsks, 'heldAsk' | 'askOf' | 'dialog'> | null
  questionAsked(asked: { tabId: string; id: string }): void
}

const CODEX_REQUEST_TRAILS_ITS_STATUS_POLLS = 8
const CODEX_REQUEST_POLL_MS = 250

export function askWiring(d: AskWiringDeps) {
  const { storedOwnerOf } = d
  const claudeAsks = new Map<string, AskPayload>()

  // CODEX§3 CODEX§20
  async function pendingAskOf(tabId: string): Promise<CodexAsk | undefined> {
    const runtime = d.runtime()
    for (let polls = CODEX_REQUEST_TRAILS_ITS_STATUS_POLLS; ; polls--) {
      const owner = storedOwnerOf(tabId)
      const ask = owner?.openApproval(tabId) ?? owner?.openQuestion(tabId)
      if (ask || !polls || !owner) return ask
      if (runtime.statusOf(tabId) !== 'approval' && !runtime.awaitsInput(tabId)) return undefined
      await sleep(CODEX_REQUEST_POLL_MS)
    }
  }

  return {
    claudeAsked: (tabId: string, ask: AskPayload, id: string): void => {
      claudeAsks.set(tabId, ask)
      d.questionAsked({ tabId, id })
    },
    forgetClaudeAsk: (tabId: string): void => {
      claudeAsks.delete(tabId)
    },
    claudeAskOf: (tabId: string): AskPayload | undefined => claudeAsks.get(tabId),
    endsTheAsk: (tabId: string, call: ToolCall): boolean => {
      const ask = claudeAsks.get(tabId)
      return !!ask && isAskedCall(ask, call)
    },
    askingOf: (tabId: string): string | undefined => {
      const runtime = d.runtime()
      const sessionAsks = d.sessionAsks()
      if (runtime.statusOf(tabId) !== 'approval') return undefined
      const owner = storedOwnerOf(tabId)
      const stored = owner?.openApproval(tabId) ?? owner?.openQuestion(tabId)
      if (stored) return storedAskLine(stored)
      const ask = claudeAsks.get(tabId) ?? sessionAsks?.heldAsk(tabId)
      return ask && claudeAskLine(ask)
    },
    pendingAskOf,
    ownerAsleepAsked: async (tabId: string) => {
      const stored = await pendingAskOf(tabId)
      const runtime = d.runtime()
      const sessionAsks = d.sessionAsks()
      if (stored) {
        const questions = 'questions' in stored ? stored.questions.length : 0
        return { question: questions > 0, questions, text: codexDialog(stored).text }
      }
      const claude =
        sessionAsks?.heldAsk(tabId) ??
        (runtime.statusOf(tabId) === 'approval' ? sessionAsks?.askOf(tabId) : undefined)
      if (!claude) return undefined
      const questions = questionsOf(claude).length
      return { question: questions > 0, questions, text: claudeDialog(claude).text }
    },
    dialogOf: async (tabId: string): Promise<DialogView | undefined> => {
      const ask = await pendingAskOf(tabId)
      return ask ? codexDialog(ask) : d.sessionAsks()?.dialog(tabId)
    }
  }
}
