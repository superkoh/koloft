import { instructionsBytes } from '@core/ownerInstructions'
import { withProjectRules } from '../prompts/text'

export const WORKSPACE_TEXT_MAX_BYTES = 10_000

export const EVERY_WORKSPACE_TEXT_MAX_BYTES = 10_000

export const workspaceTextBytes = (rules: string, instructions: string): number =>
  instructionsBytes(withProjectRules(rules, '')) + instructionsBytes(instructions)

export const roomForInstructions = (rules: string): number =>
  WORKSPACE_TEXT_MAX_BYTES - workspaceTextBytes(rules, '')

export const rulesAndInstructionsOver = (over: number): string =>
  `The rules and instructions together are ${over.toLocaleString('en-US')} over the limit.`
