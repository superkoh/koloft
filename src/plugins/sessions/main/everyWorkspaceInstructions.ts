import { composePrompt } from '@core/prompt'
import {
  textInUse,
  versionsSavedByTheOwner,
  versionsStore,
  type InstructionsVersion
} from '@core/ownerInstructions'
import type { SessionDefaults } from '@shared/types'
import type { InstructionsBlock } from './instructionsVerb'
import { workspaceInstructionsPart } from './workspaceInstructions'
import { EVERY_WORKSPACE_TEXT_MAX_BYTES } from '../shared/workspaceInstructions'

const FOR_EVERY_WORKSPACE = 'the instructions for every workspace'

export const everyWorkspacePart = (text: string): string =>
  composePrompt('every-workspace-owner-instructions', { values: { 'owner-instructions': text } })

export function ownerPartsOf(
  everyWorkspace: readonly InstructionsVersion[],
  defaults: SessionDefaults | undefined,
  butlerSide: boolean
): string[] {
  const shared = textInUse(everyWorkspace)
  const own = textInUse(defaults?.instructions)
  const takesShared = !!shared && !butlerSide && !defaults?.leavesOutEveryWorkspace
  return [
    ...(takesShared ? [everyWorkspacePart(shared)] : []),
    ...(own ? [workspaceInstructionsPart(own)] : [])
  ]
}

export type EveryWorkspaceSaved =
  { ok: true; versions: InstructionsVersion[] } | { ok: false; error: string; inUse?: string }

export function savedByTheOwner(
  versions: readonly InstructionsVersion[],
  typed: string,
  opened: string,
  at: number
): EveryWorkspaceSaved {
  const saved = versionsSavedByTheOwner(versions, typed, opened, at, EVERY_WORKSPACE_TEXT_MAX_BYTES)
  if (!saved.ok) return saved
  return { ok: true, versions: saved.versions ?? [...versions] }
}

export const everyWorkspaceBlock = (
  versions: () => readonly InstructionsVersion[],
  save: (versions: InstructionsVersion[]) => void,
  now: () => number
): InstructionsBlock => ({
  name: FOR_EVERY_WORKSPACE,
  forEveryWorkspace: true,
  ...versionsStore(versions, save, EVERY_WORKSPACE_TEXT_MAX_BYTES, now)
})
