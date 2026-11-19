export interface InstructionsVersion {
  text: string
  at: number
  by: string
  unseen?: true
}

export const OWNER = 'owner'

const VERSIONS_KEPT = 20

const UNSEEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g

const encoder = new TextEncoder()

// MUSE§12
export const instructionsBytes = (text: string): number =>
  encoder.encode(JSON.stringify(text)).length - 2

export const cleanInstructions = (raw: string): string =>
  raw.replace(/\r\n?/g, '\n').replace(UNSEEN_CONTROL_CHARACTERS, '').trim()

export const textInUse = (versions: readonly InstructionsVersion[] | undefined): string =>
  versions?.at(-1)?.text ?? ''

const count = (n: number): string => n.toLocaleString('en-US')

export const bytesLeft = (left: number): string =>
  left < 0 ? `${count(-left)} over the limit` : `${count(left)} left`

export const overTheLimit = (over: number): string =>
  `The instructions are ${over.toLocaleString('en-US')} over the limit.`

export function withNewVersion(
  versions: readonly InstructionsVersion[] | undefined,
  text: string,
  at: number,
  agent?: string
): InstructionsVersion[] | undefined {
  if (text === textInUse(versions)) return undefined
  const version: InstructionsVersion = agent
    ? { text, at, by: agent, unseen: true }
    : { text, at, by: OWNER }
  return [...(versions ?? []), version].slice(-VERSIONS_KEPT)
}

export const ADD_A_LINE = 'add'
export const REPLACE_THE_TEXT = 'set'
export type AgentEdit = typeof ADD_A_LINE | typeof REPLACE_THE_TEXT

export function editedText(current: string, edit: AgentEdit, words: string): string {
  if (edit === REPLACE_THE_TEXT || !current) return cleanInstructions(words)
  return cleanInstructions(`${current}\n${words}`)
}

export function cleanVersions(raw: unknown): InstructionsVersion[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((v: unknown) => {
    if (!v || typeof v !== 'object') return []
    const { text, at, by, unseen } = v as Record<string, unknown>
    if (typeof text !== 'string' || typeof at !== 'number' || typeof by !== 'string') return []
    return [{ text: cleanInstructions(text), at, by, ...(unseen === true && { unseen }) }]
  })
}
