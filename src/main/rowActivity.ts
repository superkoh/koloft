import type { AskPayload } from '@shared/sessionEvent'
import { basename } from '@shared/preview'
import { toolFilePath } from './claudeTouchedFiles'
import { planOf, questionsOf, type CodexApproval, type CodexQuestion } from './discord/dialog'

const LINE_KEEPS_CHARS = 200

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, LINE_KEEPS_CHARS)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

const ran = (command: string): string => `Ran ${oneLine(command)}`
const edited = (file: string): string => `Edited ${basename(file)}`
const wrote = (file: string): string => `Wrote ${basename(file)}`
const read = (file: string): string => `Read ${basename(file)}`
const used = (tool: string): string => `Used ${oneLine(tool)}`
const searched = (what: string): string => `Searched for ${oneLine(what)}`

// CC§2
export function claudeToolDid(name: string, input: Record<string, unknown>): string | undefined {
  const file = toolFilePath(input) ?? undefined
  const command = str(input.command)
  const pattern = str(input.pattern)
  const query = str(input.query)
  const url = str(input.url)
  switch (name) {
    case 'AskUserQuestion':
    case 'ExitPlanMode':
      return undefined
    case 'Bash':
      return command && ran(command)
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file && edited(file)
    case 'Write':
      return file && wrote(file)
    case 'Read':
      return file && read(file)
    case 'Grep':
    case 'Glob':
      return pattern && searched(pattern)
    case 'WebSearch':
      return query && `Searched the web for ${oneLine(query)}`
    case 'WebFetch':
      return url && `Opened ${oneLine(url)}`
    case 'Agent':
    case 'Task':
      return `Started a helper: ${oneLine(str(input.description) ?? 'helper')}`
  }
  return used(name.replace(/^mcp__.+?__/, ''))
}

const SHELL_WRAPPED = /^\S*sh -lc '([\s\S]*)'$/

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

// CODEX§12
export function codexEditTarget(item: Record<string, unknown>): string | undefined {
  if (item.type !== 'fileChange') return undefined
  const change = records(item.changes)[0]
  const kind = (change?.kind ?? {}) as Record<string, unknown>
  return str(kind.move_path) ?? str(change?.path)
}

// CODEX§12
export function codexItemDid(item: Record<string, unknown>): string | undefined {
  if (item.type === 'fileChange') {
    const file = codexEditTarget(item)
    return file && edited(file)
  }
  if (item.type !== 'commandExecution') return undefined
  const actions = records(item.commandActions)
  const only = actions.length === 1 ? actions[0] : undefined
  const readPath = only?.type === 'read' && item.status === 'completed' ? str(only.path) : undefined
  if (readPath) return read(readPath)
  const command = str(only?.command) ?? str(item.command)
  return command && ran(SHELL_WRAPPED.exec(command)?.[1] ?? command)
}

// MUSE§9
export function museToolDid(
  name: string,
  input: Record<string, unknown>,
  response: Record<string, unknown>
): string | undefined {
  const file = str(response.filePath) ?? str(input.path)
  const command = str(input.command)
  switch (name) {
    case 'bash':
      return command && ran(command)
    case 'edit_file':
      return file && edited(file)
    case 'write_file':
      return file && wrote(file)
    case 'read_file':
      return file && read(file)
  }
  return name ? used(name) : undefined
}

// AGY§13
export function agyToolDid(
  name: string,
  arg: (key: string) => string | undefined
): string | undefined {
  const file = arg('TargetFile')
  const command = arg('CommandLine')
  switch (name) {
    case 'ask_question':
      return undefined
    case 'run_command':
      return command && ran(command)
    case 'replace_file_content':
      return file && edited(file)
    case 'write_to_file':
      return file && wrote(file)
  }
  return name ? used(name) : undefined
}

export function claudeAskLine(p: AskPayload): string {
  if (p.tool_name === 'AskUserQuestion') {
    const first = questionsOf(p)[0]
    return first ? `Asks: ${oneLine(first.question)}` : 'Asks you a question'
  }
  if (planOf(p) !== undefined) return 'Asks: Approve this plan?'
  const command = str(p.tool_input?.command)
  if (command) return `Wants to run: ${oneLine(command)}`
  const file = toolFilePath(p.tool_input)
  if (file) return `Wants to edit: ${basename(file)}`
  return `Wants to use: ${oneLine(p.tool_name ?? 'a tool')}`
}

export function storedAskLine(a: CodexApproval | CodexQuestion): string {
  if ('questions' in a) {
    const first = a.questions[0]
    return first ? `Asks: ${oneLine(first.question)}` : 'Asks you a question'
  }
  if (a.plan) return 'Asks: Approve this plan?'
  if (a.file) return `Wants to edit: ${basename(a.file)}`
  if (a.command) return `Wants to run: ${oneLine(a.command)}`
  return a.reason ? `Asks: ${oneLine(a.reason)}` : 'Asks for your approval'
}
