import { cleanVersions, instructionsBytes, type InstructionsVersion } from '@core/ownerInstructions'
import { isRecord } from '@shared/workbenchState'
import { withProjectRules } from '../prompts/text'

// MUSE§12
export const WORKSPACE_TEXT_MAX_BYTES = 10_000

export const workspaceTextBytes = (rules: string, instructions: string): number =>
  instructionsBytes(withProjectRules(rules, '')) + instructionsBytes(instructions)

export type InstructionsOfWorkspaces = Record<string, InstructionsVersion[]>

export function cleanInstructionsOfWorkspaces(raw: unknown): InstructionsOfWorkspaces {
  if (!isRecord(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw).flatMap(([root, versions]) => {
      const kept = cleanVersions(versions)
      return kept.length ? [[root, kept]] : []
    })
  )
}
