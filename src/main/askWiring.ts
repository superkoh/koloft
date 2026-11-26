import type { AskPayload } from '@shared/sessionEvent'
import type { BackendId } from '@shared/types'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { sleep } from '@core/sleep'
import type { SessionRuntime } from '@core/agent/sessionRuntime'
import type { ToolCall } from '@core/moment'
import type { CodexApproval, CodexQuestion } from '@plugins/sessions/api'
import { claudeAskLine, storedAskLine } from './rowActivity'

type CodexAsk = CodexApproval | CodexQuestion
interface StoredAsks {
  readonly id: BackendId
  openApproval(tabId: string): CodexApproval | undefined
  openQuestion(tabId: string): CodexQuestion | undefined
}
interface DialogView {
  text: string
}

export interface AskReaders<View extends DialogView> {
  claudeDialog(p: AskPayload): View
  codexDialog(a: CodexAsk, label: string): View
  questionsOf(p: AskPayload): unknown[]
  isAskedCall(p: AskPayload, call: ToolCall): boolean
}

export interface AskWiringDeps<View extends DialogView> {
  runtime(): Pick<SessionRuntime, 'statusOf' | 'awaitsInput'>
  storedOwnerOf(tabId: string): StoredAsks | undefined
  sessionAsks(): {
    heldAsk(tabId: string): AskPayload | undefined
    askOf(tabId: string): AskPayload | undefined
    dialog(tabId: string): View | undefined
  } | null
  readers(): AskReaders<View>
  questionAsked(asked: { tabId: string; id: string }): void
}

const CODEX_REQUEST_TRAILS_ITS_STATUS_POLLS = 8
const CODEX_REQUEST_POLL_MS = 250

interface StoredAsk {
  ask: CodexAsk
  of: BackendId
}

export function askWiring<View extends DialogView>(d: AskWiringDeps<View>) {
  const { storedOwnerOf } = d
  const claudeAsks = new Map<string, AskPayload>()

  // CODEX§3 CODEX§20
  async function pendingStoredAsk(tabId: string): Promise<StoredAsk | undefined> {
    for (let polls = CODEX_REQUEST_TRAILS_ITS_STATUS_POLLS; ; polls--) {
      const owner = storedOwnerOf(tabId)
      const ask = owner?.openApproval(tabId) ?? owner?.openQuestion(tabId)
      if (owner && ask) return { ask, of: owner.id }
      if (!polls || !owner) return undefined
      const runtime = d.runtime()
      if (runtime.statusOf(tabId) !== 'approval' && !runtime.awaitsInput(tabId)) return undefined
      await sleep(CODEX_REQUEST_POLL_MS)
    }
  }

  const storedDialog = ({ ask, of }: StoredAsk): View =>
    d.readers().codexDialog(ask, BACKEND_LABEL[of])

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
      const { isAskedCall } = d.readers()
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
    pendingAskOf: async (tabId: string): Promise<CodexAsk | undefined> =>
      (await pendingStoredAsk(tabId))?.ask,
    ownerAsleepAsked: async (tabId: string) => {
      const stored = await pendingStoredAsk(tabId)
      const runtime = d.runtime()
      const sessionAsks = d.sessionAsks()
      const { claudeDialog, questionsOf } = d.readers()
      if (stored) {
        const questions = 'questions' in stored.ask ? stored.ask.questions.length : 0
        return { question: questions > 0, questions, text: storedDialog(stored).text }
      }
      const claude =
        sessionAsks?.heldAsk(tabId) ??
        (runtime.statusOf(tabId) === 'approval' ? sessionAsks?.askOf(tabId) : undefined)
      if (!claude) return undefined
      const questions = questionsOf(claude).length
      return { question: questions > 0, questions, text: claudeDialog(claude).text }
    },
    dialogOf: async (tabId: string): Promise<View | undefined> => {
      const stored = await pendingStoredAsk(tabId)
      return stored ? storedDialog(stored) : d.sessionAsks()?.dialog(tabId)
    }
  }
}
