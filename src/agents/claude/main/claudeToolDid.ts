import {
  edited,
  opened,
  ran,
  read,
  searched,
  searchedTheWeb,
  startedAHelper,
  str,
  used,
  wrote
} from '@core/whatItDid'
import { toolFilePath, withoutMcpServer } from './claudeTouchedFiles'

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
