import type { AskPayload } from '@shared/sessionEvent'
import { basename } from '@shared/preview'
import { oneLine, str } from '@core/whatItDid'
import { toolFilePath, withoutMcpServer, WRITE_TOOLS } from '@agents/claude/main/claudeTouchedFiles'
import {
  planOf,
  questionsOf,
  type CodexApproval,
  type CodexQuestion
} from '@plugins/sessions/main/dialog'

const CLAUDE_READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob'])

export function claudeAskLine(p: AskPayload): string {
  if (p.tool_name === 'AskUserQuestion') {
    const first = questionsOf(p)[0]
    return first ? `Asks: ${oneLine(first.question)}` : 'Asks you a question'
  }
  if (planOf(p) !== undefined) return 'Asks: Approve this plan?'
  const command = str(p.tool_input?.command)
  if (command) return `Wants to run: ${oneLine(command)}`
  const file = toolFilePath(p.tool_input)
  const tool = p.tool_name ?? ''
  if (file && WRITE_TOOLS.has(tool)) return `Wants to edit: ${basename(file)}`
  if (file && CLAUDE_READ_TOOLS.has(tool)) return `Wants to read: ${basename(file)}`
  return `Wants to use: ${oneLine(withoutMcpServer(tool) || 'a tool')}`
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
