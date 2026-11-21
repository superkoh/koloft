import { composePrompt, fillsGained, type PromptState } from '@core/prompt'
import type { ButlerSetting, OldConversationNews } from '../shared/types'
import { instructionsOf } from '../shared/instructions'
import { TEXT } from './text'

const BETWEEN_PARTS = '\n\n'

export const ownerInstructionsPart = (instructions: string): string =>
  composePrompt('butler-owner-instructions', { values: { 'owner-instructions': instructions } })

const withOwnerInstructions = (role: string, instructions: string): string =>
  instructions ? role + BETWEEN_PARTS + ownerInstructionsPart(instructions) : role

const BUTLER_NAME = 'butler-name'

export const butlerRole = (name: string, facts: readonly string[] = []): string =>
  composePrompt('butler', { values: { [BUTLER_NAME]: name }, facts })

export const butlerHelperRole = (name: string, instructions = ''): string =>
  withOwnerInstructions(
    composePrompt('butler-helper', {
      values: { [BUTLER_NAME]: name, 'owners-ai-itself-koloft': '' }
    }),
    instructions
  )

const SLOT_IN_TEXT = /\{\{([a-z-]+)\}\}/g

const SLOTS_PLUGINS_FILL_IN_THE_BUTLERS_ROLE = [
  ...TEXT.find(({ slot }) => slot === 'butler')!.text.matchAll(SLOT_IN_TEXT)
]
  .map(([, name]) => name)
  .filter((name) => name !== BUTLER_NAME)

export const butlerLinesGained = (was: PromptState, now: PromptState): string[] =>
  fillsGained(SLOTS_PLUGINS_FILL_IN_THE_BUTLERS_ROLE, was, now)

export const factGivesLinesWhile = (fact: string, on: PromptState['on']): boolean =>
  butlerLinesGained({ on, facts: [] }, { on, facts: [fact] }).length > 0

export const pluginsChangedNews = (
  now: readonly { name: string; on: boolean }[],
  lines: readonly string[] = []
): string =>
  composePrompt('butler-plugins-changed', {
    values: {
      'plugins-now': now.map(({ name, on }) => `${name} is now ${on ? 'on' : 'off'}`).join(', '),
      'lines-gained':
        lines.length > 0
          ? composePrompt('butler-lines-gained', { values: { lines: lines.join('') } })
          : ''
    }
  })

export const linesCameNews = (lines: readonly string[]): string =>
  composePrompt('butler-lines-came', { values: { lines: lines.join('') } })

export const GUIDE_MOVED_NEWS: OldConversationNews = {
  knownBy: 'knowsItsOwnLines',
  text: () => composePrompt('butler-guide-moved'),
  on: () => true
}

export const helperRoleOf = (butler: ButlerSetting): string =>
  butlerHelperRole(butler.name, instructionsOf(butler))
