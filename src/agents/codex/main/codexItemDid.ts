import {
  edited,
  oneLine,
  opened,
  ran,
  read,
  searchedTheWeb,
  startedAHelper,
  str
} from '@core/whatItDid'

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
  if (action.type === 'findInPage' || action.type === 'openPage') {
    const url = str(action.url) ?? str(item.query)
    const pattern = action.type === 'findInPage' ? str(action.pattern) : undefined
    if (url && pattern) return `Searched ${oneLine(url)} for ${oneLine(pattern)}`
    return url && opened(url)
  }
  const queries = Array.isArray(action.queries) ? action.queries : []
  const query = str(action.query) ?? str(item.query) ?? str(queries[0])
  return query && searchedTheWeb(query)
}

// CODEX§4
export function codexTaskName(agentPath: unknown): string | undefined {
  return (typeof agentPath === 'string' && agentPath.split('/').pop()) || undefined
}

// CODEX§4
function codexHelperDid(item: Record<string, unknown>): string | undefined {
  if (item.type === 'collabAgentToolCall') {
    const spawned =
      item.tool === 'spawnAgent' &&
      Array.isArray(item.receiverThreadIds) &&
      item.receiverThreadIds.length > 0
    return spawned ? startedAHelper(str(item.prompt) ?? 'helper') : undefined
  }
  if (item.kind !== 'started') return undefined
  return startedAHelper(codexTaskName(item.agentPath) ?? 'helper')
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
