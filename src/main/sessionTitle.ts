import type { Assist } from './assist'

const NAME_MAX_CHARS = 40
const TASK_MAX_CHARS_SENT_FOR_A_TITLE = 4000

const TITLE_SYSTEM = 'You write short titles.'

const titleInstructions = (ownerWords: string | undefined): string =>
  'Give the task below a very short title, so a person sees at a glance what this session is doing. ' +
  (ownerWords
    ? `Write it in the language of these words of the person, whatever language the task is in: «${ownerWords}». `
    : 'Write it in the language of the task. ') +
  'At most 16 characters in Chinese or Japanese, at most 6 words otherwise. ' +
  'Leave out background, rules and filler such as "research a question". ' +
  'Reply with the title alone, no quotes, no full stop.\n\nTask:\n'

export function firstLineName(text: string): string {
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

export function distinctName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  let n = 2
  while (taken.has(`${name} ${n}`)) n++
  return `${name} ${n}`
}

export async function titleForTask(
  task: string,
  assist: Assist,
  ownerWords?: string
): Promise<string> {
  const reply = await assist({
    system: TITLE_SYSTEM,
    prompt: titleInstructions(ownerWords) + task.slice(0, TASK_MAX_CHARS_SENT_FOR_A_TITLE)
  })
  return (reply && nameFromReply(reply)) || firstLineName(task)
}
