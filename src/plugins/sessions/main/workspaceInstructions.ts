import { composePrompt } from '@core/prompt'
import {
  OWNER,
  cleanInstructions,
  textInUse,
  textTheOwnerChose,
  withNewVersion
} from '@core/ownerInstructions'
import type { SessionDefaults } from '@shared/types'
import { sanitizeDefaults } from '@shared/sessionDefaults'
import { isRecord } from '@shared/workbenchState'
import type { InstructionsBlock } from './instructionsVerb'
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
  const cleaned = (v: unknown): string => cleanInstructions(typeof v === 'string' ? v : '')
  const text = textTheOwnerChose(
    textInUse(saved?.instructions),
    cleaned(draft.instructionsOpened),
    cleaned(draft.instructions)
  )
  const rules = kept.rules ?? ''
  if (rules !== (saved?.rules ?? '') || text !== textInUse(saved?.instructions))
    checkTheLimit(rules, text)
  const instructions = withNewVersion(saved?.instructions, text, OWNER, at) ?? saved?.instructions
  return sanitizeDefaults({ ...kept, instructions })
}

export function savedByAnAgent(
  saved: SessionDefaults | undefined,
  text: string,
  by: string,
  at: number
): SessionDefaults | undefined {
  if (text === textInUse(saved?.instructions)) return saved
  checkTheLimit(saved?.rules ?? '', text)
  return sanitizeDefaults({
    ...saved,
    instructions: withNewVersion(saved?.instructions, text, by, at)
  })
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
  check: async (text) => checkTheLimit((await defaults.read(workspace)).rules ?? '', text),
  writeIfStill: async (before, after, by) => {
    let written = false
    await defaults.write(workspace, (saved) => {
      if (textInUse(saved?.instructions) !== before) return saved
      written = true
      return savedByAnAgent(saved, after, by, now())
    })
    return written
  }
})
