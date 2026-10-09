import type { Assist } from './assist'

const NAME_MAX_CHARS = 40
const TASK_MAX_CHARS_SENT_FOR_A_TITLE = 4000

const TITLE_SYSTEM = 'You write short titles.'

const TITLE_INSTRUCTIONS =
  'Give the task below a very short title, so a person sees at a glance what this session is doing. ' +
  'Write it in the language of the task: at most 16 characters in Chinese or Japanese, at most 6 words otherwise. ' +
  'Leave out background, rules and filler such as "research a question". ' +
  'Reply with the title alone, no quotes, no full stop.\n\nTask:\n'

function firstLineName(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  return (line ?? '')
    .replace(/^-+\s*/, '')
    .slice(0, NAME_MAX_CHARS)
    .trim()
}

function nameFromReply(reply: string): string {
  return firstLineName(reply)
    .replace(/^["'“‘「『]+|["'”’」』。.!！]+$/g, '')
    .trim()
}

function distinctName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  let n = 2
  while (taken.has(`${name} ${n}`)) n++
  return `${name} ${n}`
}

export async function nameForTask(
  task: string,
  assist: Assist,
  taken: Set<string>
): Promise<string> {
  const reply = await assist({
    system: TITLE_SYSTEM,
    prompt: TITLE_INSTRUCTIONS + task.slice(0, TASK_MAX_CHARS_SENT_FOR_A_TITLE)
  })
  return distinctName((reply && nameFromReply(reply)) || firstLineName(task), taken)
}
