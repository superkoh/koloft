export interface InstructionsVersion {
  text: string
  at: number
  by: string
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
  by: string,
  at: number
): InstructionsVersion[] | undefined {
  if (text === textInUse(versions)) return undefined
  return [...(versions ?? []), { text, at, by }].slice(-VERSIONS_KEPT)
}

export class ChangedWhileOpen extends Error {
  constructor(readonly inUse: string) {
    super(
      'While this was open, the instructions were changed as shown. Nothing was saved. Save again to put your text in their place.'
    )
  }
}

export function textTheOwnerChose(inUse: string, opened: string, typed: string): string {
  if (typed === opened) return inUse
  if (inUse !== opened && inUse !== typed) throw new ChangedWhileOpen(inUse)
  return typed
}

export const ADD_A_LINE = 'add'
export const REPLACE_THE_TEXT = 'set'
export type AgentEdit = typeof ADD_A_LINE | typeof REPLACE_THE_TEXT

export function editedText(current: string, edit: AgentEdit, words: string): string {
  const line = cleanInstructions(words)
  if (edit === REPLACE_THE_TEXT || !current) return line
  if (current.split('\n').some((l) => l.trim() === line)) return current
  return cleanInstructions(`${current}\n${line}`)
}

export function cleanVersions(raw: unknown): InstructionsVersion[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((v: unknown) => {
    if (!v || typeof v !== 'object') return []
    const { text, at, by } = v as Record<string, unknown>
    if (typeof text !== 'string' || typeof at !== 'number' || typeof by !== 'string') return []
    return [{ text: cleanInstructions(text), at, by }]
  })
}
