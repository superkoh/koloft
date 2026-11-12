import type { Assist } from './assist'

const NAME_MAX_CHARS = 40
const TASK_MAX_CHARS_SENT_FOR_A_TITLE = 4000

const TITLE_SYSTEM = 'You write short titles.'

const CODE_AND_PATHS = /`[^`]*`|\S*\/\S*/g
const LANGUAGE_THE_LETTERS_TELL: [RegExp, string][] = [
  [/\p{Script=Hiragana}/u, 'Japanese'],
  [/\p{Script=Hangul}/u, 'Korean'],
  [/\p{Script=Han}/u, 'Chinese']
]

// ADR-0031
function languageLine(ownerWords: string | undefined): string {
  if (!ownerWords) return 'Write it in the language of the task. '
  const words = ownerWords.replace(CODE_AND_PATHS, ' ')
  const language = LANGUAGE_THE_LETTERS_TELL.find(([letters]) => letters.test(words))?.[1]
  return language
    ? `Write it in ${language}, whatever language the task is in. `
    : `Write it in the language of these words of the person, whatever language the task is in: «${ownerWords}». `
}

const titleInstructions = (ownerWords: string | undefined): string =>
  'Give the task below a very short title, so a person sees at a glance what this session is doing. ' +
  languageLine(ownerWords) +
  'At most 16 characters in Chinese or Japanese, at most 6 words otherwise. ' +
  'Leave out background, rules and filler such as "research a question". ' +
  'Reply with the title alone, no quotes, no full stop.\n\nTask:\n'

const nonEmptyLines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

const lineAsName = (line: string | undefined): string =>
  (line ?? '')
    .replace(/^-+\s*/, '')
    .slice(0, NAME_MAX_CHARS)
    .trim()

const ENDS_LIKE_A_SENTENCE = /[，,。.：:；;!！?？…]$/

const looksLikeATitle = (line: string): boolean =>
  line.length <= NAME_MAX_CHARS && !ENDS_LIKE_A_SENTENCE.test(line) && /\p{L}/u.test(line)

const firstLineName = (text: string): string => lineAsName(nonEmptyLines(text)[0])

function nameFromReply(reply: string): string {
  const lines = nonEmptyLines(reply)
  return lineAsName(lines.find(looksLikeATitle) ?? lines[0])
    .replace(/^["'“‘「『]+|["'”’」』。.!！]+$/g, '')
    .trim()
}

export function distinctTitle(name: string, taken: Set<string>): string {
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
    row: 'title',
    system: TITLE_SYSTEM,
    prompt: titleInstructions(ownerWords) + task.slice(0, TASK_MAX_CHARS_SENT_FOR_A_TITLE)
  })
  return (reply && nameFromReply(reply)) || firstLineName(task)
}
