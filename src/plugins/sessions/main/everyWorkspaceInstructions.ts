import { composePrompt } from '@core/prompt'
import {
  ChangedWhileOpen,
  OWNER,
  cleanInstructions,
  instructionsBytes,
  overTheLimit,
  textInUse,
  textTheOwnerChose,
  withNewVersion,
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

function checkTheLimit(text: string): void {
  const over = instructionsBytes(text) - EVERY_WORKSPACE_TEXT_MAX_BYTES
  if (over > 0) throw new Error(overTheLimit(over))
}

function withVersion(
  versions: readonly InstructionsVersion[],
  text: string,
  by: string,
  at: number
): InstructionsVersion[] {
  checkTheLimit(text)
  return withNewVersion(versions, text, by, at) ?? [...versions]
}

export type EveryWorkspaceSaved =
  { ok: true; versions: InstructionsVersion[] } | { ok: false; error: string; inUse?: string }

export function savedByTheOwner(
  versions: readonly InstructionsVersion[],
  typed: string,
  opened: string,
  at: number
): EveryWorkspaceSaved {
  try {
    const text = textTheOwnerChose(
      textInUse(versions),
      cleanInstructions(opened),
      cleanInstructions(typed)
    )
    return { ok: true, versions: withVersion(versions, text, OWNER, at) }
  } catch (error) {
    if (error instanceof ChangedWhileOpen)
      return { ok: false, error: error.message, inUse: error.inUse }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const everyWorkspaceBlock = (
  versions: () => readonly InstructionsVersion[],
  save: (versions: InstructionsVersion[]) => void,
  now: () => number
): InstructionsBlock => ({
  name: FOR_EVERY_WORKSPACE,
  forEveryWorkspace: true,
  read: async () => textInUse(versions()),
  check: async (text) => checkTheLimit(text),
  writeIfStill: async (before, after, by) => {
    const was = versions()
    if (textInUse(was) !== before) return false
    save(withVersion(was, after, by, now()))
    return true
  }
})
