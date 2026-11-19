import { composePrompt } from '@core/prompt'
import { OWNER, cleanInstructions, textInUse, withNewVersion } from '@core/ownerInstructions'
import type { SessionDefaults } from '@shared/types'
import { sanitizeDefaults } from '@shared/sessionDefaults'
import { isRecord } from '@shared/workbenchState'
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

export function savedFromTheDialog(
  saved: SessionDefaults | undefined,
  raw: unknown,
  at: number
): SessionDefaults | undefined {
  const draft = isRecord(raw) ? raw : {}
  const kept = sanitizeDefaults({ ...draft, instructions: undefined }) ?? { picks: {} }
  const text = cleanInstructions(typeof draft.instructions === 'string' ? draft.instructions : '')
  const rules = kept.rules ?? ''
  if (rules !== (saved?.rules ?? '') || text !== textInUse(saved?.instructions)) {
    const over = workspaceTextBytes(rules, text) - WORKSPACE_TEXT_MAX_BYTES
    if (over > 0) throw new Error(rulesAndInstructionsOver(over))
  }
  const instructions = withNewVersion(saved?.instructions, text, OWNER, at) ?? saved?.instructions
  return sanitizeDefaults({ ...kept, instructions })
}
