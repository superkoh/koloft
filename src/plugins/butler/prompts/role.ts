import { composePrompt } from '@core/prompt'
import type { ButlerSetting, OldConversationNews } from '../shared/types'
import { instructionsOf } from '../shared/instructions'

const BETWEEN_PARTS = '\n\n'

export const ownerInstructionsPart = (instructions: string): string =>
  composePrompt('butler-owner-instructions', { values: { 'owner-instructions': instructions } })

const withOwnerInstructions = (role: string, instructions: string): string =>
  instructions ? role + BETWEEN_PARTS + ownerInstructionsPart(instructions) : role

export const butlerRole = (name: string, facts: readonly string[] = []): string =>
  composePrompt('butler', { values: { 'butler-name': name }, facts })

export const butlerHelperRole = (name: string, instructions = ''): string =>
  withOwnerInstructions(
    composePrompt('butler-helper', {
      values: { 'butler-name': name, 'owners-ai-itself-koloft': '' }
    }),
    instructions
  )

export const pluginsChangedNews = (now: readonly { name: string; on: boolean }[]): string =>
  composePrompt('butler-plugins-changed', {
    values: {
      'plugins-now': now.map(({ name, on }) => `${name} is now ${on ? 'on' : 'off'}`).join(', ')
    }
  })

export const GUIDE_MOVED_NEWS: OldConversationNews = {
  knownBy: 'knowsItsOwnLines',
  text: () => composePrompt('butler-guide-moved'),
  on: () => true
}

export const helperRoleOf = (butler: ButlerSetting): string =>
  butlerHelperRole(butler.name, instructionsOf(butler))
