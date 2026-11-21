import type { AskPayload } from '@shared/sessionEvent'
import { basename } from '@shared/preview'
import { toolFilePath, WRITE_TOOLS } from './claudeTouchedFiles'
import {
  planOf,
  questionsOf,
  type CodexApproval,
  type CodexQuestion
} from '@plugins/sessions/main/dialog'

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
const searchedTheWeb = (query: string): string => `Searched the web for ${oneLine(query)}`
const opened = (url: string): string => `Opened ${oneLine(url)}`
const startedAHelper = (label: string): string => `Started a helper: ${oneLine(label)}`
const withoutMcpServer = (tool: string): string => tool.replace(/^mcp__.+?__/, '')

const CLAUDE_READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob'])

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
      return query && searchedTheWeb(query)
    case 'WebFetch':
      return url && opened(url)
    case 'Agent':
    case 'Task':
      return startedAHelper(str(input.description) ?? 'helper')
  }
  return used(withoutMcpServer(name))
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
function codexWebSearchDid(item: Record<string, unknown>): string | undefined {
  const action = (item.action ?? {}) as Record<string, unknown>
  const url = str(action.url)
  if (action.type === 'openPage' || action.type === 'findInPage') return url && opened(url)
  const query = str(action.query) ?? str(item.query)
  return query && searchedTheWeb(query)
}

// CODEX§4
function codexHelperDid(item: Record<string, unknown>): string | undefined {
  if (item.type === 'collabAgentToolCall')
    return item.tool === 'spawnAgent' ? startedAHelper(str(item.prompt) ?? 'helper') : undefined
  if (item.kind !== 'started') return undefined
  return startedAHelper(str(item.agentPath)?.split('/').pop() || 'helper')
}

// CODEX§4 CODEX§12 CODEX§32
export function codexItemDid(item: Record<string, unknown>): string | undefined {
  if (item.type === 'fileChange') {
    const file = codexEditTarget(item)
    return file && edited(file)
  }
  if (item.type === 'webSearch') return codexWebSearchDid(item)
  if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity')
    return codexHelperDid(item)
  if (item.type !== 'commandExecution') return undefined
  const actions = records(item.commandActions)
  const only = actions.length === 1 ? actions[0] : undefined
  const readPath = only?.type === 'read' && item.status === 'completed' ? str(only.path) : undefined
  if (readPath) return read(readPath)
  const command = str(only?.command) ?? str(item.command)
  return command && ran(SHELL_WRAPPED.exec(command)?.[1] ?? command)
}

// AGY§13
export function agyToolDid(
  name: string,
  arg: (key: string) => string | undefined,
  rawArgs?: Record<string, unknown>
): string | undefined {
  const file = str(arg('TargetFile') ?? arg('Path') ?? arg('AbsolutePath'))
  const command = str(arg('CommandLine'))
  switch (name) {
    case 'ask_question':
      return undefined
    case 'run_command':
      return command && ran(command)
    case 'replace_file_content':
    case 'edit_file':
      return file && edited(file)
    case 'write_to_file':
    case 'write_file':
      return file && wrote(file)
    case 'view_file':
    case 'read_file':
      return file && read(file)
    case 'search_web': {
      const query = str(arg('query') ?? arg('Query'))
      return query ? searchedTheWeb(query) : used(name)
    }
    case 'invoke_subagent': {
      const first =
        Array.isArray(rawArgs?.Subagents) &&
        rawArgs.Subagents[0] &&
        typeof rawArgs.Subagents[0] === 'object'
          ? (rawArgs.Subagents[0] as Record<string, unknown>)
          : undefined
      const label =
        str(arg('Role')) ??
        str(first?.Role) ??
        str(arg('TypeName')) ??
        str(first?.TypeName) ??
        str(arg('toolSummary')) ??
        str(arg('Prompt')) ??
        str(first?.Prompt) ??
        'helper'
      return startedAHelper(label)
    }
    case 'swarm': {
      const action = str(arg('action') ?? arg('Action'))
      const member = str(arg('name') ?? arg('Name'))
      if (action === 'add' && member) return startedAHelper(member)
      if (action === 'kill' && member) return `Stopped helper ${oneLine(member)}`
      return action ? `Managed swarm (${oneLine(action)})` : used(name)
    }
    case 'manage_subagents': {
      const action = str(arg('Action'))
      if (action === 'kill' || action === 'kill_all') return 'Stopped subagents'
      return action ? `Managed subagents (${oneLine(action)})` : used(name)
    }
    case 'schedule': {
      const prompt = str(arg('Prompt')) ?? str(arg('toolSummary')) ?? str(arg('CronExpression'))
      if (prompt) return `Scheduled ${oneLine(prompt)}`
      const secs = rawArgs?.DurationSeconds
      return typeof secs === 'number' && Number.isFinite(secs)
        ? `Scheduled ${secs}s timer`
        : used(name)
    }
    case 'manage_task': {
      const action = str(arg('Action'))
      const taskId = str(arg('TaskId'))
      if (action === 'kill') return taskId ? `Stopped task ${oneLine(taskId)}` : 'Stopped a task'
      return action ? `Managed task (${oneLine(action)})` : used(name)
    }
    case 'send_message': {
      const recipient = str(arg('Recipient'))
      return recipient ? `Messaged ${oneLine(recipient)}` : used(name)
    }
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
