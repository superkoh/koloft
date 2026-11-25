import {
  edited,
  oneLine,
  ran,
  read,
  searchedTheWeb,
  startedAHelper,
  str,
  used,
  wrote
} from '@core/whatItDid'

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
