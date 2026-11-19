import { composePrompt } from '@core/prompt'
import { cleanInstructions, textInUse, withNewVersion } from '@core/ownerInstructions'
import type { SessionDefaults } from '@shared/types'
import { sanitizeDefaults } from '@shared/sessionDefaults'
import { isRecord } from '@shared/workbenchState'
import type { InstructionsBlock } from './instructionsVerb'
import { workspaceLabel } from './placedRows'
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
  checkTheLimit(saved?.rules ?? '', text)
  const instructions = withNewVersion(saved?.instructions, text, at, agent)
  return instructions ? sanitizeDefaults({ ...saved, instructions }) : saved
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
  read: async () => textInUse((await defaults.read(workspace)).instructions),
  write: (edit, by) =>
    defaults.write(workspace, (saved) =>
      savedByAnAgent(saved, edit(textInUse(saved?.instructions)), now(), by)
    )
})
