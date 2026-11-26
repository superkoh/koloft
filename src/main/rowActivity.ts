import type { AskPayload } from '@shared/sessionEvent'
import { basename } from '@shared/preview'
import { oneLine } from '@core/whatItDid'
import { withoutMcpServer } from '@agents/claude/main/claudeTouchedFiles'
import {
  claudeToolAsk,
  planOf,
  questionsOf,
  type CodexApproval,
  type CodexQuestion
} from '@plugins/sessions/main/dialog'

export function claudeAskLine(p: AskPayload): string {
  if (p.tool_name === 'AskUserQuestion') {
    const first = questionsOf(p)[0]
    return first ? `Asks: ${oneLine(first.question)}` : 'Asks you a question'
  }
  if (planOf(p) !== undefined) return 'Asks: Approve this plan?'
  const ask = claudeToolAsk(p)
  if ('command' in ask) return `Wants to run: ${oneLine(ask.command)}`
  if ('file' in ask) return `Wants to ${ask.read ? 'read' : 'edit'}: ${basename(ask.file)}`
  return `Wants to use: ${oneLine(withoutMcpServer(ask.tool) || 'a tool')}`
}

export function storedAskLine(a: CodexApproval | CodexQuestion): string {
  if ('questions' in a) {
    const first = a.questions[0]
    return first ? `Asks: ${oneLine(first.question)}` : 'Asks you a question'
  }
  if (a.plan) return 'Asks: Approve this plan?'
  if (a.file) return `Wants to ${a.read ? 'read' : 'edit'}: ${basename(a.file)}`
  if (a.command) return `Wants to run: ${oneLine(a.command)}`
  return a.reason ? `Asks: ${oneLine(a.reason)}` : 'Asks for your approval'
}
