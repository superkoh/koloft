import { composePrompt } from '@core/prompt'
import type { ButlerSetting, OldConversationNews } from '../shared/types'
import { instructionsOf } from '../shared/instructions'

const BETWEEN_PARTS = '\n\n'
const ONLY_THE_BUTLER_ITSELF = 'owners-ai-itself-koloft'
const NOT_TOLD_TO_ITS_HELPERS = ''

export const ownerInstructionsPart = (instructions: string): string =>
  composePrompt('butler-owner-instructions', { values: { 'owner-instructions': instructions } })

const withOwnerInstructions = (role: string, instructions: string): string =>
  instructions ? role + BETWEEN_PARTS + ownerInstructionsPart(instructions) : role

export const butlerRole = (name: string, facts: readonly string[] = []): string =>
  composePrompt('butler', { values: { 'butler-name': name }, facts })

export const butlerHelperRole = (name: string, instructions = ''): string =>
  withOwnerInstructions(
    composePrompt('butler-helper', {
      values: { 'butler-name': name, [ONLY_THE_BUTLER_ITSELF]: NOT_TOLD_TO_ITS_HELPERS }
    }),
    instructions
  )

export const pluginsChangedNews = (now: readonly { name: string; on: boolean }[]): string =>
  composePrompt('butler-plugins-changed', {
    values: {
      'plugins-now': now.map(({ name, on }) => `${name} is now ${on ? 'on' : 'off'}`).join(', ')
    }
  })

export const guideMovedNotice = (): string => composePrompt('butler-guide-moved')

export const GUIDE_MOVED_NEWS: OldConversationNews = {
  knownBy: 'knowsItsOwnLines',
  get text() {
    return guideMovedNotice()
  },
  on: () => true
}

export const helperRoleOf = (butler: ButlerSetting): string =>
  butlerHelperRole(butler.name, instructionsOf(butler))
