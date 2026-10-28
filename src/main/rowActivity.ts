import type { AskPayload } from '@shared/sessionEvent'
import { basename } from '@shared/preview'
import { PLAN_READY } from '@shared/types'
import { questionsOf, type CodexApproval, type CodexQuestion } from './discord/dialog'

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

const CLAUDE_ASKS = new Set(['AskUserQuestion', 'ExitPlanMode'])

// CC§2
export function claudeToolDid(name: string, input: Record<string, unknown>): string | undefined {
  if (CLAUDE_ASKS.has(name)) return undefined
  const file = str(input.file_path) ?? str(input.notebook_path)
  const command = str(input.command)
  switch (name) {
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
      return str(input.pattern) && `Searched for ${oneLine(String(input.pattern))}`
    case 'WebSearch':
      return str(input.query) && `Searched the web for ${oneLine(String(input.query))}`
    case 'WebFetch':
      return str(input.url) && `Opened ${oneLine(String(input.url))}`
    case 'Agent':
    case 'Task':
      return `Started a helper: ${oneLine(str(input.description) ?? 'helper')}`
  }
  return used(name.replace(/^mcp__.+?__/, ''))
}

const SHELL_WRAPPED = /^\S*sh -lc '([\s\S]*)'$/

// CODEX§12
export function codexItemDid(item: Record<string, unknown>): string | undefined {
  if (item.type === 'commandExecution') {
    const first = (Array.isArray(item.commandActions) ? item.commandActions : [])[0] as
      Record<string, unknown> | undefined
    if (first?.type === 'read' && str(first.path)) return read(String(first.path))
    const command = str(first?.command) ?? str(item.command)
    return command && ran(SHELL_WRAPPED.exec(command)?.[1] ?? command)
  }
  if (item.type === 'fileChange') {
    const change = (Array.isArray(item.changes) ? item.changes : [])[0] as
      Record<string, unknown> | undefined
    return str(change?.path) && edited(String(change?.path))
  }
  if (item.type === 'mcpToolCall') return str(item.tool) && used(String(item.tool))
  if (item.type === 'webSearch')
    return str(item.query) && `Searched the web for ${oneLine(String(item.query))}`
  return undefined
}

// CODEX§19
export function codexPlanReady(item: Record<string, unknown>): string | undefined {
  return item.type === 'plan' ? PLAN_READY : undefined
}

// MUSE§9
export function museToolDid(
  name: string,
  input: Record<string, unknown>,
  response: Record<string, unknown>
): string | undefined {
  const file = str(response.filePath) ?? str(input.path)
  switch (name) {
    case 'bash':
      return str(input.command) && ran(String(input.command))
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
  const file = arg('TargetFile') ?? arg('AbsolutePath')
  switch (name) {
    case 'ask_question':
      return undefined
    case 'run_command':
      return arg('CommandLine') && ran(arg('CommandLine')!)
    case 'replace_file_content':
      return file && edited(file)
    case 'write_to_file':
      return file && wrote(file)
    case 'view_file':
      return file && read(file)
  }
  return name ? used(name) : undefined
}

export function claudeAskLine(p: AskPayload): string {
  if (p.tool_name === 'AskUserQuestion') {
    const first = questionsOf(p)[0]
    return first ? `Asks: ${oneLine(first.question)}` : 'Asks you a question'
  }
  if (typeof p.tool_input?.plan === 'string') return 'Asks: Approve this plan?'
  const command = str(p.tool_input?.command)
  if (command) return `Wants to run: ${oneLine(command)}`
  const file = str(p.tool_input?.file_path) ?? str(p.tool_input?.notebook_path)
  if (file) return `Wants to edit: ${basename(file)}`
  return `Wants to use: ${oneLine(p.tool_name ?? 'a tool')}`
}

export function storedAskLine(a: CodexApproval | CodexQuestion): string {
  if ('options' in a) return `Asks: ${oneLine(a.question)}`
  if (a.plan) return 'Asks: Approve this plan?'
  if (a.file) return `Wants to edit: ${basename(a.file)}`
  if (a.command) return `Wants to run: ${oneLine(a.command)}`
  return a.reason ? `Asks: ${oneLine(a.reason)}` : 'Asks for your approval'
}
