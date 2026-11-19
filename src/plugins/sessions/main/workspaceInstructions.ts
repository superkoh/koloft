import { composePrompt } from '@core/prompt'
import {
  OWNER,
  cleanInstructions,
  overTheLimit,
  textInUse,
  withNewVersion
} from '@core/ownerInstructions'
import {
  WORKSPACE_TEXT_MAX_BYTES,
  workspaceTextBytes,
  type InstructionsOfWorkspaces
} from '../shared/workspaceInstructions'

export const workspaceInstructionsPart = (text: string): string =>
  composePrompt('workspace-owner-instructions', { values: { 'owner-instructions': text } })

export interface WorkspaceInstructionsDeps {
  rootOf(dir: string): string
  saved(): InstructionsOfWorkspaces
  save(all: InstructionsOfWorkspaces): void
  now(): number
}

export interface WorkspaceInstructions {
  textOf(dir: string): string
  partOf(dir: string): string | undefined
  checked(raw: unknown, rules: string): string
  write(dir: string, text: string): void
}

export function workspaceInstructions(d: WorkspaceInstructionsDeps): WorkspaceInstructions {
  const textOf = (dir: string): string => textInUse(d.saved()[d.rootOf(dir)])
  return {
    textOf,
    partOf: (dir) => {
      const text = textOf(dir)
      return text ? workspaceInstructionsPart(text) : undefined
    },
    checked: (raw, rules) => {
      const text = cleanInstructions(typeof raw === 'string' ? raw : '')
      const over = workspaceTextBytes(rules, text) - WORKSPACE_TEXT_MAX_BYTES
      if (over > 0) throw new Error(overTheLimit(over))
      return text
    },
    write: (dir, text) => {
      const root = d.rootOf(dir)
      const all = d.saved()
      const versions = withNewVersion(all[root], text, OWNER, d.now())
      if (versions) d.save({ ...all, [root]: versions })
    }
  }
}
