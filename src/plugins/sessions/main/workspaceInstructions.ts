import { composePrompt } from '@core/prompt'
import {
  OWNER,
  cleanInstructions,
  savedVersions,
  textInUse,
  textTheOwnerChose,
  type InstructionsVersion
} from '@core/ownerInstructions'
import type { SessionDefaults } from '@shared/types'
import { sanitizeDefaults } from '@shared/sessionDefaults'
import { isRecord } from '@shared/workbenchState'
import type { InstructionsBlock } from './instructionsVerb'
import { basename } from '@shared/preview'
import { roomForInstructions, rulesAndInstructionsOver } from '../shared/workspaceInstructions'

export const workspaceInstructionsPart = (text: string): string =>
  composePrompt('workspace-owner-instructions', { values: { 'owner-instructions': text } })

function versionsWith(
  versions: readonly InstructionsVersion[] | undefined,
  rules: string,
  text: string,
  by: string,
  at: number
): InstructionsVersion[] | undefined {
  const result = savedVersions(
    versions,
    text,
    by,
    at,
    roomForInstructions(rules),
    rulesAndInstructionsOver
  )
  if (!result.ok) throw new Error(result.error)
  return result.versions
}

export function savedFromTheDialog(
  saved: SessionDefaults | undefined,
  raw: unknown,
  at: number
): SessionDefaults | undefined {
  const draft = isRecord(raw) ? raw : {}
  const kept = sanitizeDefaults({ ...draft, instructions: undefined }) ?? { picks: {} }
  const cleaned = (v: unknown): string => cleanInstructions(typeof v === 'string' ? v : '')
  const text = textTheOwnerChose(
    textInUse(saved?.instructions),
    cleaned(draft.instructionsOpened),
    cleaned(draft.instructions)
  )
  const rules = kept.rules ?? ''
  const changed = rules !== (saved?.rules ?? '') || text !== textInUse(saved?.instructions)
  const instructions =
    (changed ? versionsWith(saved?.instructions, rules, text, OWNER, at) : undefined) ??
    saved?.instructions
  return sanitizeDefaults({ ...kept, instructions })
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
  name: `the instructions of workspace ${basename(workspace)}`,
  read: async () => textInUse((await defaults.read(workspace)).instructions),
  check: async (text) => {
    const saved = await defaults.read(workspace)
    versionsWith(saved.instructions, saved.rules ?? '', text, '', now())
  },
  writeIfStill: async (before, after, by) => {
    let written = false
    await defaults.write(workspace, (saved) => {
      if (textInUse(saved?.instructions) !== before) return saved
      written = true
      const instructions = versionsWith(saved?.instructions, saved?.rules ?? '', after, by, now())
      return instructions ? sanitizeDefaults({ ...saved, instructions }) : saved
    })
    return written
  }
})
