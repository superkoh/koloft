import { composePrompt } from '@core/prompt'
import {
  allSeen,
  cleanInstructions,
  textInUse,
  withChangeUndone,
  withNewVersion,
  type ChangeToUndo
} from '@core/ownerInstructions'
import type { SessionDefaults } from '@shared/types'
import { sanitizeDefaults } from '@shared/sessionDefaults'
import { isRecord } from '@shared/workbenchState'
import type { InstructionsBlock } from './instructionsVerb'
import { workspaceLabel } from './placedRows'
import { basename } from '@shared/preview'
import {
  WORKSPACE_TEXT_MAX_BYTES,
  rulesAndInstructionsOver,
  workspaceTextBytes
} from '../shared/workspaceInstructions'

export const workspaceInstructionsPart = (text: string): string =>
  composePrompt('workspace-owner-instructions', { values: { 'owner-instructions': text } })

export function instructionsPartOf(defaults: SessionDefaults | undefined): string | undefined {
  const text = textInUse(defaults?.instructions)
  return text ? workspaceInstructionsPart(text) : undefined
}

function checkTheLimit(rules: string, text: string): void {
  const over = workspaceTextBytes(rules, text) - WORKSPACE_TEXT_MAX_BYTES
  if (over > 0) throw new Error(rulesAndInstructionsOver(over))
}

export function savedFromTheDialog(
  saved: SessionDefaults | undefined,
  raw: unknown,
  at: number
): SessionDefaults | undefined {
  const draft = isRecord(raw) ? raw : {}
  const kept = sanitizeDefaults({ ...draft, instructions: undefined }) ?? { picks: {} }
  const text = cleanInstructions(typeof draft.instructions === 'string' ? draft.instructions : '')
  const rules = kept.rules ?? ''
  if (rules !== (saved?.rules ?? '') || text !== textInUse(saved?.instructions))
    checkTheLimit(rules, text)
  const instructions = withNewVersion(saved?.instructions, text, at) ?? saved?.instructions
  return sanitizeDefaults({ ...kept, instructions })
}

export function savedByAnAgent(
  saved: SessionDefaults | undefined,
  text: string,
  at: number,
  agent: string
): SessionDefaults | undefined {
  if (text === textInUse(saved?.instructions)) return saved
  checkTheLimit(saved?.rules ?? '', text)
  return sanitizeDefaults({
    ...saved,
    instructions: withNewVersion(saved?.instructions, text, at, agent)
  })
}

const withVersions = (
  saved: SessionDefaults | undefined,
  instructions: SessionDefaults['instructions']
): SessionDefaults | undefined => sanitizeDefaults({ ...saved, instructions })

export const seenDefaults = (saved: SessionDefaults | undefined): SessionDefaults | undefined =>
  saved?.instructions ? withVersions(saved, allSeen(saved.instructions)) : saved

export function undoneDefaults(
  saved: SessionDefaults | undefined,
  change: ChangeToUndo,
  at: number
): SessionDefaults | undefined {
  const instructions = withChangeUndone(saved?.instructions, change, at)
  checkTheLimit(saved?.rules ?? '', textInUse(instructions))
  return withVersions(saved, instructions)
}

export interface DefaultsOfWorkspaces {
  read(dir: string): Promise<SessionDefaults>
  write(
    dir: string,
    next: (saved: SessionDefaults | undefined) => SessionDefaults | undefined
  ): Promise<void>
}

export const workspaceBlock = (
  defaults: DefaultsOfWorkspaces,
  workspace: string,
  now: () => number
): InstructionsBlock => ({
  name: `the instructions of workspace ${workspaceLabel(workspace)}`,
  workspace,
  changedBy: (by) => `"${by}" changed the instructions of workspace ${basename(workspace)}.`,
  read: async () => textInUse((await defaults.read(workspace)).instructions),
  write: async (edit, by) => {
    let changed = false
    await defaults.write(workspace, (saved) => {
      const next = savedByAnAgent(saved, edit(textInUse(saved?.instructions)), now(), by)
      changed = next !== saved
      return next
    })
    return changed
  }
})
