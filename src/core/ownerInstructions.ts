export interface InstructionsVersion {
  text: string
  at: number
  by: string
  agent?: true
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
  const version: InstructionsVersion =
    agent === undefined
      ? { text, at, by: OWNER }
      : { text, at, by: agent, agent: true, unseen: true }
  const all = [...(versions ?? []), version]
  const kept = all.slice(-VERSIONS_KEPT)
  const lastSeen = all.findLastIndex((v) => !v.unseen)
  return lastSeen >= 0 && lastSeen < all.length - VERSIONS_KEPT
    ? [all[lastSeen], ...kept.slice(1)]
    : kept
}

export interface InstructionsChange {
  by: string
  at: number
  before: string
  after: string
  changes: number
}

export function unseenChange(
  versions: readonly InstructionsVersion[] | undefined
): InstructionsChange | undefined {
  const last = versions?.at(-1)
  if (!versions || !last?.unseen) return undefined
  let first = versions.length - 1
  while (first > 0 && versions[first - 1].unseen) first--
  const by = [...new Set(versions.slice(first).map((v) => v.by))].join(', ')
  return {
    by,
    at: last.at,
    before: versions[first - 1]?.text ?? '',
    after: last.text,
    changes: versions.length - first
  }
}

export const allSeen = (versions: readonly InstructionsVersion[]): InstructionsVersion[] =>
  versions.map(({ text, at, by, agent }) => ({ text, at, by, ...(agent && { agent }) }))

export const CHANGED_AGAIN = 'The instructions changed again since then, so nothing was undone.'
export const NOT_READ = 'Koloft could not read which change to undo.'

export type ChangeToUndo = Pick<InstructionsChange, 'at' | 'before'>

export function changeToUndo(raw: unknown): ChangeToUndo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { at, before } = raw as Record<string, unknown>
  return typeof at === 'number' && typeof before === 'string' ? { at, before } : undefined
}

export function withChangeUndone(
  versions: readonly InstructionsVersion[] | undefined,
  change: ChangeToUndo,
  at: number
): InstructionsVersion[] {
  const last = versions?.at(-1)
  if (!versions || !last?.agent || last.at !== change.at) throw new Error(CHANGED_AGAIN)
  return withNewVersion(allSeen(versions), change.before, at) ?? allSeen(versions)
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
    const { text, at, by, agent, unseen } = v as Record<string, unknown>
    if (typeof text !== 'string' || typeof at !== 'number' || typeof by !== 'string') return []
    return [
      {
        text: cleanInstructions(text),
        at,
        by,
        ...(agent === true && { agent }),
        ...(agent === true && unseen === true && { unseen })
      }
    ]
  })
}
