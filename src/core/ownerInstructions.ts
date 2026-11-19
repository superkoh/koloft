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

export function cleanVersions(raw: unknown): InstructionsVersion[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((v: unknown) => {
    if (!v || typeof v !== 'object') return []
    const { text, at, by } = v as Record<string, unknown>
    if (typeof text !== 'string' || typeof at !== 'number' || typeof by !== 'string') return []
    return [{ text: cleanInstructions(text), at, by }]
  })
}
